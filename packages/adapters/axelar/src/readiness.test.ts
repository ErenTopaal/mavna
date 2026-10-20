import { fileURLToPath } from "node:url";
import {
  type Asset,
  MavnaError,
  type QuoteRequest,
  type Route,
  type RouteRejection,
  type StepPhase,
  type TransferHandle,
} from "@mavna/core";
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
import { hideBufferFrom } from "./__fixtures__/no-buffer.js";
import { SELECTORS } from "./abi.js";
import { AxelarAdapter } from "./adapter.js";
import { forgetItsAssets } from "./assets.js";
import { forgetChains } from "./deployments.js";
import { DEPLOYMENTS_COMMIT } from "./pinned.js";
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
const CONFIG_URL = `https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${DEPLOYMENTS_COMMIT}/axelar-chains-config/info/testnet.json`;
const GMP = "https://testnet.api.gmp.axelarscan.io";
const ASSETS_URL = "https://testnet.api.axelarscan.io/api/getITSAssets";
const HORIZON = "https://horizon.test";

const STELLAR_ID = "stellar-2026-q1-2";
const SOURCE_SERVICE = "0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c";
const SOURCE_TOKEN = "0xa813265d59c9bc06e439e61fa133b5f23134b2ce";
const TOKEN_MANAGER_ADDRESS = "0x2222222222222222222222222222222222222222";
const TOKEN_ID = `0x${"0a".repeat(32)}`;
// the testnet Stellar token service confirmed in pinned.ts
const STELLAR_SERVICE = "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP";

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
  /** What `symbol()` answers. */
  symbol: string;
  account: boolean;
  trustline: boolean;
  /** The trustline's limit, when a test makes it tight. */
  trustlineLimit?: bigint;
  latestLedger: number;
}

let ledger: Ledger;
let asked: string[];

/** How the sending chain answers, for the cases that turn on it. */
interface SendingChain {
  managerType: number;
  /** What the service says is registered under the token id. */
  registered: string;
  /** What the token manager says it moves. */
  managed: string;
  /** Whether Stellar's service trusts the sending chain. */
  stellarTrusts: boolean;
  /** A node too busy to answer the token manager read. */
  busy: boolean;
  /** What the token manager read throws instead, when a test makes it fail another way. */
  fault?: Error;
  /** The gas service the token service names on-chain. */
  gasService: string;
}
let sending: SendingChain;

/** The sending chain's gas decimals as Axelar's config states them, and as its estimator prices. */
let configDecimals: number;
let estimatorDecimals: number;

/** Axelar's published token list, as getITSAssets returns it. */
let itsAssets: unknown[];

/** Axelar's message search: the leg found by hash, and the leg found from it. */
let gmp: { first: unknown[]; second: unknown[] };

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");

/** The sending chain's node: answers each read the resolution makes. */
async function ethCall(_rpcUrl: string, to: string, data: string): Promise<string> {
  const selector = data.slice(0, 10);
  const target = to.toLowerCase();
  if (selector === SELECTORS.interchainTokenId && target === SOURCE_TOKEN) {
    return `0x${word(TOKEN_ID)}`;
  }
  if (selector === SELECTORS.registeredTokenAddress && target === SOURCE_SERVICE) {
    return `0x${word(sending.registered)}`;
  }
  if (selector === SELECTORS.deployedTokenManager && target === SOURCE_SERVICE) {
    if (sending.busy) {
      throw new MavnaError("An EVM node could not answer: server busy", { retryable: true });
    }
    if (sending.fault !== undefined) throw sending.fault;
    return `0x${word(TOKEN_MANAGER_ADDRESS)}`;
  }
  if (selector === SELECTORS.getImplementationTypeAndTokenAddress) {
    return `0x${word(sending.managerType.toString(16))}${word(sending.managed)}`;
  }
  // gasService(), asked of the token service to cross-check the configuration
  if (selector === "0x6a22d8cc" && target === SOURCE_SERVICE) {
    return `0x${word(sending.gasService)}`;
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
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
            decimals: configDecimals,
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
      return json({
        baseFee: "5661583247892",
        executionFee: "0",
        totalFee: "5661583247892",
        // as the live estimator answers with showDetailedFees: what it priced in
        apiResponse: {
          result: { source_token: { symbol: "ETH", decimals: estimatorDecimals } },
        },
      });
    }
    if (url === `${GMP}/estimateITSFee`) return json(10543325497105);
    if (url === ASSETS_URL) return json(itsAssets);
    if (url === `${GMP}/searchGMP`) {
      const query = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return json({ data: query.messageId === undefined ? gmp.first : gmp.second });
    }
    if (url.startsWith(`${HORIZON}/order_book`)) {
      asked.push("horizon order book");
      // 0.2 USDC per XLM both ways, so one USDC is five XLM.
      return json({
        bids: [{ price: "0.2", amount: "1000" }],
        asks: [{ price: "0.2", amount: "5000" }],
      });
    }
    throw new Error(`the fetch double has no answer for ${url}`);
  });
}

