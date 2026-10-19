import { CctpAdapter } from "@mavna/adapter-cctp";
import type { BridgeAdapter } from "@mavna/core";
import { createNetworkConfig, RpcClient } from "@mavna/stellar";
import { createSwapVenues } from "@mavna/swap";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
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
import { OWN_DELIVERY_FEE_BUDGET_STROOPS } from "./own-delivery";
import { toRouteView } from "./quote";
import { createSponsorClient } from "./sponsor";
import {
  finishDelivery,
  runTransfer,
  StillMoving,
  type TransferDeps,
  type TransferEngine,
} from "./transfer";
import type { Connection } from "./wallet";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const ARBITRUM_SEPOLIA = 421_614;
const HISTORY_KEY = "test.transfers";
/** A Stellar address other than the one the wallet connects. */
const SENDER_STELLAR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

/** Everything that crossed a boundary, in the order it crossed. */
let log: string[];
let stored: Map<string, string>;
let settleReplies: Array<[number, unknown]>;
let deliverReplies: Array<[number, unknown]>;
/** What the Stellar node says the destination holds. */
let lane: "ready" | "needs-account" | "needs-trustline";
/** Who the sponsor says pays a new account's reserve. */
let funding: "sponsor" | "self";
/** The self-funded preparation the sponsor last built. */
let preparation: string;
/** What a self-funded preparation opens and who sources it, when a test makes it wrong. */
let preparedLine: string | undefined;
let preparedSource: string | undefined;
/** What Circle's attestation service answers, in turn; the last one repeats. */
let irisReplies: Array<[number, unknown]>;
const attested = {
  messages: [{ status: "complete", message: "0x0102", attestation: "0x0304", decodedMessage: {} }],
};
/** The assets each /prepare asked for. */
let askedAssets: string[][];

const STELLAR_USDT0 = {
  ...STELLAR_USDC,
  id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  symbol: "USDT0",
  curatedBy: "LayerZero",
};

beforeEach(() => {
  log = [];
  lane = "ready";
  funding = "sponsor";
  preparation = "";
  preparedFee = "182612";
  simulationFailures = [];
  irisReplies = [[200, attested]];
  preparedLine = undefined;
  preparedSource = undefined;
  askedAssets = [];
  deliverReplies = [[200, { kind: "delivered", txHash: "d311", ledger: 9 }]];
  stored = new Map();
  settleReplies = [
    [200, { settled: false, settlementRetryable: true }],
    [200, { settled: true, settlementTxHash: "5e771e" }],
  ];

  // the sponsor, at the network boundary
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path.startsWith("/v2/messages/")) {
      log.push(`iris ${path}`);
      const next = irisReplies.length > 1 ? irisReplies.shift() : irisReplies[0];
      if (next === undefined) throw new Error("no iris reply scripted");
      return reply(next[0], next[1]);
    }
    log.push(`sponsor ${path}`);
    switch (path) {
      case "/health":
        return reply(200, {
          ok: true,
          network: "testnet",
          reserveFunding: funding,
          minDeliveryBaseUnits: "1000000",
        });
      case "/settlement":
        return reply(200, { xdr: "SETTLEMENT", channel: "GCHANNEL" });
      case "/settlement/commit":
        expect(bodyOf(init)).toEqual({
          destination: DESTINATION,
          signedXdr: "signed SETTLEMENT",
        });
        return reply(200, { held: true });
      case "/prepare": {
        const asked = bodyOf(init) as { assets: string[] };
        askedAssets.push(asked.assets);
        if (funding === "sponsor") return reply(200, { xdr: "PREPARATION", sponsor: "GSPONSOR" });
        // the real shape of a self-funded preparation: one changeTrust the account sources
        const [code] = asked.assets;
        const line = preparedLine ?? (code === "USDT0" ? STELLAR_USDT0.id : STELLAR_USDC.id);
        const [lineCode, lineIssuer] = line.split(":");
        preparation = new TransactionBuilder(new Account(preparedSource ?? DESTINATION, "1"), {
          fee: "1000",
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(Operation.changeTrust({ asset: new Asset(lineCode ?? "", lineIssuer) }))
          .setTimeout(300)
          .build()
          .toXDR();
        return reply(200, { xdr: preparation, selfFunded: true });
      }
      case "/submit":
        expect(bodyOf(init)).toEqual({
          signedXdr: `signed ${funding === "self" ? preparation : "PREPARATION"}`,
        });
        return reply(200, { txHash: "9e9", ledger: 1 });
      case "/deliver": {
        const next = deliverReplies.length > 1 ? deliverReplies.shift() : deliverReplies[0];
        if (next === undefined) throw new Error("no deliver reply scripted");
        return reply(next[0], next[1]);
      }
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

/** A request's JSON body; every sponsor call sends one as a string. */
function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("the request was sent without a JSON body");
  return JSON.parse(init.body);
}

/** Ledger entries the way the Stellar node returns them. */
function ledgerEntries(): unknown[] {
  const accountId = Keypair.fromPublicKey(DESTINATION).xdrAccountId();
  const account = {
    val: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId,
        balance: xdr.Int64.fromString("50000000"),
        seqNum: xdr.Int64.fromString("41"),
        numSubEntries: 1,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: new xdr.AccountEntryExt(0),
      }),
    ),
  };
  const [code, issuer] = STELLAR_USDC.id.split(":");
  const trustline = {
    val: xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId,
        asset: new Asset(code ?? "", issuer).toTrustLineXDRObject(),
        balance: xdr.Int64.fromString("0"),
        limit: xdr.Int64.fromString((10n ** 15n).toString()),
        flags: 1,
        ext: new xdr.TrustLineEntryExt(0),
      }),
    ),
  };
  if (lane === "needs-account") return [];
  if (lane === "needs-trustline") return [account];
  return [account, trustline];
}

