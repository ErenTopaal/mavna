import type { Asset, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { RpcClient, XlmPriceSource } from "@mavna/stellar";
import {
  Address,
  Networks,
  nativeToScVal,
  Asset as StellarAsset,
  StrKey,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELECTORS } from "./abi.js";
import { AxelarAdapter } from "./adapter.js";
import { forgetItsAssets } from "./assets.js";
import { forgetChains } from "./deployments.js";
import { TOKEN_MANAGER } from "./token.js";

/**
 * Where the quote checks the destination, and what it calls the asset that lands.
 *
 * Every remote answer is held still at its boundary: Axelar's HTTP APIs and
 * Horizon through fetch, the EVM node through the injectable eth_call, and the
 * Stellar node through the RpcClient's server. The adapter, the token
 * resolution, the destination inspection and the reserve arithmetic above them
 * are the real code.
 */

const CHAINS_URL = "https://testnet.api.axelarscan.io/api/getChains";
const CONFIG_URL =
  "https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/main/axelar-chains-config/info/testnet.json";
const GMP = "https://testnet.api.gmp.axelarscan.io";
const HORIZON = "https://horizon.test";

const STELLAR_ID = "stellar-2026-q1-2";
const SOURCE_SERVICE = "0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c";
const SOURCE_TOKEN = "0xa813265d59c9bc06e439e61fa133b5f23134b2ce";
const TOKEN_MANAGER_ADDRESS = "0x2222222222222222222222222222222222222222";
const TOKEN_ID = `0x${"0a".repeat(32)}`;
const STELLAR_SERVICE = StrKey.encodeContract(Buffer.alloc(32, 7));

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ID = `USDC:${USDC_ISSUER}`;
const USDC_SAC = new StellarAsset("USDC", USDC_ISSUER).contractId(Networks.TESTNET);
/** An Axelar interchain token: a Soroban contract with its own balances, no trustline. */
const INTERCHAIN_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));

const ACCOUNT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
const CONTRACT_DESTINATION = StrKey.encodeContract(Buffer.alloc(32, 3));
const BASE_RESERVE = 5_000_000;

type Executable = "stellar-asset" | "wasm";

interface Ledger {
  /** The Stellar token the service names for this token id. */
  token: string;
  executable: Executable;
  /** What `name()` answers, for a Stellar asset contract. */
  name: string;
  account: boolean;
  trustline: boolean;
  latestLedger: number;
}

let ledger: Ledger;
let asked: string[];

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");

/** The sending chain's node: answers each read the resolution makes. */
async function ethCall(_rpcUrl: string, to: string, data: string): Promise<string> {
  const selector = data.slice(0, 10);
  const target = to.toLowerCase();
  if (selector === SELECTORS.interchainTokenId && target === SOURCE_TOKEN) {
    return `0x${word(TOKEN_ID)}`;
  }
  if (selector === SELECTORS.registeredTokenAddress && target === SOURCE_SERVICE) {
    return `0x${word(SOURCE_TOKEN)}`;
  }
  if (selector === SELECTORS.deployedTokenManager && target === SOURCE_SERVICE) {
    return `0x${word(TOKEN_MANAGER_ADDRESS)}`;
  }
  if (selector === SELECTORS.getImplementationTypeAndTokenAddress) {
    return `0x${word(TOKEN_MANAGER.nativeInterchainToken.toString(16))}${word(SOURCE_TOKEN)}`;
  }
  if (selector === SELECTORS.isTrustedChain && target === SOURCE_SERVICE) {
    return `0x${word("1")}`;
  }
  if (selector === SELECTORS.decimals && target === SOURCE_TOKEN) {
    return `0x${word("6")}`;
  }
  throw new Error(`the EVM double has no answer for ${selector} on ${to}`);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Axelar's APIs and Horizon, as they answer on testnet. */
function remoteServices(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === CHAINS_URL) {
      return json([
        { id: "base-sepolia", chain_type: "evm" },
        { id: STELLAR_ID, chain_type: "vm", gateway: { address: "CDEPLOYEDGATEWAY" } },
      ]);
    }
    if (url === CONFIG_URL) {
      return json({
        chains: {
          "base-sepolia": {
            name: "Base Sepolia",
            axelarId: "base-sepolia",
            chainId: 84532,
            chainType: "evm",
            rpc: "https://sepolia.base.org",
            tokenSymbol: "ETH",
            decimals: 18,
            contracts: {
              InterchainTokenService: { address: SOURCE_SERVICE },
              AxelarGasService: { address: "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6" },
            },
          },
          [STELLAR_ID]: {
            name: "Stellar",
            axelarId: STELLAR_ID,
            chainType: "stellar",
            tokenSymbol: "XLM",
            decimals: 7,
            contracts: { InterchainTokenService: { address: STELLAR_SERVICE } },
          },
        },
      });
    }
    if (url === `${GMP}/estimateGasFee`) {
      return json({ baseFee: "5661583247892", executionFee: "0", totalFee: "5661583247892" });
    }
    if (url === `${GMP}/estimateITSFee`) return json(10543325497105);
    if (url.startsWith(`${HORIZON}/order_book`)) {
      asked.push("horizon order book");
      // 0.2 USDC per XLM both ways, so one USDC is five XLM.
      return json({ bids: [{ price: "0.2" }], asks: [{ price: "0.2" }] });
    }
    throw new Error(`the fetch double has no answer for ${url}`);
  });
}