function contractInstance(executable: Executable): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(ledger.token).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
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
    const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
    const method = call.functionName.toString();
    const target = Address.fromScAddress(call.contractAddress).toString();
    asked.push(`simulate ${method}`);
    const answer = (value: xdr.ScVal) => ({ result: { retval: value }, latestLedger: 100 });
    if (target === STELLAR_SERVICE && method === "is_trusted_chain") {
      return answer(nativeToScVal(sending.stellarTrusts)) as never;
    }
    if (target === STELLAR_SERVICE && method === "registered_token_address") {
      return answer(new Address(ledger.token).toScVal()) as never;
    }
    if (target === ledger.token && method === "decimals") {
      return answer(nativeToScVal(7, { type: "u32" })) as never;
    }
    if (target === ledger.token && method === "symbol") {
      return answer(nativeToScVal(ledger.symbol, { type: "string" })) as never;
    }
    if (target === ledger.token && method === "name") {
      return answer(nativeToScVal(ledger.name, { type: "string" })) as never;
    }
    throw new Error(`the Stellar double has no answer for ${method} on ${target}`);
  });

  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => {
    const entries: unknown[] = [];
    for (const key of keys) {
      const kind = key.type;
      asked.push(`ledger ${kind}`);
      if (kind === "contractData") {
        entries.push({ key, val: contractInstance(ledger.executable) });
      }
      if (key.type === "account" && ledger.account) {
        entries.push({
          key,
          val: xdr.LedgerEntryData.account(
            new xdr.AccountEntry({
              accountId: key.account.accountId,
              balance: 50_000_000n,
              seqNum: 1n,
              numSubEntries: 0,
              inflationDest: null,
              flags: 0,
              homeDomain: "",
              thresholds: new Uint8Array([1, 0, 0, 0]),
              signers: [],
              ext: xdr.AccountEntryExt.v0(),
            }),
          ),
        });
      }
      if (key.type === "trustline" && ledger.trustline) {
        entries.push({
          key,
          val: xdr.LedgerEntryData.trustline(
            new xdr.TrustLineEntry({
              accountId: key.trustLine.accountId,
              asset: key.trustLine.asset,
              balance: 0n,
              limit: ledger.trustlineLimit ?? 10n ** 15n,
              flags: 1,
              ext: xdr.TrustLineEntryExt.v0(),
            }),
          ),
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
    ethChainId: async () => 84532,
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
    symbol: "USDC",
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
    symbol: "IXE",
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
  sending = {
    managerType: TOKEN_MANAGER.nativeInterchainToken,
    registered: SOURCE_TOKEN,
    managed: SOURCE_TOKEN,
    stellarTrusts: true,
    busy: false,
    gasService: "0xbe406f0189a0b4cf3a05c286473d23791dd44cc6",
  };
  gmp = { first: [], second: [] };
  itsAssets = [];
  configDecimals = 18;
  estimatorDecimals = 18;
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

  it("does not take a Soroban token's word that it is Circle's USDC", async () => {
    // Anyone can deploy a contract whose name() answers CODE:ISSUER. Only the
    // ledger's executable decides, so this is labelled by its own contract id.
    interchainToken({ name: USDC_ID });

    const asked = await adapter().quote(ask({ to: stellarUsdc }));
    expect(isRoute(asked)).toBe(false);
    expect((asked as RouteRejection).reason).toBe("asset-unsupported");
    expect((asked as RouteRejection).explanation).toContain(INTERCHAIN_TOKEN);

    const route = routeOf(await adapter().quote(ask({ to: stellarInterchain })));
    expect(route.deliveredAtLeast.asset.id).toBe(INTERCHAIN_TOKEN);
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

  it("declines an account whose trustline has no room for what arrives", async () => {
    classicUsdc();
    ledger.trustlineLimit = 50_000_000n;
    const result = await adapter().quote(ask());
    expect(result).toMatchObject({ reason: "destination-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/room for only 5 USDC/);
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
      ethChainId: async () => 84532,
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

describe("without Node's Buffer, as in a browser", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = hideBufferFrom(fileURLToPath(new URL(".", import.meta.url)));
  });
  afterEach(() => restore());

  it("quotes and builds a transfer", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));
    const built = await adapter().buildTransactions(route);

    const transfer = JSON.parse(built[built.length - 1]?.payload ?? "{}");
    expect(transfer.functionName).toBe("interchainTransfer");
    // the destination is the strkey's own letters, hex encoded
    expect(transfer.args[2]).toBe(
      `0x${Array.from(new TextEncoder().encode(ACCOUNT), (b) => b.toString(16)).join("")}`,
    );
  });
});

const SOURCE_TX = `0x${"5a".repeat(32)}`;
const HUB_MESSAGE = "0xa3c714839a6814145b0c435153bda79c5e857f55c40d61dadc25ab832949f29b-340460371";
const SENDER = "0xf8d2a61c3809e7cc051b8036aeada06b65c2f9e7";
const GAS_SERVICE = "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6";
const OTHER_TOKEN = "0x3333333333333333333333333333333333333333";

const HANDLE: TransferHandle = {
  sourceTxHash: SOURCE_TX,
  depositAddress: undefined,
  destinationAddress: undefined,
  sourceChainId: "base-sepolia",
};

/** The sending chain reaching the hub, shaped as Axelar's search returns it. */
function firstLeg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: `${SOURCE_TX}-4`,
    status: "executed",
    call: { chain: "base-sepolia", transactionHash: SOURCE_TX, logIndex: 125, eventIndex: 4 },
    callback: { id: HUB_MESSAGE },
    interchain_transfer: {
      sourceAddress: SENDER,
      destinationChain: STELLAR_ID,
      amount: "10000000",
      decimals: 6,
      symbol: "USDC",
      tokenId: TOKEN_ID,
    },
    ...over,
  };
}

/** The hub reaching Stellar. Its token id comes back without a prefix. */
function secondLeg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: HUB_MESSAGE,
    status: "executed",
    call: { chain: "axelar" },
    interchain_transfer: {
      destinationChain: STELLAR_ID,
      amount: "100000000",
      decimals: 7,
      symbol: "USDC",
      tokenId: TOKEN_ID.slice(2),
    },
    ...over,
  };
}

describe("where an Axelar transfer stands, over both legs", () => {
  const status = (): Promise<StepPhase> => adapter().status(HANDLE);

  it("is pending while Axelar has not indexed the hash", async () => {
    expect((await status()).phase).toBe("pending");
  });

  it("is stalled with a top-up when the first leg was underpaid", async () => {
    gmp.first = [firstLeg({ status: "confirmed", is_insufficient_fee: true })];
    const phase = await status();
    expect(phase.phase).toBe("stalled");
    if (phase.phase === "stalled") expect(phase.remedy?.kind).toBe("add-gas");
  });

  it("has failed when the first leg errored", async () => {
    gmp.first = [firstLeg({ status: "error" })];
    expect((await status()).phase).toBe("failed");
  });

  it("is pending while the first leg moves, and after it with no second leg yet", async () => {
    gmp.first = [firstLeg({ status: "approved" })];
    expect((await status()).phase).toBe("pending");
    gmp.first = [firstLeg({ callback: undefined })];
    expect((await status()).phase).toBe("pending");
    gmp.first = [firstLeg()];
    expect((await status()).phase).toBe("pending");
    gmp.second = [secondLeg({ status: "executing" })];
    expect((await status()).phase).toBe("pending");
  });

  it("is stalled with a top-up on the sending chain when the second leg was underpaid", async () => {
    gmp.first = [firstLeg()];
    gmp.second = [secondLeg({ status: "approved", not_enough_gas_to_execute: true })];
    const phase = await status();
    expect(phase.phase).toBe("stalled");
    if (phase.phase === "stalled") {
      expect(phase.remedy?.kind).toBe("add-gas");
      if (phase.remedy?.kind === "add-gas") expect(phase.remedy.chainId).toBe("base-sepolia");
    }
  });

  it("has failed when the second leg errored", async () => {
    gmp.first = [firstLeg()];
    gmp.second = [secondLeg({ status: "error" })];
    expect((await status()).phase).toBe("failed");
  });

  it("stays pending while Axelar has not named the Stellar transaction that delivered it", async () => {
    // what arrived is read from that transaction (delivered.test.ts replays two
    // real ones), so without it there is nothing to report done from
    gmp.first = [firstLeg()];
    gmp.second = [secondLeg()];
    expect((await status()).phase).toBe("pending");
  });
});

describe("adding gas to a stuck Axelar transfer", () => {
  const recover = () => adapter().recover(HANDLE);

  it("waits for Axelar to index the transfer", async () => {
    const failure = await recover().catch((cause: unknown) => cause);
    expect((failure as MavnaError).retryable).toBe(true);
  });

  it("refuses a transfer neither of whose legs is underpaid", async () => {
    gmp.first = [firstLeg()];
    gmp.second = [secondLeg({ status: "executing" })];
    await expect(recover()).rejects.toThrow(/not underpaid/);
  });

  it("refuses without the first leg's log index, since a wrong one is spent for nothing", async () => {
    gmp.first = [firstLeg({ is_insufficient_fee: true, call: { chain: "base-sepolia" } })];
    await expect(recover()).rejects.toThrow(/log index/);
  });

  it("asks for a refund address when Axelar's record names no sender", async () => {
    gmp.first = [
      firstLeg({
        is_insufficient_fee: true,
        interchain_transfer: { destinationChain: STELLAR_ID },
      }),
    ];
    await expect(recover()).rejects.toThrow(/address/);
    const [paid] = await adapter().recover(HANDLE, { refundAddress: SENDER });
    expect(JSON.parse(paid?.payload ?? "{}").args[2]).toBe(SENDER);
  });

  it("tops up an underpaid second leg on the sending chain against the first leg's event", async () => {
    gmp.first = [firstLeg()];
    gmp.second = [secondLeg({ status: "approved", not_enough_gas_to_execute: true })];
    const [paid] = await recover();
    const call = JSON.parse(paid?.payload ?? "{}");

    expect(paid?.chainId).toBe("base-sepolia");
    expect(call.to).toBe(GAS_SERVICE);
    expect(call.functionName).toBe("addNativeGas");
    expect(call.args).toEqual([SOURCE_TX, "125", SENDER]);
    // the larger of the two estimates, which is the full current price
    expect(call.value).toBe("10543325497105");
  });
});

describe("building an Axelar transfer", () => {
  it("sends only the transfer for a token the service mints and burns itself", async () => {
    classicUsdc();
    const built = await adapter().buildTransactions(routeOf(await adapter().quote(ask())));
    expect(built.map((tx) => JSON.parse(tx.payload).functionName)).toEqual(["interchainTransfer"]);
  });

  it("asks for an exact approval to the token service where the service pulls the tokens", async () => {
    classicUsdc();
    for (const type of [
      TOKEN_MANAGER.mintBurnFrom,
      TOKEN_MANAGER.lockUnlock,
      TOKEN_MANAGER.lockUnlockFee,
    ]) {
      sending.managerType = type;
      const route = routeOf(await adapter().quote(ask()));
      const built = await adapter().buildTransactions(route);
      const approval = JSON.parse(built[0]?.payload ?? "{}");
      expect(built.length, String(type)).toBe(2);
      expect(approval.functionName).toBe("approve");
      expect(approval.args[0].toLowerCase()).toBe(SOURCE_SERVICE);
      expect(approval.args[1]).toBe(route.sends.baseUnits);
    }
  });

  it("re-checks trust at build and refuses when Stellar has stopped trusting the chain", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));
    sending.stellarTrusts = false;
    await expect(adapter().buildTransactions(route)).rejects.toThrow(/not currently carrying/);
  });

  it("refuses a route another rail quoted", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));
    await expect(adapter().buildTransactions({ ...route, source: "cctp" })).rejects.toThrow(
      /another rail/,
    );
  });

  it("refuses when the token would now land as a different Stellar asset than quoted", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));
    interchainToken();
    await expect(adapter().buildTransactions(route)).rejects.toThrow(/quoted/);
  });
});

