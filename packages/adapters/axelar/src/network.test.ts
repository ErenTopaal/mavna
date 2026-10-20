import { MavnaError, type TransferHandle } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxelarAdapter } from "./adapter.js";
import { forgetItsAssets, loadItsAssets } from "./assets.js";
import { forgetChains, loadChains } from "./deployments.js";
import { discoverLiveChains } from "./discovery.js";
import { estimateGasFee, estimateItsFee, priceTransfer } from "./fees.js";

/**
 * The adapter's edges with Axelar's HTTP APIs, held still with a fetch double.
 *
 * Shapes follow what the live testnet endpoints returned on 2026-10-19. The
 * double sits at the network boundary only; everything above it is the real code.
 */

const CHAINS_URL = "https://testnet.api.axelarscan.io/api/getChains";
const CONFIG_URL =
  "https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/main/axelar-chains-config/info/testnet.json";
const GMP = "https://testnet.api.gmp.axelarscan.io";

const STELLAR_ID = "stellar-2026-q1-2";
const GAS_SERVICE = "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6";
const SOURCE_TX = "0x9a1c4f7f0d9f6e1c1f0b5a3c2d4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
const SENDER = "0x1111111111111111111111111111111111111111";

const HANDLE: TransferHandle = {
  sourceTxHash: SOURCE_TX,
  depositAddress: undefined,
  destinationAddress: undefined,
  sourceChainId: "base-sepolia",
};

const registryRows = [
  { id: "base-sepolia", chain_type: "evm" },
  { id: STELLAR_ID, chain_type: "vm", gateway: { address: "CDEPLOYEDGATEWAY" } },
];

const configBody = {
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
        InterchainTokenService: { address: "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C" },
        AxelarGasService: { address: GAS_SERVICE },
      },
    },
    [STELLAR_ID]: {
      name: "Stellar",
      axelarId: STELLAR_ID,
      chainType: "stellar",
      rpc: "https://soroban-testnet.stellar.org",
      tokenSymbol: "XLM",
      decimals: 7,
      contracts: {},
    },
  },
};

// The two estimator answers for base-sepolia to Stellar priced in ETH, as the
// live endpoints gave them.
const GAS_FEE_ETH = {
  baseFee: "5661583247892",
  executionFee: "0",
  totalFee: "5661583247892",
  apiResponse: { result: { source_token: { symbol: "ETH", decimals: 18 } } },
};
const ITS_FEE_ETH = 10543325497105;

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers each Axelar URL the way the live service does, and records what was asked. */
function axelarDouble(overrides: { chains?: () => Response } = {}) {
  const calls: Call[] = [];
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === CHAINS_URL) return overrides.chains?.() ?? json(registryRows);
    if (url === CONFIG_URL) return json(configBody);
    if (url === `${GMP}/estimateGasFee`) return json(GAS_FEE_ETH);
    if (url === `${GMP}/estimateITSFee`) return json(ITS_FEE_ETH);
    if (url === `${GMP}/searchGMP`) {
      return json({
        data: [
          {
            status: "confirmed",
            is_insufficient_fee: true,
            call: { chain: "base-sepolia", transactionHash: SOURCE_TX, logIndex: 7 },
            interchain_transfer: { sourceAddress: SENDER, destinationChain: STELLAR_ID },
          },
        ],
      });
    }
    throw new Error(`the double has no answer for ${url}`);
  });
  vi.stubGlobal("fetch", handler);
  return { calls, handler };
}

function adapter(): AxelarAdapter {
  return new AxelarAdapter({
    network: "testnet",
    rpc: new RpcClient({ url: "https://soroban-testnet.stellar.org" }),
    baseReserveStroops: 5_000_000,
  });
}