/** What the delivery costs once simulated, as the node prepares it. */
let preparedFee: string;
/** What simulating the delivery answers instead, in turn, when a test makes it fail. */
let simulationFailures: Error[];

/**
 * A real client whose node is a double, so the destination check reads what a
 * test says and a delivery the account pays for can be simulated and sent.
 */
function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://example.invalid",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async () => {
    log.push("stellar read destination");
    return { entries: ledgerEntries(), latestLedger: 100 } as never;
  });
  vi.spyOn(client.server, "getLatestLedger").mockResolvedValue({ sequence: 100 } as never);
  vi.spyOn(client.server, "prepareTransaction").mockImplementation(async (tx) => {
    log.push("stellar simulate delivery");
    const failure = simulationFailures.shift();
    if (failure !== undefined) throw failure;
    return TransactionBuilder.cloneFrom(tx as never, { fee: preparedFee }).build() as never;
  });
  vi.spyOn(client.server, "sendTransaction").mockImplementation(async (tx) => {
    const op = (tx as { operations: Array<{ type: string; func?: unknown }> }).operations[0];
    log.push(`stellar send ${op?.type}`);
    return { status: "PENDING", hash: "0ae1" } as never;
  });
  vi.spyOn(client.server, "getTransaction").mockResolvedValue({
    status: "SUCCESS",
    txHash: "0ae1",
    ledger: 101,
    latestLedger: 101,
  } as never);
  return client;
}

function engineWith(adapter: BridgeAdapter): TransferEngine {
  const sponsor = createSponsorClient("https://sponsor.test");
  return {
    network: "testnet",
    adapters: [adapter],
    sponsor,
    sponsorTerms: () => sponsor.terms(),
    // the stellar wallet, at its signing boundary
    stellar: {
      connect: async () => {
        log.push("stellar connect");
        return DESTINATION;
      },
      sign: async (xdr: string) => {
        if (xdr === preparation) {
          log.push("stellar sign PREPARATION");
          return `signed ${xdr}`;
        }
        if (xdr.startsWith("AAAA")) {
          // a real envelope goes back as one; the node double checks no signatures
          log.push("stellar sign DELIVERY");
          return xdr;
        }
        log.push(`stellar sign ${xdr}`);
        return `signed ${xdr}`;
      },
      disconnect: async () => {},
    },
    historyKey: HISTORY_KEY,
    sourceDomain: () => 3,
    swapVenues: createSwapVenues({ network: "testnet" }),
    rpc: stellarNode(),
    usdcOnStellar: STELLAR_USDC,
    stellarNetwork: createNetworkConfig({ id: "testnet", rpcUrl: "https://example.invalid" }),
  };
}