describe("what the sending chain says about the token", () => {
  it("declines when the service has another token under the id", async () => {
    classicUsdc();
    sending.registered = OTHER_TOKEN;
    const result = await adapter().quote(ask());
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
  });

  it("declines when the token manager moves another token", async () => {
    classicUsdc();
    sending.managed = OTHER_TOKEN;
    const result = await adapter().quote(ask());
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
  });

  it.each([
    ["a fault in this code", new ReferenceError("Buffer is not defined"), false],
    [
      "a permanent refusal",
      new MavnaError("The token manager answered something unreadable.", { retryable: false }),
      false,
    ],
    ["a request the browser could not send", new TypeError("Failed to fetch"), true],
  ] as const)(
    "says what actually went wrong on %s, not that it timed out",
    async (_what, fault, retry) => {
      classicUsdc();
      sending.fault = fault;
      const result = (await adapter().quote(ask())) as RouteRejection;
      expect(result.explanation).not.toMatch(/did not answer in time/);
      expect(result.retryable).toBe(retry);
      if (retry) {
        expect(result.reason).toBe("temporarily-unavailable");
      } else {
        expect(result.reason).toBe("errored");
        expect(result.explanation).toContain(fault.message);
      }
    },
  );

  it("says a busy node is a retry, not an unsupported token", async () => {
    classicUsdc();
    sending.busy = true;
    const result = await adapter().quote(ask());
    expect((result as RouteRejection).reason).toBe("temporarily-unavailable");
  });
});