function contractInstance(executable: Executable): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(ledger.token).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable:
            executable === "stellar-asset"
              ? xdr.ContractExecutable.contractExecutableStellarAsset()
              : xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
          storage: null,
        }),
      ),
    }),
  );
}

/** A real client whose node is a double, reading whatever `ledger` says. */
function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://soroban.test",
    baseDelayMs: 0,
    sleep: async () => {},
  });

  vi.spyOn(client.server, "simulateTransaction").mockImplementation(async (tx) => {
    const op = (tx as Transaction).operations[0];
    if (op?.type !== "invokeHostFunction") throw new Error("not a contract call");
    const call = op.func.invokeContract();
    const method = call.functionName().toString();
    const target = Address.fromScAddress(call.contractAddress()).toString();
    asked.push(`simulate ${method}`);
    const answer = (value: xdr.ScVal) => ({ result: { retval: value }, latestLedger: 100 });
    if (target === STELLAR_SERVICE && method === "is_trusted_chain") {
      return answer(nativeToScVal(true)) as never;
    }
    if (target === STELLAR_SERVICE && method === "registered_token_address") {
      return answer(new Address(ledger.token).toScVal()) as never;
    }
    if (target === ledger.token && method === "decimals") {
      return answer(nativeToScVal(7, { type: "u32" })) as never;
    }
    if (target === ledger.token && method === "name") {
      return answer(nativeToScVal(ledger.name, { type: "string" })) as never;
    }
    throw new Error(`the Stellar double has no answer for ${method} on ${target}`);
  });

  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => {
    const entries: unknown[] = [];
    for (const key of keys) {
      const kind = key.switch().name;
      asked.push(`ledger ${kind}`);
      if (kind === "contractData") {
        entries.push({ key, val: contractInstance(ledger.executable) });
      }
      if (kind === "account" && ledger.account) {
        entries.push({
          key,
          val: {
            switch: () => ({ name: "account" }),
            account: () => ({ balance: () => 50_000_000n, numSubEntries: () => 0 }),
          },
        });
      }
      if (kind === "trustline" && ledger.trustline) {
        entries.push({
          key,
          val: {
            switch: () => ({ name: "trustline" }),
            trustLine: () => ({ balance: () => 0n, limit: () => 10n ** 15n, flags: () => 1 }),
          },
        });
      }
    }
    return { entries, latestLedger: ledger.latestLedger } as never;
  });

  return client;
}

function adapter(): AxelarAdapter {
  return new AxelarAdapter({
    network: "testnet",
    rpc: stellarNode(),
    baseReserveStroops: BASE_RESERVE,
    prices: new XlmPriceSource({ horizonUrl: HORIZON }),
    ethCall,
  });
}

const source: Asset = {
  chainId: "base-sepolia",
  id: SOURCE_TOKEN,
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Axelar",
};

const stellarUsdc: Asset = {
  chainId: "stellar-testnet",
  id: USDC_ID,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

const stellarInterchain: Asset = {
  chainId: "stellar-testnet",
  id: INTERCHAIN_TOKEN,
  symbol: "IXE",
  decimals: 7,
  curatedBy: "Axelar",
};

/** Ten whole tokens by default: fifty XLM of value, well over any floor. */
const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: source,
  to: stellarUsdc,
  sends: { asset: source, baseUnits: "10000000" },
  destination: ACCOUNT,
  maxSlippageBps: 50,
  ...over,
});

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

function routeOf(result: Route | RouteRejection): Route {
  if (!isRoute(result)) throw new Error(`declined: ${result.reason}: ${result.explanation}`);
  return result;
}

function classicUsdc(over: Partial<Ledger> = {}): void {
  ledger = {
    token: USDC_SAC,
    executable: "stellar-asset",
    name: USDC_ID,
    account: true,
    trustline: true,
    latestLedger: 100,
    ...over,
  };
}

function interchainToken(over: Partial<Ledger> = {}): void {
  ledger = {
    token: INTERCHAIN_TOKEN,
    executable: "wasm",
    name: "Interchain Escrow Token",
    account: true,
    trustline: false,
    latestLedger: 100,
    ...over,
  };
}