/** The EVM wallet, at its boundary: it signs, the node answers. */
function connection(options: { reject?: boolean; allowance?: bigint } = {}): Connection {
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
      readContract: async (call: { functionName: string }) => {
        log.push(`evm read ${call.functionName}`);
        return call.functionName === "allowance" ? (options.allowance ?? 0n) : 10n ** 12n;
      },
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
  adapter: BridgeAdapter,
  route: ReturnType<typeof routeFor>,
  patch: ReturnType<typeof patches>["patch"],
  conn = connection(),
  extra: Partial<TransferDeps> = {},
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
    ...extra,
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

  it("does not touch the sponsor for an account that can already receive, and checks it first", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await run(adapter, routeFor("layerzero"), patches().patch);
    expect(log.filter((l) => l.startsWith("sponsor") || l.startsWith("stellar"))).toEqual([
      "stellar read destination",
    ]);
    expect(log.indexOf("stellar read destination")).toBeLessThan(log.indexOf("evm send value=777"));
  });

  it("tells the rail which wallet is sending, for a rail that must name a refund address", async () => {
    const adapter = new ScriptedAdapter("near-intents", [delivered()], {
      transactions: [layerZeroSend("0")],
    });
    await run(adapter, routeFor("near-intents"), patches().patch);
    expect(adapter.contexts).toEqual([{ sender: SENDER }]);
  });

  it("refuses a destination the route does not set up and that cannot hold what arrives, before any signature", async () => {
    const cases = [
      ["needs-account", /does not exist yet.*Nothing has been sent\./],
      ["needs-trustline", /cannot hold USDC yet.*Nothing has been sent\./],
    ] as const;
    for (const [state, said] of cases) {
      log = [];
      lane = state;
      const adapter = new ScriptedAdapter("axelar", [delivered()], {
        transactions: [layerZeroSend("1")],
      });
      await expect(run(adapter, routeFor("axelar"), patches().patch)).rejects.toThrow(said);
      expect(log).toEqual(["stellar read destination"]);
      expect(adapter.built).toBe(0);
    }
  });

  it("stops watching the rail once the page is gone", async () => {
    const controller = new AbortController();
    const adapter = new ScriptedAdapter("layerzero", [pending()], {
      transactions: [layerZeroSend("777")],
      onStatus: () => {
        log.push("status");
        if (log.filter((l) => l === "status").length === 2) controller.abort();
      },
    });
    await expect(
      run(adapter, routeFor("layerzero"), patches().patch, connection(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Activity/);
    expect(adapter.asked).toHaveLength(2);
  });

  it("reports a transfer it stopped watching as still moving, not as failed", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new ScriptedAdapter("layerzero", [pending()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero"), patches().patch, connection(), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(StillMoving);
  });

  it("reports a delivery that outlived the page's patience as still moving", async () => {
    const adapter = new ScriptedAdapter("layerzero", [pending()], {
      transactions: [layerZeroSend("777")],
    });
    let clock = 0;
    await expect(
      run(adapter, routeFor("layerzero"), patches().patch, connection(), {
        wait: async () => {
          clock += 61 * 60 * 1000;
        },
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(StillMoving);
  });

  it("refuses a new account the sponsor cannot settle in what the rail delivers, before any signature", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const route = routeFor("layerzero", { newAccount: true, delivers: STELLAR_XLM });

    await expect(run(adapter, route, patches().patch)).rejects.toThrow(/Nothing has been sent/);
    // who pays the reserve decides what can be set up, so only that is asked
    expect(log).toEqual(["sponsor /health"]);
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

describe("runTransfer over Circle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles, approves, burns, records, then asks for delivery until it lands, preparing the account when told to", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    deliverReplies = [
      [404, { error: "Not attested yet.", retryable: true }],
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9, settled: true }],
    ];
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const { seen, patch } = patches();

    const done = run(cctp, routeFor("cctp", { newAccount: true }), patch);
    // the first ask finds no attestation, and the next waits twenty seconds
    await vi.advanceTimersByTimeAsync(19_999);
    expect(log.filter((l) => l === "sponsor /deliver")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(log).toEqual([
      "sponsor /health",
      "stellar connect",
      "sponsor /settlement",
      "stellar sign SETTLEMENT",
      "sponsor /settlement/commit",
      "evm read balanceOf",
      "evm read allowance",
      "evm approve value=undefined",
      "evm depositForBurnWithHook value=undefined",
      `history ${SEND_HASH}`,
      "sponsor /deliver",
      "sponsor /deliver",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "sponsor /deliver",
      "deliver done",
    ]);
    expect(seen.at(-1)).toEqual({
      id: "deliver",
      patch: {
        phase: "done",
        ref: "d311",
        refUrl: "https://stellar.expert/explorer/testnet/tx/d311",
        note: "Delivered, and the deposit repaid itself from the arrival.",
      },
    });
  });
});

describe("runTransfer when the account pays its own reserve", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the trustline from the account before the send, with no repayment to sign", async () => {
    funding = "self";
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const { seen, patch } = patches();
    await run(adapter, routeFor("layerzero", { newAccount: true }), patch);

    expect(log.filter((l) => !l.startsWith("status"))).toEqual([
      "sponsor /health",
      "stellar connect",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "evm send value=777",
      `history ${SEND_HASH}`,
      "deliver pending",
      "deliver done",
    ]);
    expect(seen.some((p) => p.id === "settle")).toBe(false);
  });

  it("over Circle, opens the trustline before the burn instead of after the attestation", async () => {
    funding = "self";
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    await run(cctp, routeFor("cctp", { newAccount: true }), patches().patch);

    expect(log).toEqual([
      "sponsor /health",
      "stellar connect",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "evm read balanceOf",
      "evm read allowance",
      "evm approve value=undefined",
      "evm depositForBurnWithHook value=undefined",
      `history ${SEND_HASH}`,
      "iris /v2/messages/3",
      "stellar read destination",
      "stellar simulate delivery",
      "stellar sign DELIVERY",
      "stellar send invokeHostFunction",
      "deliver done",
    ]);
  });

  it("over Circle, has the receiving account deliver and pay for the mint, never the sponsor", async () => {
    funding = "self";
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const { seen, patch } = patches();
    await run(cctp, routeFor("cctp"), patch);

    expect(log).toEqual([
      "sponsor /health",
      "stellar connect",
      "evm read balanceOf",
      "evm read allowance",
      "evm approve value=undefined",
      "evm depositForBurnWithHook value=undefined",
      `history ${SEND_HASH}`,
      "iris /v2/messages/3",
      "stellar read destination",
      "stellar simulate delivery",
      "stellar sign DELIVERY",
      "stellar send invokeHostFunction",
      "deliver done",
    ]);
    expect(seen).toContainEqual({
      id: "deliver",
      patch: expect.objectContaining({ phase: "done", ref: expect.stringMatching(/0ae1/) }),
    });
  });

  it("over Circle, waits for the attestation before building the delivery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    funding = "self";
    irisReplies = [
      [404, {}],
      [
        200,
        { messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] },
      ],
      [200, attested],
    ];
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const done = run(cctp, routeFor("cctp"), patches().patch);
    await vi.advanceTimersByTimeAsync(40_000);
    await done;
    expect(log.filter((l) => l.startsWith("iris"))).toHaveLength(3);
    expect(log.filter((l) => l === "stellar simulate delivery")).toHaveLength(1);
  });

  it("over Circle, counts a delivery that already landed as delivered", async () => {
    funding = "self";
    simulationFailures = [new Error("HostError: Error(Contract, #6908)")];
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const { seen, patch } = patches();
    await run(cctp, routeFor("cctp"), patch);
    expect(log).not.toContain("stellar sign DELIVERY");
    expect(seen).toContainEqual({ id: "deliver", patch: { phase: "done" } });
  });

  it("over Circle, leaves a delivery that costs more than it should unsigned and still deliverable", async () => {
    funding = "self";
    preparedFee = (OWN_DELIVERY_FEE_BUDGET_STROOPS + 1n).toString();
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const error = await run(cctp, routeFor("cctp"), patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect((error as Error).message).toMatch(/0\.1000001 XLM.*Activity/);
    expect(log).not.toContain("stellar sign DELIVERY");
  });

  it("over Circle, opens a trustline that went missing after the quote, checked like any other", async () => {
    funding = "self";
    const notReady = () => new Error("HostError: Error(Contract, #13) trustline entry is missing");
    const cctp = () =>
      new CctpAdapter({ network: "testnet", rpc: stellarNode(), baseReserveStroops: 5_000_000 });

    simulationFailures = [notReady()];
    await run(cctp(), routeFor("cctp"), patches().patch);
    expect(log.filter((l) => l.startsWith("stellar sign"))).toEqual([
      "stellar sign PREPARATION",
      "stellar sign DELIVERY",
    ]);

    log = [];
    simulationFailures = [notReady()];
    preparedLine = `USDC:${SENDER_STELLAR}`;
    await expect(run(cctp(), routeFor("cctp"), patches().patch)).rejects.toThrow(
      /not the trustline this transfer needs/,
    );
    expect(log).not.toContain("stellar sign PREPARATION");
  });

  it("over Circle, refuses before the burn when the connected wallet is not the receiving account", async () => {
    funding = "self";
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const route = { ...routeFor("cctp"), destination: SENDER_STELLAR };
    await expect(run(cctp, route, patches().patch)).rejects.toThrow(
      /pays for its own delivery.*Nothing has been sent/,
    );
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });

  it("refuses to set up an account for someone other than the connected wallet, before any signature", async () => {
    funding = "self";
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const route = { ...routeFor("layerzero", { newAccount: true }), destination: SENDER_STELLAR };
    await expect(run(adapter, route, patches().patch)).rejects.toThrow(/Nothing has been sent/);
    expect(adapter.built).toBe(0);
  });

  it("opens a USDT0 trustline from the account itself before a USDT0 send", async () => {
    funding = "self";
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await run(
      adapter,
      routeFor("layerzero", { newAccount: true, delivers: STELLAR_USDT0 }),
      patches().patch,
    );

    expect(log.filter((l) => !l.startsWith("status"))).toEqual([
      "sponsor /health",
      "stellar connect",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "evm send value=777",
      `history ${SEND_HASH}`,
      "deliver pending",
      "deliver done",
    ]);
    expect(askedAssets).toEqual([["USDT0"]]);
  });

  it("refuses to sign a preparation for another asset or account than the route needs", async () => {
    funding = "self";
    for (const wrong of [
      () => {
        preparedLine = `USDT0:${SENDER_STELLAR}`;
      },
      () => {
        preparedSource = SENDER_STELLAR;
      },
    ]) {
      log = [];
      preparedLine = undefined;
      preparedSource = undefined;
      wrong();
      const adapter = new ScriptedAdapter("layerzero", [delivered()], {
        transactions: [layerZeroSend("777")],
      });
      await expect(
        run(
          adapter,
          routeFor("layerzero", { newAccount: true, delivers: STELLAR_USDT0 }),
          patches().patch,
        ),
      ).rejects.toThrow(/not the trustline this transfer needs.*Nothing has been sent/);
      expect(log.some((l) => l.startsWith("stellar sign"))).toBe(false);
      expect(adapter.built).toBe(0);
    }
  });

  it("still refuses a USDT0 trustline the sponsor would have to front", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(
        adapter,
        routeFor("layerzero", { newAccount: true, delivers: STELLAR_USDT0 }),
        patches().patch,
      ),
    ).rejects.toThrow(/the sponsor curates/);
    expect(log.some((l) => l.startsWith("sponsor /prepare"))).toBe(false);
  });
});

describe("finishing a Circle delivery from Activity", () => {
  const cctp = () =>
    new CctpAdapter({ network: "testnet", rpc: stellarNode(), baseReserveStroops: 5_000_000 });

  it("has the connected account sign and pay for it when accounts fund themselves", async () => {
    funding = "self";
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3);
    expect(outcome).toEqual({ kind: "delivered", txHash: "0ae1", ledger: 101 });
    expect(log).toContain("stellar sign DELIVERY");
    expect(log).not.toContain("sponsor /deliver");
  });

  it("asks the sponsor when it pays for deliveries", async () => {
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3);
    expect(outcome).toMatchObject({ kind: "delivered", txHash: "d311" });
    expect(log).toEqual(["sponsor /health", "sponsor /deliver"]);
  });
});