describe("the delivery fee's unit", () => {
  it("is the unit Axelar priced it in, not the one its config states", async () => {
    // Hedera on mainnet: the config says HBAR has 8 decimals, the estimator
    // prices in 18 (source_token HBAR/18, 208620852046237300 for 0.21 HBAR)
    classicUsdc();
    configDecimals = 8;
    estimatorDecimals = 18;
    const route = routeOf(await adapter().quote(ask()));
    const gas = route.fees.find((fee) => fee.kind === "gas");
    expect(gas?.total.asset.decimals).toBe(18);
    expect(gas?.total.asset.symbol).toBe("ETH");
  });

  it("declines when the estimator does not say what it priced in", async () => {
    classicUsdc();
    estimatorDecimals = Number.NaN;
    const result = await adapter().quote(ask());
    expect(isRoute(result)).toBe(false);
  });
});

describe("the token service's own word on its gas service", () => {
  it("declines to quote when it names a gas service other than the confirmed one", async () => {
    classicUsdc();
    sending.gasService = "0x00000000000000000000000000000000deadbeef";
    const result = await adapter().quote(ask());
    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("chain-unsupported");
  });

  it("refuses to build when it names a gas service other than the confirmed one", async () => {
    classicUsdc();
    const route = routeOf(await adapter().quote(ask()));
    sending.gasService = "0x00000000000000000000000000000000deadbeef";
    await expect(adapter().buildTransactions(route)).rejects.toThrow(/gas service/);
  });
});