beforeEach(() => {
  forgetChains();
  forgetItsAssets();
  asked = [];
  remoteServices();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the asset an Axelar route says it delivers", () => {
  it("names a Stellar asset contract by the CODE:ISSUER it wraps", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));

    for (const amount of [route.receives, route.receivesAtLeast, route.deliveredAtLeast]) {
      expect(amount.asset.id).toBe(USDC_ID);
      expect(amount.asset.chainId).toBe("stellar-testnet");
      expect(amount.asset.decimals).toBe(7);
    }
    // six decimals on the way in, seven on the way out
    expect(route.receives.baseUnits).toBe("100000000");
  });

  it("names an interchain token by its contract id", async () => {
    interchainToken();
    const route = routeOf(await adapter().quote(ask({ to: stellarInterchain })));

    for (const amount of [route.receives, route.receivesAtLeast, route.deliveredAtLeast]) {
      expect(amount.asset.id).toBe(INTERCHAIN_TOKEN);
    }
  });

  it("declines when the request names a different Stellar asset than the one that lands", async () => {
    // Asking for Circle's USDC on a token that lands as Axelar's own contract
    // would quote one asset and deliver another.
    interchainToken();
    const result = await adapter().quote(ask({ to: stellarUsdc }));

    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
    expect((result as RouteRejection).explanation).toContain(INTERCHAIN_TOKEN);
  });

  it("refuses a Stellar asset contract whose name does not derive to its own address", async () => {
    classicUsdc({ name: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" });
    const result = await adapter().quote(ask());

    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
  });
});

describe("a classic asset, by destination lane", () => {
  it("plans nothing extra for an account that already holds it", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));

    expect(route.steps.map((step) => step.kind)).toEqual(["bridge"]);
    expect(route.signaturesRequired).toBe(1);
    expect(route.fees.some((fee) => fee.kind === "account-reserve")).toBe(false);
    // nothing is lent, so the market is not asked for a price
    expect(asked).not.toContain("horizon order book");
  });

  it("prepares a trustline for an account that cannot hold it yet", async () => {
    classicUsdc({ trustline: false });
    const route = routeOf(await adapter().quote(ask()));

    expect(route.steps.map((step) => step.kind)).toEqual([
      "prepare-account",
      "bridge",
      "settle-account",
    ]);
    expect(route.signaturesRequired).toBe(2);
    const reserve = route.fees.find((fee) => fee.kind === "account-reserve");
    expect(reserve?.total.baseUnits).toBe(String(BASE_RESERVE));
    expect(reserve?.total.asset.id).toBe("native");
  });

  it("prepares the account and the trustline when nothing exists", async () => {
    classicUsdc({ account: false, trustline: false });
    const route = routeOf(await adapter().quote(ask()));

    expect(route.steps.map((step) => step.kind)).toEqual([
      "prepare-account",
      "bridge",
      "settle-account",
    ]);
    const reserve = route.fees.find((fee) => fee.kind === "account-reserve");
    expect(reserve?.total.baseUnits).toBe(String(3 * BASE_RESERVE));
    expect(route.receives.asset.id).toBe(USDC_ID);
  });

  it("declines a new account when too little arrives to repay its reserve", async () => {
    // One USDC is five XLM, under the floor of four times the 1.5 XLM reserve.
    classicUsdc({ account: false, trustline: false });
    const result = await adapter().quote(ask({ sends: { asset: source, baseUnits: "1000000" } }));

    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("amount-too-small");
    expect((result as RouteRejection).explanation).toMatch(/at least 6 XLM/);
  });

  it("delivers to a contract with nothing to prepare", async () => {
    classicUsdc({ account: false, trustline: false });
    const route = routeOf(await adapter().quote(ask({ destination: CONTRACT_DESTINATION })));

    expect(route.steps.map((step) => step.kind)).toEqual(["bridge"]);
    expect(asked.filter((line) => line === "ledger account")).toEqual([]);
  });

  it("says a lagging node is a retry rather than a bad address", async () => {
    classicUsdc();
    const client = stellarNode();
    client.observeWrite(500);
    const instance = new AxelarAdapter({
      network: "testnet",
      rpc: client,
      baseReserveStroops: BASE_RESERVE,
      prices: new XlmPriceSource({ horizonUrl: HORIZON }),
      ethCall,
    });
    const result = await instance.quote(ask());

    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("temporarily-unavailable");
  });
});

describe("an interchain token, by destination lane", () => {
  it("needs nothing for an account that exists, since there is no trustline", async () => {
    interchainToken();
    const route = routeOf(await adapter().quote(ask({ to: stellarInterchain })));

    expect(route.steps.map((step) => step.kind)).toEqual(["bridge"]);
    expect(route.fees.some((fee) => fee.kind === "account-reserve")).toBe(false);
    expect(asked).not.toContain("ledger trustline");
  });

  it("declines an account that does not exist", async () => {
    interchainToken({ account: false });
    const result = await adapter().quote(ask({ to: stellarInterchain }));

    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("destination-unsupported");
    expect((result as RouteRejection).explanation).toMatch(/does not exist/);
  });

  it("delivers to a contract", async () => {
    interchainToken({ account: false });
    const route = routeOf(
      await adapter().quote(ask({ to: stellarInterchain, destination: CONTRACT_DESTINATION })),
    );
    expect(route.steps.map((step) => step.kind)).toEqual(["bridge"]);
  });
});
