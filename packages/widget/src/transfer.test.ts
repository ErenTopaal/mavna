import { RpcClient } from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";
import type { Address, Hash } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESTINATION,
  delivered,
  failed,
  layerZeroSend,
  pending,
  routeFor,
  ScriptedAdapter,
  SEND_HASH,
  STELLAR_USDC,
  STELLAR_XLM,
} from "./__fixtures__/scripted";
import { toRouteView } from "./quote";
import { createSponsorClient } from "./sponsor";
import { runTransfer, type TransferEngine } from "./transfer";
import type { Connection } from "./wallet";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const ARBITRUM_SEPOLIA = 421_614;
const HISTORY_KEY = "test.transfers";

/** Everything that crossed a boundary, in the order it crossed. */
let log: string[];
let stored: Map<string, string>;
let settleReplies: Array<[number, unknown]>;

beforeEach(() => {
  log = [];
  stored = new Map();
  settleReplies = [
    [200, { settled: false, settlementRetryable: true }],
    [200, { settled: true, settlementTxHash: "5e771e" }],
  ];

  // the sponsor, at the network boundary
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    log.push(`sponsor ${path}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    switch (path) {
      case "/health":
        return reply(200, { ok: true });
      case "/settlement":
        return reply(200, { xdr: "SETTLEMENT", channel: "GCHANNEL" });
      case "/settlement/commit":
        expect(JSON.parse(String(init?.body))).toEqual({
          destination: DESTINATION,
          signedXdr: "signed SETTLEMENT",
        });
        return reply(200, { held: true });
      case "/prepare":
        return reply(200, { xdr: "PREPARATION", sponsor: "GSPONSOR" });
      case "/submit":
        expect(JSON.parse(String(init?.body))).toEqual({ signedXdr: "signed PREPARATION" });
        return reply(200, { txHash: "9e9", ledger: 1 });
      case "/settle": {
        const next = settleReplies.length > 1 ? settleReplies.shift() : settleReplies[0];
        if (next === undefined) throw new Error("no settle reply scripted");
        return reply(next[0], next[1]);
      }
      default:
        throw new Error(`nothing answers ${path}`);
    }
  });

  // the browser's storage, so the history write can be seen
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        log.push(`history ${JSON.parse(value)[0].sourceTxHash}`);
        stored.set(key, value);
      },
      removeItem: (key: string) => stored.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function engineWith(adapter: ScriptedAdapter): TransferEngine {
  return {
    network: "testnet",
    adapters: [adapter],
    sponsor: createSponsorClient("https://sponsor.test"),
    // the stellar wallet, at its signing boundary
    stellar: {
      connect: async () => {
        log.push("stellar connect");
        return DESTINATION;
      },
      sign: async (xdr: string) => {
        log.push(`stellar sign ${xdr}`);
        return `signed ${xdr}`;
      },
      disconnect: async () => {},
    },
    historyKey: HISTORY_KEY,
    sourceDomain: () => 3,
    sdex: new SdexProvider("testnet"),
    rpc: new RpcClient({ url: "https://soroban-testnet.stellar.org" }),
    usdcOnStellar: STELLAR_USDC,
  };
}

/** The EVM wallet, at its boundary: it signs, the node answers. */
function connection(options: { reject?: boolean } = {}): Connection {
  return {
    address: SENDER,
    chainId: ARBITRUM_SEPOLIA,
    wallet: {
      writeContract: async (call: { functionName: string; value?: bigint }) => {
        log.push(`evm ${call.functionName} value=${String(call.value)}`);
        if (options.reject === true) throw Object.assign(new Error("denied"), { code: 4001 });
        return SEND_HASH as Hash;
      },
    },
    reader: {
      getBalance: async () => 10n ** 18n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
  } as unknown as Connection;
}

function patches() {
  const seen: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    seen,
    patch: (id: string, patch: Record<string, unknown>) => {
      seen.push({ id, patch });
      if (id === "deliver" && patch.phase !== undefined) log.push(`deliver ${patch.phase}`);
    },
  };
}

const instant = async (): Promise<void> => {};

function run(
  adapter: ScriptedAdapter,
  route: ReturnType<typeof routeFor>,
  patch: ReturnType<typeof patches>["patch"],
  conn = connection(),
) {
  return runTransfer({
    engine: engineWith(adapter),
    view: toRouteView(route),
    chainId: "arbitrum-sepolia",
    chainName: "Arbitrum Sepolia",
    evmChainId: ARBITRUM_SEPOLIA,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    connection: conn,
    wanted: "USDC",
    patch,
    onEvmEvent: () => {},
    wait: instant,
  });
}

describe("runTransfer over a relayed rail", () => {
  it("settles, prepares, sends, records, tracks and then settles the account, in that order", async () => {
    const adapter = new ScriptedAdapter("layerzero", [pending(), pending(), delivered("f00d")], {
      transactions: [layerZeroSend("777")],
      onStatus: () => log.push("status"),
    });
    const { seen, patch } = patches();

    await run(adapter, routeFor("layerzero", { newAccount: true }), patch);

    expect(log).toEqual([
      "sponsor /health",
      "stellar connect",
      "sponsor /settlement",
      "stellar sign SETTLEMENT",
      "sponsor /settlement/commit",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "evm send value=777",
      `history ${SEND_HASH}`,
      "deliver pending",
      "status",
      "status",
      "status",
      "deliver done",
      "sponsor /settle",
      "sponsor /settle",
    ]);
    expect(adapter.asked[0]).toEqual({
      sourceTxHash: SEND_HASH,
      depositAddress: undefined,
      destinationAddress: DESTINATION,
      sourceChainId: "arbitrum-sepolia",
    });
    // the only transaction is the send, so it drives the send step, not an approval
    expect(seen.filter((p) => p.id === "approve")).toEqual([]);
    expect(seen).toContainEqual({ id: "burn", patch: { phase: "done" } });
    expect(seen.at(-1)).toEqual({
      id: "deliver",
      patch: { note: "Delivered, and the deposit repaid itself from the arrival." },
    });
  });

  it("leaves an unsettled repayment as a note once the funds have arrived", async () => {
    settleReplies = [[200, { settled: false, settlementRetryable: true }]];
    const adapter = new ScriptedAdapter("axelar", [delivered()], {
      transactions: [layerZeroSend("1")],
    });
    const { seen, patch } = patches();

    await expect(
      run(adapter, routeFor("axelar", { newAccount: true }), patch),
    ).resolves.toBeUndefined();

    expect(log.filter((l) => l === "sponsor /settle").length).toBeGreaterThan(1);
    expect(seen.at(-1)?.patch.note).toMatch(/^Delivered on Stellar\. .*not gone through yet/);
  });

  it("does not touch the sponsor for an account that can already receive", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await run(adapter, routeFor("layerzero"), patches().patch);
    expect(log.filter((l) => l.startsWith("sponsor") || l.startsWith("stellar"))).toEqual([]);
  });

  it("refuses a new account the sponsor cannot settle in what the rail delivers, before any signature", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const route = routeFor("layerzero", { newAccount: true, delivers: STELLAR_XLM });

    await expect(run(adapter, route, patches().patch)).rejects.toThrow(/Nothing has been sent/);
    expect(log).toEqual([]);
    expect(adapter.built).toBe(0);
  });

  it("fails with the rail's reason when delivery fails, and keeps the send in history", async () => {
    const adapter = new ScriptedAdapter(
      "axelar",
      [pending(), failed("Axelar could not deliver this transfer.")],
      { transactions: [layerZeroSend("1")] },
    );
    await expect(run(adapter, routeFor("axelar"), patches().patch)).rejects.toThrow(
      "Axelar could not deliver this transfer.",
    );
    expect(stored.get(HISTORY_KEY)).toContain(SEND_HASH);
  });

  it("says plainly that a declined single send moved nothing", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero"), patches().patch, connection({ reject: true })),
    ).rejects.toThrow("You did not confirm the transfer, so nothing was sent.");
  });
});