describe("what an Axelar interchain token is called", () => {
  // Mainnet: Ethereum's USDC reaches Stellar as CDPV3H7C...QTMW, a Soroban
  // contract whose own symbol() says USDC. Axelar's token list calls it USDC.axl.
  const askedAsUsdc: Asset = { ...stellarInterchain, symbol: "USDC", curatedBy: "Circle" };

  it("takes Axelar's name for it, not the caller's, and never Circle's", async () => {
    interchainToken({ symbol: "USDC", name: "USD Coin" });
    itsAssets = [
      {
        id: TOKEN_ID.slice(2),
        symbol: "USDC.axl",
        name: "USD Coin",
        decimals: 6,
        chains: { "base-sepolia": { tokenAddress: SOURCE_TOKEN } },
      },
    ];
    const route = routeOf(await adapter().quote(ask({ to: askedAsUsdc })));
    for (const amount of [route.receives, route.receivesAtLeast, route.deliveredAtLeast]) {
      expect(amount.asset.id).toBe(INTERCHAIN_TOKEN);
      expect(amount.asset.symbol).toBe("USDC.axl");
      expect(amount.asset.curatedBy).toBe("Axelar");
    }
  });

  it("uses the contract's own symbol when Axelar's list does not carry the token", async () => {
    interchainToken();
    const route = routeOf(
      await adapter().quote(ask({ to: { ...stellarInterchain, symbol: "X" } })),
    );
    expect(route.receives.asset.symbol).toBe("IXE");
  });

  it("declines an unlisted contract token that calls itself USDC", async () => {
    interchainToken({ symbol: "USDC", name: "USD Coin" });
    const result = await adapter().quote(ask({ to: askedAsUsdc }));
    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
  });
});