beforeEach(() => {
  forgetChains();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the currency Axelar is asked to price in", () => {
  it("asks both estimators for the sending chain's own token", async () => {
    const { calls } = axelarDouble();
    await priceTransfer("testnet", "base-sepolia", STELLAR_ID, "ETH");

    const priced = calls.filter((call) => call.url.startsWith(GMP));
    expect(priced.map((call) => call.url)).toEqual([
      `${GMP}/estimateGasFee`,
      `${GMP}/estimateITSFee`,
    ]);
    for (const call of priced) expect(call.body?.sourceTokenSymbol).toBe("ETH");
  });

  it("tops up an underpaid transfer in the currency its chain's config names", async () => {
    // The result is paid as msg.value on the sending chain, so the symbol must
    // be that chain's native token. Read from the deployment config, not typed in.
    const { calls } = axelarDouble();
    const [tx] = await adapter().recover(HANDLE);

    const priced = calls.filter(
      (call) => call.url.startsWith(GMP) && call.url.includes("estimate"),
    );
    expect(priced.length).toBe(2);
    for (const call of priced) expect(call.body?.sourceTokenSymbol).toBe("ETH");
    expect(JSON.parse(tx?.payload ?? "{}").value).toBe(String(ITS_FEE_ETH));
  });
});

describe("timeouts on Axelar's endpoints", () => {
  it("gives up after ten seconds and says so as retryable", async () => {
    // Shortens the real platform timer rather than waiting it out, and records
    // what the code asked for so the ten seconds is still what is checked.
    const original = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      return original(1);
    });
    vi.stubGlobal(
      "fetch",
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) return; // hangs, as a dead host does
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const failure = await estimateGasFee("testnet", "base-sepolia", STELLAR_ID, "ETH").catch(
      (cause: unknown) => cause,
    );
    expect(asked).toEqual([10_000]);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);

    const its = await estimateItsFee("testnet", "base-sepolia", STELLAR_ID, "ETH").catch(
      (cause: unknown) => cause,
    );
    expect(its).toBeInstanceOf(MavnaError);
    expect((its as MavnaError).retryable).toBe(true);
  });

  it("reports a host that cannot be reached as retryable rather than a raw TypeError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const failure = await adapter()
      .supportedChains()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
  });
});

describe("the chain registry, per adapter", () => {
  it("is fetched once however many times it is consulted", async () => {
    const { calls } = axelarDouble();
    const instance = adapter();
    await instance.supportedChains();
    await instance.supportedChains();
    await instance.recover(HANDLE);

    expect(calls.filter((call) => call.url === CHAINS_URL).length).toBe(1);
  });

  it("asks again after a failed read instead of remembering the failure", async () => {
    let failNext = true;
    const { calls } = axelarDouble({
      chains: () => {
        if (failNext) {
          failNext = false;
          return json({ message: "unavailable" }, 503);
        }
        return json(registryRows);
      },
    });
    const instance = adapter();
    await expect(instance.supportedChains()).rejects.toThrow(/503/);
    await expect(instance.supportedChains()).resolves.toEqual(["base-sepolia"]);
    expect(calls.filter((call) => call.url === CHAINS_URL).length).toBe(2);
  });
});

describe("a rate limited Axelar endpoint", () => {
  it("is a retry on every endpoint, not a permanent no", async () => {
    // a burst of estimator calls during the audit came back 23 of 40 as HTTP 429
    vi.stubGlobal("fetch", async () => json({ message: "Too Many Requests" }, 429));
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["deployments", () => loadChains("testnet")],
      ["assets", () => loadItsAssets("testnet")],
      ["chain registry", () => discoverLiveChains("testnet")],
      ["gas estimator", () => estimateGasFee("testnet", "base-sepolia", STELLAR_ID, "ETH")],
      ["its estimator", () => estimateItsFee("testnet", "base-sepolia", STELLAR_ID, "ETH")],
      ["message search", () => adapter().status(HANDLE)],
    ];
    for (const [name, attempt] of attempts) {
      forgetChains();
      forgetItsAssets();
      const failure = await attempt().catch((cause: unknown) => cause);
      expect(failure, name).toBeInstanceOf(MavnaError);
      expect((failure as MavnaError).retryable, name).toBe(true);
    }
  });
});
