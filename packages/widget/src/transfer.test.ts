import { buildForwarderHookData, CctpAdapter, toHex } from "@mavna/adapter-cctp";
import type { BridgeAdapter } from "@mavna/core";
import { buildPreparation, createNetworkConfig, RpcClient } from "@mavna/stellar";
import { createSwapVenues } from "@mavna/swap";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { type Address, type Hash, WaitForTransactionReceiptTimeoutError } from "viem";
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
import type { ExecutionEvent } from "./execute";
import { OWN_DELIVERY_FEE_BUDGET_STROOPS } from "./own-delivery";
import { toRouteView } from "./quote";
import { createSponsorClient } from "./sponsor";
import {
  buildSteps,
  burnDomain,
  DeliveredAsCame,
  DeliveredUnverified,
  finishDelivery,
  holdBlocker,
  mapEvm,
  runTransfer,
  StillMoving,
  type TransferDeps,
  type TransferEngine,
} from "./transfer";
import type { Connection } from "./wallet";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const ARBITRUM_SEPOLIA = 421_614;
const HISTORY_KEY = "test.transfers";
/** A Stellar address other than the one the wallet connects; the sponsor's settlement channel. */
const SENDER_STELLAR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const SPONSOR_STELLAR = Keypair.random().publicKey();

/** Everything that crossed a boundary, in the order it crossed. */
let log: string[];
let stored: Map<string, string>;
let settleReplies: Array<[number, unknown]>;
/** Status 0 is no answer at all: the connection dropped. */
let deliverReplies: Array<[number, unknown]>;
/** What the Stellar wallet refuses to sign, the way the wallet kit refuses: a plain object. */
let refuses: "PREPARATION" | "CONVERSION" | "DELIVERY" | undefined;
/** A signed transaction lands as failed on Stellar. */
let sendFails: boolean;
/** Horizon's order-book mid for USDC, in stroops per whole USDC: 5 XLM to the USDC. */
let xlmPerUsdc: bigint | Error;
/** What /submit and /settlement answer before their usual 200, in turn. */
let submitRefusals: Array<[number, unknown]>;
let settlementRefusals: Array<[number, unknown]>;
let prepareRefusals: Array<[number, unknown]>;
let commitRefusals: Array<[number, unknown]>;
/** What the Stellar node says the destination holds. */
let lane: "ready" | "needs-account" | "needs-trustline";
/** Who the sponsor says pays a new account's reserve. */
let funding: "sponsor" | "self";
/** The self-funded preparation the sponsor last built. */
let preparation: string;
/** What a self-funded preparation opens and who sources it, when a test makes it wrong. */
let preparedLine: string | undefined;
let preparedSource: string | undefined;
/** Fee, trust limit and timeout of a self-funded preparation, when a test makes them odd. */
let preparedShape: { fee?: string; limit?: string; timeout?: number };
/** What Circle's attestation service answers, in turn; the last one repeats. */
let irisReplies: Array<[number, unknown]>;
/** When set, Circle answers per source domain instead, and a domain not listed has nothing. */
let irisByDomain: Record<string, unknown> | undefined;
const attested = {
  messages: [{ status: "complete", message: "0x0102", attestation: "0x0304", decodedMessage: {} }],
};
/** The assets each /prepare asked for. */
let askedAssets: string[][];
/** The settlement the sponsor builds for a new account it fronts. */
let settlementXdr: string;
/** The preparation the sponsor builds for a new account it fronts. */
let sponsoredPreparation: string;
/** What happens on Stellar as the sponsor delivers a Circle transfer. */
let onDeliver: (() => void) | undefined;

/** A held settlement as the sponsor builds it: the arrival may buy back the reserve. */
function settlementSpending(sendMax: string): string {
  const [code, issuer] = STELLAR_USDC.id.split(":");
  return new TransactionBuilder(new Account(SENDER_STELLAR, "1"), {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        source: DESTINATION,
        sendAsset: new Asset(code ?? "", issuer),
        sendMax,
        destination: DESTINATION,
        destAsset: Asset.native(),
        destAmount: "1.5",
        path: [],
      }),
    )
    .addOperation(
      Operation.revokeAccountSponsorship({ account: DESTINATION, source: SENDER_STELLAR }),
    )
    .setTimeout(86_400)
    .build()
    .toXdr();
}

const STELLAR_USDT0 = {
  ...STELLAR_USDC,
  id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  symbol: "USDT0",
  curatedBy: "LayerZero",
};

/** The trustlines a test can say the destination holds, by CODE:ISSUER. */
const KNOWN_LINES = [STELLAR_USDC.id, STELLAR_USDT0.id];
function trustLineOf(id: string): xdr.TrustLineAsset {
  const [code, issuer] = id.split(":");
  return new Asset(code ?? "", issuer).toTrustLineXdrObject();
}

beforeEach(() => {
  log = [];
  lane = "ready";
  funding = "sponsor";
  preparation = "";
  preparedFee = "182612";
  simulationFailures = [];
  preparedAuth = undefined;
  irisReplies = [[200, attested]];
  irisByDomain = undefined;
  preparedLine = undefined;
  preparedSource = undefined;
  preparedShape = {};
  heldOnly = undefined;
  unreadable = undefined;
  usdcHeld = 0n;
  usdcFlags = 1;
  usdcLimit = 10n ** 15n;
  conversionAmounts = [];
  askedAssets = [];
  settlementXdr = settlementSpending("0.6");
  sponsoredPreparation = buildPreparation({
    network: createNetworkConfig({ id: "testnet", rpcUrl: "https://example.invalid" }),
    sponsorAccount: new Account(SPONSOR_STELLAR, "1"),
    userAddress: DESTINATION,
    createAccount: true,
    assets: [new Asset("USDC", STELLAR_USDC.id.split(":")[1])],
  }).toXdr();
  onDeliver = undefined;
  deliverReplies = [[200, { kind: "delivered", txHash: "d311", ledger: 9 }]];
  refuses = undefined;
  xlmPerUsdc = 50_000_000n;
  sendFails = false;
  submitRefusals = [];
  settlementRefusals = [];
  prepareRefusals = [];
  commitRefusals = [];
  stored = new Map();
  settleReplies = [
    [200, { settled: false, settlementRetryable: true }],
    [200, { settled: true, settlementTxHash: "5e771e" }],
  ];

  // the sponsor, at the network boundary
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.includes("/api/external/v1/find-path/")) {
      const asked = bodyOf(init) as { amount: string };
      conversionAmounts.push(asked.amount);
      // nothing more to see here: the conversion's size is the point
      return reply(503, {});
    }
    if (url.includes("/api/external/v1/pools/")) return reply(200, { count: 1 });
    if (path.startsWith("/v2/messages/")) {
      log.push(`iris ${path}`);
      if (irisByDomain !== undefined) {
        const body = irisByDomain[path.split("/").at(-1) ?? ""];
        return body === undefined ? reply(404, { error: "Not found" }) : reply(200, body);
      }
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
      case "/settlement": {
        const refusal = settlementRefusals.shift();
        if (refusal !== undefined) return reply(refusal[0], refusal[1]);
        return reply(200, { xdr: settlementXdr, channel: SENDER_STELLAR });
      }
      case "/settlement/commit": {
        expect(bodyOf(init)).toEqual({
          destination: DESTINATION,
          signedXdr: `signed ${settlementXdr}`,
        });
        const refusal = commitRefusals.shift();
        if (refusal !== undefined) return reply(refusal[0], refusal[1]);
        return reply(200, { held: true });
      }
      case "/prepare": {
        const asked = bodyOf(init) as { assets: string[] };
        askedAssets.push(asked.assets);
        const refusal = prepareRefusals.shift();
        if (refusal !== undefined) return reply(refusal[0], refusal[1]);
        if (funding === "sponsor") {
          return reply(200, { xdr: sponsoredPreparation, sponsor: SPONSOR_STELLAR });
        }
        // the real shape of a self-funded preparation: one changeTrust the account sources
        const [code] = asked.assets;
        const line = preparedLine ?? (code === "USDT0" ? STELLAR_USDT0.id : STELLAR_USDC.id);
        const [lineCode, lineIssuer] = line.split(":");
        preparation = new TransactionBuilder(new Account(preparedSource ?? DESTINATION, "1"), {
          fee: preparedShape.fee ?? "1000",
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.changeTrust({
              asset: new Asset(lineCode ?? "", lineIssuer),
              ...(preparedShape.limit === undefined ? {} : { limit: preparedShape.limit }),
            }),
          )
          .setTimeout(preparedShape.timeout ?? 300)
          .build()
          .toXdr();
        return reply(200, { xdr: preparation, selfFunded: true });
      }
      case "/submit": {
        expect(bodyOf(init)).toEqual({
          signedXdr: `signed ${funding === "self" ? preparation : sponsoredPreparation}`,
        });
        const refusal = submitRefusals.shift();
        if (refusal !== undefined) return reply(refusal[0], refusal[1]);
        return reply(200, { txHash: "9e9", ledger: 1 });
      }
      case "/deliver": {
        onDeliver?.();
        const next = deliverReplies.length > 1 ? deliverReplies.shift() : deliverReplies[0];
        if (next === undefined) throw new Error("no deliver reply scripted");
        if (next[0] === 0) throw new TypeError("Failed to fetch");
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
        const first = (JSON.parse(value) as Array<{ sourceTxHash: string }>)[0];
        if (first !== undefined) log.push(`history ${first.sourceTxHash}`);
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
        ext: xdr.AccountEntryExt.v0(),
      }),
    ),
  };
  const [code, issuer] = STELLAR_USDC.id.split(":");
  const trustline = {
    val: xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId,
        asset: new Asset(code ?? "", issuer).toTrustLineXdrObject(),
        balance: xdr.Int64.fromString(usdcHeld.toString()),
        limit: xdr.Int64.fromString(usdcLimit.toString()),
        flags: usdcFlags,
        ext: xdr.TrustLineEntryExt.v0(),
      }),
    ),
  };
  if (lane === "needs-account") return [];
  if (lane === "needs-trustline") return [account];
  return [account, trustline];
}

/** How much each conversion quote asked to convert. */
let conversionAmounts: string[];

/** The destination's USDC trustline flags and limit, when a test makes it unusable. */
let usdcFlags: number;
let usdcLimit: bigint;

/** The destination's USDC balance, in base units, as the node reports it now. */
let usdcHeld: bigint;

/** An asset code whose trustline read fails, as a node that stops answering would. */
let unreadable: string | undefined;

/** The trustlines the destination holds, by CODE:ISSUER, when a test asks per asset. */
let heldOnly: Set<string> | undefined;

/** What the delivery costs once simulated, as the node prepares it. */
let preparedFee: string;
/** What simulating the delivery answers instead, in turn, when a test makes it fail. */
let simulationFailures: Error[];
/** What the node's simulation says the delivery must authorize, when a test makes it more. */
let preparedAuth: xdr.SorobanAuthorizationEntry[] | undefined;

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
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => {
    log.push("stellar read destination");
    if (heldOnly === undefined) return { entries: ledgerEntries(), latestLedger: 100 } as never;
    // asked key by key: the account, and only the trustlines it holds
    const [account] = ledgerEntries();
    const entries = keys.flatMap((key) => {
      if (key.type === "account") return account === undefined ? [] : [account];
      if (key.type !== "trustline") return [];
      const line = key.trustLine.asset;
      // which asset this key asks about, matched on its encoded form
      const held =
        KNOWN_LINES.find((id) => trustLineOf(id).toXdr("base64") === line.toXdr("base64")) ??
        "unknown";
      // a node that stops answering for this one asset
      if (unreadable !== undefined && held.startsWith(`${unreadable}:`)) {
        throw new Error("the node did not answer");
      }
      if (!heldOnly?.has(held)) return [];
      return [
        {
          val: xdr.LedgerEntryData.trustline(
            new xdr.TrustLineEntry({
              accountId: key.trustLine.accountId,
              asset: line,
              balance: xdr.Int64.fromString("0"),
              limit: xdr.Int64.fromString((10n ** 15n).toString()),
              flags: 1,
              ext: xdr.TrustLineEntryExt.v0(),
            }),
          ),
        },
      ];
    });
    return { entries, latestLedger: 100 } as never;
  });
  vi.spyOn(client.server, "getLatestLedger").mockResolvedValue({ sequence: 100 } as never);
  vi.spyOn(client.server, "simulateTransaction").mockImplementation(async (tx) => {
    log.push("stellar simulate delivery");
    const failure = simulationFailures.shift();
    if (failure !== undefined) throw failure;
    // priced so the prepared transaction costs preparedFee in all; what it must
    // authorize is whatever the test says the node simulated
    const resourceFee = BigInt(preparedFee) - BigInt((tx as Transaction).fee);
    return {
      _parsed: true,
      id: "1",
      events: [],
      latestLedger: 100,
      minResourceFee: resourceFee.toString(),
      transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
      result: { retval: xdr.ScVal.scvVoid(), auth: preparedAuth ?? [] },
    } as never;
  });
  vi.spyOn(client.server, "sendTransaction").mockImplementation(async (tx) => {
    const op = (tx as { operations: Array<{ type: string; func?: unknown }> }).operations[0];
    log.push(`stellar send ${op?.type}`);
    return { status: "PENDING", hash: "0ae1" } as never;
  });
  vi.spyOn(client.server, "getTransaction").mockImplementation(async () =>
    sendFails
      ? ({ status: "FAILED", txHash: "0ae1", ledger: 101, latestLedger: 101 } as never)
      : ({ status: "SUCCESS", txHash: "0ae1", ledger: 101, latestLedger: 101 } as never),
  );
  return client;
}

function engineWith(adapter: BridgeAdapter): TransferEngine {
  const sponsor = createSponsorClient("https://sponsor.test");
  return {
    network: "testnet",
    adapters: [adapter],
    sponsor,
    sponsorTerms: () => sponsor.terms(),
    // the order book, at Horizon's boundary
    xlmStroopsPerUsdc: async () => {
      if (xlmPerUsdc instanceof Error) throw xlmPerUsdc;
      return xlmPerUsdc;
    },
    // the stellar wallet, at its signing boundary
    stellar: {
      connect: async () => {
        log.push("stellar connect");
        return DESTINATION;
      },
      sign: async (xdr: string) => {
        const kind =
          xdr === preparation || xdr === sponsoredPreparation ? "PREPARATION" : "CONVERSION";
        if (refuses === kind) throw { code: -4, message: "The user rejected this request." };
        if (refuses === "DELIVERY" && xdr.startsWith("AAAA") && xdr !== settlementXdr) {
          log.push("stellar refuse DELIVERY");
          throw { code: -4, message: "The user rejected this request." };
        }
        if (xdr === preparation || xdr === sponsoredPreparation) {
          log.push("stellar sign PREPARATION");
          return `signed ${xdr}`;
        }
        if (xdr === settlementXdr) {
          log.push("stellar sign SETTLEMENT");
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
    xlmOnStellar: STELLAR_XLM,
    stellarNetwork: createNetworkConfig({ id: "testnet", rpcUrl: "https://example.invalid" }),
  };
}

/** The EVM wallet, at its boundary: it signs, the node answers. */
function connection(
  options: {
    reject?: boolean;
    allowance?: bigint;
    receipt?: (args: {
      hash: Hash;
      onReplaced?: (r: { reason: string }) => void;
    }) => Promise<unknown>;
  } = {},
): Connection {
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
      waitForTransactionReceipt: async (args: {
        hash: Hash;
        onReplaced?: (r: { reason: string }) => void;
      }) =>
        options.receipt === undefined
          ? { status: "success", transactionHash: args.hash }
          : options.receipt(args),
    },
  } as unknown as Connection;
}

function patches() {
  const seen: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    seen,
    patch: (id: string, patch: Record<string, unknown>) => {
      seen.push({ id, patch });
      if (id === "deliver" && typeof patch.phase === "string") log.push(`deliver ${patch.phase}`);
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
      "stellar read destination",
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

  it.each([
    ["its issuer has not authorised it", { flags: 0 }, /has not authorised/],
    // 5 USDC arrive and the limit leaves room for 3
    ["its limit has no room for what arrives", { limit: 30_000_000n }, /room for only 3 USDC/],
  ] as const)(
    "refuses a USDC trustline that cannot take the money because %s, before any signature",
    async (_why, line, said) => {
      if ("flags" in line) usdcFlags = line.flags;
      if ("limit" in line) usdcLimit = line.limit;
      const adapter = new ScriptedAdapter("axelar", [delivered()], {
        transactions: [layerZeroSend("1")],
      });
      await expect(run(adapter, routeFor("axelar"), patches().patch)).rejects.toThrow(said);
      expect(log.some((l) => l.startsWith("evm"))).toBe(false);
      expect(adapter.built).toBe(0);
    },
  );

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
    // gone once the send is out, while the rail is being watched
    const adapter = new ScriptedAdapter("layerzero", [pending()], {
      transactions: [layerZeroSend("777")],
      onStatus: () => controller.abort(),
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
    expect(log).toEqual(["stellar read destination", "sponsor /health"]);
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

describe("the send's hash", () => {
  const FASTER = `0x${"c3".repeat(32)}` as Hash;
  const relayed = () =>
    new ScriptedAdapter("layerzero", [delivered()], { transactions: [layerZeroSend("777")] });

  it("is kept, and the transfer is still moving, when its confirmation outlasts the page's wait", async () => {
    const conn = connection({
      receipt: async ({ hash }) => {
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
    });
    const { seen, patch } = patches();
    const error = await run(relayed(), routeFor("layerzero"), patch, conn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect(log).toContain(`history ${SEND_HASH}`);
    expect(seen).toContainEqual({
      id: "burn",
      patch: { ref: "0xabab…abab", refUrl: `https://sepolia.arbiscan.io/tx/${SEND_HASH}` },
    });
  });

  it("is forgotten again when the wallet cancels the send, which then never lands", async () => {
    const conn = connection({
      receipt: async ({ onReplaced }) => {
        onReplaced?.({ reason: "cancelled" });
        return { status: "success", transactionHash: FASTER };
      },
    });
    await expect(run(relayed(), routeFor("layerzero"), patches().patch, conn)).rejects.toThrow(
      /cancelled in your wallet/,
    );
    const kept = JSON.parse(stored.get(HISTORY_KEY) ?? "[]") as Array<{ sourceTxHash: string }>;
    expect(kept).toEqual([]);
  });

  it("follows a send the wallet sped up, so history holds the one that landed", async () => {
    const conn = connection({
      receipt: async ({ onReplaced }) => {
        onReplaced?.({ reason: "repriced" });
        return { status: "success", transactionHash: FASTER };
      },
    });
    const adapter = relayed();
    await run(adapter, routeFor("layerzero"), patches().patch, conn);
    const kept = JSON.parse(stored.get(HISTORY_KEY) ?? "[]") as Array<{ sourceTxHash: string }>;
    expect(kept.map((r) => r.sourceTxHash)).toEqual([FASTER]);
    expect(adapter.asked[0]?.sourceTxHash).toBe(FASTER);
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

    // waits on the clock here, so the twenty seconds between asks can be seen
    const done = run(cctp, routeFor("cctp", { newAccount: true }), patch, connection(), {
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    // the first ask finds no attestation, and the next waits twenty seconds
    await vi.advanceTimersByTimeAsync(19_999);
    expect(log.filter((l) => l === "sponsor /deliver")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(log).toEqual([
      "stellar read destination",
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
      "stellar read destination",
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

describe("a sponsor that fronts the reserve, read before the account signs", () => {
  const ATTACKER = Keypair.random().publicKey();
  const USDC = new Asset("USDC", STELLAR_USDC.id.split(":")[1]);

  it("refuses a preparation that also hands the account to someone else", async () => {
    sponsoredPreparation = new TransactionBuilder(new Account(SPONSOR_STELLAR, "1"), {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: DESTINATION }))
      .addOperation(Operation.changeTrust({ asset: USDC, source: DESTINATION }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: DESTINATION }))
      .addOperation(
        Operation.setOptions({
          source: DESTINATION,
          signer: { ed25519PublicKey: ATTACKER, weight: 1 },
          masterWeight: 0,
        }),
      )
      .setTimeout(300)
      .build()
      .toXdr();
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow(/not signed: it does more than open the account\. Nothing has been sent/);
    expect(log).not.toContain("stellar sign PREPARATION");
    expect(log).not.toContain("sponsor /submit");
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });

  it("refuses a settlement that pays the arrival to someone else, before the burn", async () => {
    settlementXdr = new TransactionBuilder(new Account(SENDER_STELLAR, "1"), {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          source: DESTINATION,
          sendAsset: USDC,
          sendMax: "4.9",
          destination: ATTACKER,
          destAsset: Asset.native(),
          destAmount: "1.5",
          path: [],
        }),
      )
      .setTimeout(86_400)
      .build()
      .toXdr();
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    await expect(
      run(cctp, routeFor("cctp", { newAccount: true }), patches().patch),
    ).rejects.toThrow(
      /not the receiving account buying back its own reserve.*Nothing has been sent/,
    );
    expect(log).not.toContain("stellar sign SETTLEMENT");
    expect(log).not.toContain("sponsor /settlement/commit");
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });

  it("refuses a settlement that may spend more than twice the reserve's worth, though less than the arrival", async () => {
    // 1.5 XLM at 5 XLM to the USDC is 0.3 USDC; twice that is 0.6, and 4.9 is asked
    settlementXdr = settlementSpending("4.9");
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow(/more than twice the reserve's worth.*0\.63 USDC.*Nothing has been sent/);
    expect(log).not.toContain("stellar sign SETTLEMENT");
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });

  it("refuses a settlement it could not hold to a price, rather than signing it unchecked", async () => {
    xlmPerUsdc = new Error("The order book has no bids.");
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow(/no bids.*Nothing has been sent/);
    expect(log).not.toContain("stellar sign SETTLEMENT");
  });

  it("tells the user the most the repayment may take before they sign it", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const { seen, patch } = patches();
    await run(adapter, routeFor("layerzero", { newAccount: true }), patch);
    expect(seen).toContainEqual({
      id: "settle",
      patch: {
        phase: "blocked",
        note: "Repays the reserve from what arrives: at most 0.6 USDC.",
      },
    });
  });
});

describe("after the money has left the wallet", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const cctp = () =>
    new CctpAdapter({ network: "testnet", rpc: stellarNode(), baseReserveStroops: 5_000_000 });

  it("rides out a dropped connection to the sponsor and keeps asking for the delivery", async () => {
    deliverReplies = [
      [0, undefined],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp"), patch, connection(), { wait: instant });
    expect(log.filter((l) => l === "sponsor /deliver")).toHaveLength(2);
    expect(seen).toContainEqual({
      id: "attest",
      patch: { phase: "pending", note: "The last check failed (Failed to fetch). Trying again." },
    });
    expect(log.at(-1)).toBe("deliver done");
  });

  it("ends as still moving, with the wallet's own reason, when the late preparation is refused", async () => {
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
    ];
    refuses = "PREPARATION";
    const error = await run(
      cctp(),
      routeFor("cctp", { newAccount: true }),
      patches().patch,
      connection(),
      { wait: instant },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect((error as Error).message).toMatch(/The user rejected this request\..*Activity/);
  });
});

describe("a page that went away mid-transfer", () => {
  it("asks for nothing more when it closes before the send, and sends nothing", async () => {
    const gone = new AbortController();
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    // closed while the sponsor was building the repayment
    const done = run(
      adapter,
      routeFor("layerzero", { newAccount: true }),
      patches().patch,
      connection(),
      {
        signal: gone.signal,
      },
    );
    gone.abort();
    await expect(done).rejects.toThrow(/closed.*Nothing has been sent/);
    expect(log.some((l) => l.startsWith("stellar sign") || l.startsWith("evm"))).toBe(false);
  });

  it("asks for no more signatures once it is gone, and says the transfer is still moving", async () => {
    const gone = new AbortController();
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
    ];
    onDeliver = () => gone.abort();
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const error = await run(
      cctp,
      routeFor("cctp", { newAccount: true }),
      patches().patch,
      connection(),
      {
        signal: gone.signal,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect(log.filter((l) => l === "sponsor /deliver")).toHaveLength(1);
    expect(log).not.toContain("sponsor /prepare");
    expect(log).not.toContain("stellar sign PREPARATION");
  });

  it("does not ask for the conversion from a page that is gone, and says what arrived", async () => {
    const gone = new AbortController();
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "50000000" },
              to: { asset: STELLAR_XLM, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
      onStatus: () => {
        usdcHeld = 50_000_000n;
        gone.abort();
      },
    });
    const error = await run(adapter, route, patches().patch, connection(), {
      signal: gone.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveredAsCame);
    expect(conversionAmounts).toEqual([]);
  });
});

describe("a Circle conversion on an account whose reserve the sponsor fronted", () => {
  const fronted = () => {
    const base = routeFor("cctp", { newAccount: true, swap: true });
    return {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "44000000" },
              to: { asset: STELLAR_XLM, baseUnits: "20000000" },
            }
          : step,
      ),
    };
  };
  const cctp = () =>
    new CctpAdapter({ network: "testnet", rpc: stellarNode(), baseReserveStroops: 5_000_000 });

  it("leaves the repayment aside when it did not go with the mint", async () => {
    settlementXdr = settlementSpending("0.6");
    deliverReplies = [[200, { kind: "delivered", txHash: "d311", ledger: 9 }]];
    onDeliver = () => {
      usdcHeld = 50_000_000n;
    };
    await run(cctp(), fronted(), patches().patch).catch(() => undefined);
    expect(conversionAmounts).toEqual(["44000000"]);
  });

  it("converts the whole measured arrival when the repayment went with the mint", async () => {
    settlementXdr = settlementSpending("0.6");
    deliverReplies = [[200, { kind: "delivered", txHash: "d311", ledger: 9, settled: true }]];
    onDeliver = () => {
      usdcHeld = 44_800_000n;
    };
    await run(cctp(), fronted(), patches().patch).catch(() => undefined);
    expect(conversionAmounts).toEqual(["44800000"]);
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
      "stellar read destination",
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
      "stellar read destination",
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
      "deliver blocked",
      "stellar sign DELIVERY",
      "deliver pending",
      "stellar send invokeHostFunction",
      "deliver done",
    ]);
  });

  it("over Circle, refuses unsigned a delivery that would authorize anything of the account's", async () => {
    funding = "self";
    // a forwarder that, after an upgrade, asked the payer to authorize a token transfer
    preparedAuth = [
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: xdr.ScAddress.scAddressTypeContract(
                new xdr.ContractId(new Uint8Array(32).fill(9)),
              ),
              functionName: "transfer",
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      }),
    ];
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const error = await run(cctp, routeFor("cctp"), patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect((error as Error).message).toMatch(/authorize more than the delivery/);
    expect(log).not.toContain("stellar sign DELIVERY");
  });

  it("over Circle, marks the delivery as waiting on the wallet while it asks to sign it", async () => {
    funding = "self";
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const order: string[] = [];
    const { patch } = patches();
    await run(cctp, routeFor("cctp"), (id, p) => {
      if (id === "deliver" && p.phase !== undefined) order.push(`deliver ${String(p.phase)}`);
      patch(id, p);
    });
    expect(order[0]).toBe("deliver blocked");
    const signedAt = log.indexOf("stellar sign DELIVERY");
    expect(signedAt).toBeGreaterThan(-1);
    expect(order).toContain("deliver pending");
  });

  it("over Circle, stops at a declined delivery signature and leaves it to Activity", async () => {
    funding = "self";
    refuses = "DELIVERY";
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const error = await run(cctp, routeFor("cctp"), patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect((error as Error).message).toMatch(/The user rejected this request\..*Activity/);
    expect(log.filter((l) => l === "stellar refuse DELIVERY")).toHaveLength(1);
  });

  it("over Circle, does not sign a second delivery after a signed one failed on Stellar", async () => {
    funding = "self";
    sendFails = true;
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    const error = await run(cctp, routeFor("cctp"), patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StillMoving);
    expect(log.filter((l) => l === "stellar sign DELIVERY")).toHaveLength(1);
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
      "stellar read destination",
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
      "deliver blocked",
      "stellar sign DELIVERY",
      "deliver pending",
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
      "stellar read destination",
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

  it.each([
    ["a fee above what the sponsor bids", { fee: "1001" }],
    ["a trust limit below the default", { limit: "1000" }],
    ["no time bound", { timeout: 0 }],
    ["a time bound far in the future", { timeout: 86_400 }],
  ])("refuses to sign a self-funded trustline with %s", async (_what, shape) => {
    funding = "self";
    preparedShape = shape;
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(
      run(adapter, routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow(/not the trustline this transfer needs/);
    expect(log).not.toContain("stellar sign PREPARATION");
  });

  it("opens the trustline a conversion on Stellar needs from the account itself, before the send", async () => {
    funding = "self";
    // USDT0 arrives and is converted into USDC; the account holds USDT0 and no USDC
    heldOnly = new Set([STELLAR_USDT0.id]);
    const base = routeFor("layerzero", { swap: true, delivers: STELLAR_USDT0 });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDT0, baseUnits: "50000000" },
              to: { asset: STELLAR_USDC, baseUnits: "49000000" },
            }
          : step,
      ),
    };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    const { seen, patch } = patches();
    await run(adapter, route, patch).catch(() => undefined);
    expect(askedAssets).toEqual([["USDC"]]);
    // its own row on the flight, signed before the send
    expect(seen.filter((p) => p.id === "hold").map((p) => p.patch.phase)).toEqual([
      "blocked",
      "done",
    ]);
    const signed = log.indexOf("stellar sign PREPARATION");
    expect(signed).toBeGreaterThan(-1);
    expect(signed).toBeLessThan(log.indexOf("evm send value=777"));
  });

  it.each([
    ["self", [{ phase: "done", note: "It can already hold USDC." }]],
    ["sponsor", []],
  ] as const)(
    "marks the hold row only where the flight has one (%s funding)",
    async (who, marked) => {
      funding = who;
      // USDT0 arrives and is converted into USDC, which the account can already hold
      heldOnly = new Set([STELLAR_USDT0.id, STELLAR_USDC.id]);
      const base = routeFor("layerzero", { swap: true, delivers: STELLAR_USDT0 });
      const route = {
        ...base,
        steps: base.steps.map((step) =>
          step.kind === "swap"
            ? {
                ...step,
                from: { asset: STELLAR_USDT0, baseUnits: "50000000" },
                to: { asset: STELLAR_USDC, baseUnits: "49000000" },
              }
            : step,
        ),
      };
      const adapter = new ScriptedAdapter("layerzero", [delivered()], {
        transactions: [layerZeroSend("777")],
      });
      const { seen, patch } = patches();
      await run(adapter, route, patch).catch(() => undefined);
      expect(seen.filter((p) => p.id === "hold").map((p) => p.patch)).toEqual(marked);
    },
  );

  it("checks every trustline it will open before the account signs any of them", async () => {
    funding = "self";
    // the account holds nothing yet: USDT0 must be opened, and USDC for the conversion
    heldOnly = new Set();
    const base = routeFor("layerzero", { newAccount: true, swap: true, delivers: STELLAR_USDT0 });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDT0, baseUnits: "50000000" },
              to: { asset: STELLAR_USDC, baseUnits: "49000000" },
            }
          : step,
      ),
    };
    // reading whether it can hold USDC fails, so nothing should be signed at all
    unreadable = "USDC";
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(run(adapter, route, patches().patch)).rejects.toThrow();
    expect(log).not.toContain("stellar sign PREPARATION");
  });

  it("ends a delivery the rail cannot prove any more as its own outcome, never as failed", async () => {
    const unverified = {
      phase: "delivered-unverified" as const,
      ref: {
        chainId: "stellar",
        txHash: "f00d",
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/f00d",
      },
      because:
        "Axelar records it executed on Stellar, and that transaction is too old to read back.",
    };
    const adapter = new ScriptedAdapter("axelar", [unverified], {
      transactions: [layerZeroSend("1")],
    });
    const error = await run(adapter, routeFor("axelar"), patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveredUnverified);
    expect((error as Error).message).toMatch(/too old to read back.*Activity/);
  });

  it("ends a conversion on arrival that delivered as it came apart from a failure", async () => {
    const asCame = {
      phase: "delivered-as-came" as const,
      ref: { chainId: "stellar-testnet", txHash: "f00d", explorerUrl: "" },
      received: { asset: STELLAR_USDT0, baseUnits: "50000000" },
      because: "The minimum could not be met.",
    };
    const adapter = new ScriptedAdapter("layerzero", [asCame], {
      transactions: [layerZeroSend("777")],
    });
    const error = await run(adapter, routeFor("layerzero"), patches().patch).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeliveredAsCame);
    expect(error).toMatchObject({ asset: "USDT0", baseUnits: "50000000" });
  });

  it("refuses a conversion for someone else's account before anything is sent", async () => {
    // the recipient must sign the conversion, so a wallet that is not theirs stops it now
    const route = { ...routeFor("layerzero", { swap: true }), destination: SENDER_STELLAR };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(run(adapter, route, patches().patch)).rejects.toThrow(/Nothing has been sent/);
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
    expect(adapter.built).toBe(0);
  });

  it("converts only what this transfer brought in, not what the account already held", async () => {
    // 10 USDC already there; 49.5 arrive, though the route estimated 50
    usdcHeld = 100_000_000n;
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "49000000" },
              to: { asset: STELLAR_XLM, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
      onStatus: () => {
        usdcHeld = 100_000_000n + 495_000_000n / 10n;
      },
    });
    await run(adapter, route, patches().patch).catch(() => undefined);
    expect(conversionAmounts).toContain("49500000");
    expect(conversionAmounts).not.toContain("149500000");
  });

  describe("a conversion on an account whose reserve the sponsor fronted", () => {
    // 5 USDC arrive; the held settlement may spend up to 0.6 of them buying back the reserve
    const fronted = () => {
      const base = routeFor("layerzero", { newAccount: true, swap: true });
      return {
        ...base,
        steps: base.steps.map((step) =>
          step.kind === "swap"
            ? {
                ...step,
                from: { asset: STELLAR_USDC, baseUnits: "44000000" },
                to: { asset: STELLAR_XLM, baseUnits: "20000000" },
              }
            : step,
        ),
      };
    };

    it("leaves the repayment's most aside while the settlement has not been taken", async () => {
      settlementXdr = settlementSpending("0.6");
      settleReplies = [[200, { settled: false, settlementRetryable: true }]];
      const adapter = new ScriptedAdapter("layerzero", [delivered()], {
        transactions: [layerZeroSend("777")],
        onStatus: () => {
          usdcHeld = 50_000_000n;
        },
      });
      await run(adapter, fronted(), patches().patch).catch(() => undefined);
      expect(conversionAmounts).toEqual(["44000000"]);
    });

    it("converts the whole measured arrival once the repayment has already been taken from it", async () => {
      settlementXdr = settlementSpending("0.6");
      settleReplies = [[200, { settled: true, settlementTxHash: "5e771e" }]];
      const adapter = new ScriptedAdapter("layerzero", [delivered()], {
        transactions: [layerZeroSend("777")],
        // what is left once the settlement spent 0.52 of the 5
        onStatus: () => {
          usdcHeld = 44_800_000n;
        },
      });
      await run(adapter, fronted(), patches().patch).catch(() => undefined);
      expect(conversionAmounts).toEqual(["44800000"]);
    });

    it("skips the conversion and says the funds stay as they arrived when nothing would be left", async () => {
      // a repayment may never claim the whole arrival, so less arrives than it may take
      settlementXdr = settlementSpending("4.9");
      // at 0.5 XLM to the USDC, the 1.5 XLM buy-back may honestly take up to 6 USDC
      xlmPerUsdc = 5_000_000n;
      settleReplies = [[200, { settled: false, settlementRetryable: true }]];
      const adapter = new ScriptedAdapter("layerzero", [delivered()], {
        transactions: [layerZeroSend("777")],
        onStatus: () => {
          usdcHeld = 40_000_000n;
        },
      });
      const { seen, patch } = patches();
      // arrived, and stays as it came: told apart from a completed conversion
      const error = await run(adapter, fronted(), patch).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DeliveredAsCame);
      expect((error as DeliveredAsCame).baseUnits).toBe("40000000");
      expect((error as DeliveredAsCame).decimals).toBe(7);
      expect(conversionAmounts).toEqual([]);
      expect(seen.filter((p) => p.id === "swap").at(-1)?.patch).toMatchObject({
        phase: "done",
        note: expect.stringMatching(/stays in USDC/),
      });
    });
  });

  it("converts no more than the bridge quoted, so a payment landing alongside stays as it came", async () => {
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "49000000" },
              to: { asset: STELLAR_XLM, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
      // the 5 USDC quoted, and 2 USDC someone else sent during transit
      onStatus: () => {
        usdcHeld = 70_000_000n;
      },
    });
    await run(adapter, route, patches().patch).catch(() => undefined);
    expect(conversionAmounts).toEqual(["50000000"]);
  });

  it("ends a conversion that could not run after the money arrived as delivered as it came", async () => {
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
      onStatus: () => {
        usdcHeld = 50_000_000n;
      },
    });
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "50000000" },
              to: { asset: STELLAR_XLM, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    // the exchange does not answer (the harness's find-path is a 503)
    const error = await run(adapter, route, patches().patch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveredAsCame);
    expect((error as DeliveredAsCame).asset).toBe("USDC");
    expect((error as DeliveredAsCame).baseUnits).toBe("50000000");
  });

  it("will not start a conversion it could not tell apart from other arrivals", async () => {
    const base = routeFor("layerzero", { swap: true });
    const route = { ...base, steps: base.steps.filter((step) => step.kind !== "bridge") };
    const adapter = new ScriptedAdapter("layerzero", [delivered()], {
      transactions: [layerZeroSend("777")],
    });
    await expect(run(adapter, route, patches().patch)).rejects.toThrow(/Nothing has been sent/);
    expect(adapter.built).toBe(0);
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

describe("burnDomain", () => {
  it("finds the Circle domain a burn left from when this browser did not send it", async () => {
    irisByDomain = { "6": attested };
    const engine = {
      ...engineWith(new ScriptedAdapter("cctp", [])),
      sourceChains: [
        { id: "ethereum-sepolia", name: "Ethereum Sepolia" },
        { id: "base-sepolia", name: "Base Sepolia" },
        { id: "arbitrum-sepolia", name: "Arbitrum Sepolia" },
      ],
      sourceDomain: (id: string) =>
        ({ "ethereum-sepolia": 0, "base-sepolia": 6, "arbitrum-sepolia": 3 })[id] ?? Number.NaN,
    };
    expect(await burnDomain(engine, SEND_HASH)).toBe(6);
  });

  it("says so when no domain Circle serves has the burn", async () => {
    irisByDomain = {};
    const engine = {
      ...engineWith(new ScriptedAdapter("cctp", [])),
      sourceChains: [{ id: "ethereum-sepolia", name: "Ethereum Sepolia" }],
      sourceDomain: () => 0,
    };
    expect(await burnDomain(engine, SEND_HASH)).toBeUndefined();
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

  /** An attested burn whose hook data names `recipient`, laid out as Circle's v2 message is. */
  const attestedTo = (recipient: string, mintedBaseUnits = 0) => {
    const hook = buildForwarderHookData(recipient);
    const message = new Uint8Array(148 + 228 + hook.length);
    message.set(hook, 148 + 228);
    // the burn body's amount, a big-endian uint256 at body + 68; the fee at body + 164 stays 0
    new DataView(message.buffer).setUint32(148 + 68 + 28, mintedBaseUnits, false);
    irisReplies = [
      [
        200,
        {
          messages: [
            {
              status: "complete",
              message: toHex(message),
              attestation: "0x0304",
              decodedMessage: {},
            },
          ],
        },
      ],
    ];
  };

  it("asks for a new preparation once from Activity when the old one can never land", async () => {
    attestedTo(DESTINATION);
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    submitRefusals = [[409, { error: "It can never land.", retryable: true, prepareAgain: true }]];
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia");
    expect(outcome).toMatchObject({ kind: "delivered", txHash: "d311" });
    expect(log.filter((l) => l === "sponsor /prepare")).toHaveLength(2);
  });

  it("says it cannot tell whether the repayment is held when the sponsor is busy, preparing nothing", async () => {
    attestedTo(DESTINATION, 5_000_000);
    settleReplies = [[429, { error: "Asked too often.", retryable: true }]];
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
    ];
    await expect(
      finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia"),
    ).rejects.toThrow(/busy.*not known.*safe on Circle's side.*Try again in a moment/);
    expect(log).not.toContain("sponsor /prepare");
  });

  it("says the funds are safe when asking about the repayment fails", async () => {
    attestedTo(DESTINATION, 5_000_000);
    settleReplies = [[500, { error: "The sponsor's state could not be read.", retryable: true }]];
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
    ];
    await expect(
      finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia"),
    ).rejects.toThrow(
      "The sponsor's state could not be read. The funds are safe on Circle's side and still deliverable.",
    );
  });

  it("signs a new repayment first when the one held for a new account has lapsed", async () => {
    attestedTo(DESTINATION, 5_000_000);
    lane = "needs-account";
    settleReplies = [[404, { error: "Nothing is held for that account.", retryable: false }]];
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia");
    expect(outcome).toMatchObject({ kind: "delivered", txHash: "d311" });
    const asked = log.filter((l) => l.startsWith("sponsor") || l.startsWith("stellar sign"));
    expect(asked).toEqual([
      "sponsor /health",
      "sponsor /deliver",
      "sponsor /settle",
      "sponsor /settlement",
      "stellar sign SETTLEMENT",
      "sponsor /settlement/commit",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "sponsor /deliver",
    ]);
  });

  it("prepares a new account the flow never got to, checked, then delivers", async () => {
    attestedTo(DESTINATION);
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia");
    expect(outcome).toMatchObject({ kind: "delivered", txHash: "d311" });
    expect(log).toEqual([
      "sponsor /health",
      "sponsor /deliver",
      "iris /v2/messages/3",
      "stellar connect",
      // whether the sponsor still holds the repayment it is set up against
      "sponsor /settle",
      "sponsor /prepare",
      "stellar sign PREPARATION",
      "sponsor /submit",
      "sponsor /deliver",
    ]);
  });

  it("prepares nothing when the connected wallet is not the account Circle will mint to", async () => {
    attestedTo(SENDER_STELLAR);
    deliverReplies = [
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
    ];
    const outcome = await finishDelivery(engineWith(cctp()), SEND_HASH, 3, "arbitrum-sepolia");
    expect(outcome).toMatchObject({ kind: "recipient-not-ready" });
    expect(outcome.kind === "recipient-not-ready" && outcome.detail).toMatch(/GAAZI…CWN7/);
    expect(log).not.toContain("sponsor /prepare");
  });
});

describe("a destination that cannot receive at all", () => {
  it("is refused over Circle with its reason, before any signature or trustline", async () => {
    const pool = StrKey.encodeLiquidityPool(Buffer.alloc(32, 7));
    const cctp = new CctpAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
    });
    for (const newAccount of [false, true]) {
      log = [];
      const route = { ...routeFor("cctp", { newAccount }), destination: pool };
      await expect(run(cctp, route, patches().patch)).rejects.toThrow(
        /liquidity-pool address cannot receive a payment.*Nothing has been sent/,
      );
      expect(log.some((l) => l.startsWith("evm") || l.startsWith("stellar sign"))).toBe(false);
      expect(log).not.toContain("sponsor /prepare");
    }
  });
});

describe("what the sponsor answers back", () => {
  const relayed = () =>
    new ScriptedAdapter("layerzero", [delivered()], { transactions: [layerZeroSend("777")] });
  const stale = {
    error: "The sponsor's account moved on before this preparation went out, so it can never land.",
    retryable: true,
    prepareAgain: true,
  };

  it("asks for a new preparation once when the old one can never land, and signs that", async () => {
    submitRefusals = [[409, stale]];
    await run(relayed(), routeFor("layerzero", { newAccount: true }), patches().patch);
    expect(log.filter((l) => l === "sponsor /prepare")).toHaveLength(2);
    expect(log.filter((l) => l === "stellar sign PREPARATION")).toHaveLength(2);
    expect(log.filter((l) => l === "sponsor /submit")).toHaveLength(2);
    expect(log).toContain(`history ${SEND_HASH}`);
  });

  it("does not ask a third time, and says nothing was sent", async () => {
    submitRefusals = [
      [409, stale],
      [409, stale],
    ];
    await expect(
      run(relayed(), routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow(/can never land.*Nothing has been sent/);
    expect(log.filter((l) => l === "sponsor /prepare")).toHaveLength(2);
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });

  it.each([
    [429, "This address already has as many settlements waiting as it may."],
    [503, "Every settlement slot is in use. Try again shortly."],
  ])(
    "turns a busy settlement answer (%i) into a plain retry, signing nothing",
    async (status, said) => {
      settlementRefusals = [[status, { error: said, retryable: true }]];
      const error = await run(
        relayed(),
        routeFor("layerzero", { newAccount: true }),
        patches().patch,
      ).catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        `${said} Nothing has been sent, and the transfer is ready to start again in a moment.`,
      );
      expect(log.some((l) => l.startsWith("stellar sign") || l.startsWith("evm"))).toBe(false);
    },
  );
});

describe("a sponsor refusal before anything is sent", () => {
  const relayed = () =>
    new ScriptedAdapter("layerzero", [delivered()], { transactions: [layerZeroSend("777")] });

  it("says nothing has been sent when the account's own trustline cannot be prepared", async () => {
    funding = "self";
    prepareRefusals = [[429, { error: "Too many requests from this address.", retryable: true }]];
    await expect(
      run(relayed(), routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow("Too many requests from this address. Nothing has been sent.");
  });

  it("says nothing has been sent when the signed repayment is not held", async () => {
    commitRefusals = [
      [409, { error: "That settlement has expired. Ask for a new one.", retryable: false }],
    ];
    await expect(
      run(relayed(), routeFor("layerzero", { newAccount: true }), patches().patch),
    ).rejects.toThrow("That settlement has expired. Ask for a new one. Nothing has been sent.");
    expect(log.some((l) => l.startsWith("evm"))).toBe(false);
  });
});

describe("a Stellar wallet connected to another account", () => {
  it("is forgotten when it turns out not to be the receiving account, so the next try asks again", async () => {
    let forgot = 0;
    const engine = engineWith(new ScriptedAdapter("layerzero", [delivered()]));
    const other = {
      ...engine,
      stellar: {
        ...engine.stellar,
        connect: async () => SENDER_STELLAR,
        forget: () => {
          forgot += 1;
        },
      },
    };
    await expect(
      runTransfer({
        engine: other,
        view: toRouteView(routeFor("layerzero", { newAccount: true })),
        chainId: "arbitrum-sepolia",
        chainName: "Arbitrum Sepolia",
        evmChainId: ARBITRUM_SEPOLIA,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        connection: connection(),
        wanted: "USDC",
        patch: patches().patch,
        onEvmEvent: () => {},
        wait: instant,
      }),
    ).rejects.toThrow(/Switch to that account in your wallet/);
    expect(forgot).toBe(1);
  });
});

describe("a delivery the rail can no longer prove", () => {
  it("says the arrival was not converted when the route converts, and asks for no conversion", async () => {
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_USDC, baseUnits: "50000000" },
              to: { asset: STELLAR_XLM, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    const unverified = {
      phase: "delivered-unverified" as const,
      ref: {
        chainId: "stellar-testnet",
        txHash: "f00d",
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/f00d",
      },
      because: "The rail's record no longer says what arrived.",
    };
    const adapter = new ScriptedAdapter("layerzero", [unverified], {
      transactions: [layerZeroSend("777")],
      onStatus: () => {
        usdcHeld = 50_000_000n;
      },
    });
    const error = await run(adapter, route, patches().patch).catch((e: unknown) => e);
    // ended, though unproven: its own outcome, with the Stellar transaction to check
    expect(error).toBeInstanceOf(DeliveredUnverified);
    expect((error as DeliveredUnverified).txHash).toBe("f00d");
    expect((error as DeliveredUnverified).explorerUrl).toBe(
      "https://stellar.expert/explorer/testnet/tx/f00d",
    );
    expect((error as Error).message).toMatch(/not converted.*USDC.*XLM/);
    expect(conversionAmounts).toEqual([]);
  });
});

describe("whether closing the page is safe while Circle attests", () => {
  const cctp = () =>
    new CctpAdapter({ network: "testnet", rpc: stellarNode(), baseReserveStroops: 5_000_000 });
  const attestNotes = (seen: Array<{ id: string; patch: Record<string, unknown> }>) =>
    seen
      .filter((p) => p.id === "attest" && typeof p.patch.note === "string")
      .map((p) => p.patch.note);

  it("is said only once the sponsor has the burn on its watch list", async () => {
    deliverReplies = [
      [404, { error: "Not attested yet.", retryable: true, watching: true }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp"), patch);
    expect(attestNotes(seen)[0]).toMatch(/Safe to close this page: the sponsor delivers it/);
  });

  it("is not said when the sponsor does not say it is watching, or cannot be reached", async () => {
    for (const first of [
      [404, { error: "Not attested yet.", retryable: true }],
      [0, undefined],
    ] as Array<[number, unknown]>) {
      deliverReplies = [first, [200, { kind: "delivered", txHash: "d311", ledger: 9 }]];
      const { seen, patch } = patches();
      await run(cctp(), routeFor("cctp"), patch);
      const notes = attestNotes(seen);
      expect(notes.some((n) => /Safe to close/.test(String(n)))).toBe(false);
      expect(
        notes.some((n) => /Closing this page pauses the delivery.*Activity/.test(String(n))),
      ).toBe(true);
    }
  });

  it("is said when a sent delivery's outcome is not known yet but the sponsor is watching it", async () => {
    deliverReplies = [
      [
        502,
        {
          error: "The delivery went out and its outcome is not known yet.",
          retryable: true,
          deliveryTxHash: "d311",
          watching: true,
        },
      ],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp"), patch);
    expect(attestNotes(seen)[0]).toMatch(/Safe to close this page: the sponsor delivers it/);
  });

  it("is upgraded to safe once a later answer says the sponsor is watching", async () => {
    deliverReplies = [
      [0, undefined],
      [404, { error: "Not attested yet.", retryable: true, watching: true }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp"), patch);
    const notes = attestNotes(seen).map(String);
    const paused = notes.findIndex((n) => /Closing this page pauses the delivery/.test(n));
    const safe = notes.findIndex((n) => /Safe to close this page/.test(n));
    expect(paused).toBeGreaterThan(-1);
    expect(safe).toBeGreaterThan(paused);
  });

  it("goes from paused to safe on the answers the sponsor really sends: unknown to Circle, then pending", async () => {
    // since round 4 the sponsor watches only burns Circle knows: a plain 404 says
    // nothing of watching, and Circle's pending answer comes back watched
    deliverReplies = [
      [404, { error: "Not attested yet.", retryable: true }],
      [404, { error: "Not attested yet.", retryable: true, watching: true }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp"), patch);
    const notes = attestNotes(seen).map(String);
    const paused = notes.findIndex((n) => /Closing this page pauses the delivery/.test(n));
    const safe = notes.findIndex((n) => /Safe to close this page/.test(n));
    expect(paused).toBe(0);
    expect(safe).toBeGreaterThan(paused);
  });

  it("is not said for a new account, which its own wallet still has to set up", async () => {
    deliverReplies = [
      [404, { error: "Not attested yet.", retryable: true, watching: true }],
      [409, { kind: "recipient-not-ready", detail: "The account does not exist yet." }],
      [200, { kind: "delivered", txHash: "d311", ledger: 9 }],
    ];
    const { seen, patch } = patches();
    await run(cctp(), routeFor("cctp", { newAccount: true }), patch);
    const notes = attestNotes(seen);
    expect(notes.some((n) => /Safe to close/.test(String(n)))).toBe(false);
    expect(notes[0]).toMatch(/Closing this page pauses setting up the new account.*Activity/);
  });

  it("is never said when the account signs its own delivery", () => {
    const steps = buildSteps(toRouteView(routeFor("cctp")), "self");
    const attest = steps.find((s) => s.id === "attest");
    expect(attest?.note).not.toMatch(/Safe to close/);
    expect(attest?.note).toMatch(/closing this page pauses it.*Activity/);
    // before the sponsor has answered, nothing calls it safe either
    const sponsored = buildSteps(toRouteView(routeFor("cctp")), "sponsor");
    expect(sponsored.find((s) => s.id === "attest")?.note).not.toMatch(/Safe to close/);
  });
});

describe("holdBlocker", () => {
  it("lets a ready trustline through, opens a missing one, and refuses an unusable one", () => {
    expect(holdBlocker({ kind: "ready", slotsNeeded: 0 }, "USDC")).toBeUndefined();
    expect(holdBlocker({ kind: "needs-trustline", slotsNeeded: 1 }, "USDC")).toBe("opens");
    expect(
      holdBlocker({ kind: "unusable", slotsNeeded: 0, reason: "It is not authorised." }, "USDC"),
    ).toEqual({ refused: expect.stringMatching(/not authorised.*Nothing has been sent/) });
  });
});

describe("mapEvm, a reset and an approval on one row", () => {
  const H = `0x${"aa".repeat(32)}` as Hash;
  const run3 = (events: ExecutionEvent[]) => {
    const seen: Array<{ id: string; patch: Record<string, unknown> }> = [];
    for (const event of events) mapEvm(event, 3, (id, patch) => seen.push({ id, patch }));
    return seen;
  };

  it("does not show the approval done when only the reset was skipped", () => {
    const seen = run3([
      { kind: "skipped", index: 0, why: "Nothing is allowed yet, so there is nothing to reset." },
      { kind: "awaiting-signature", index: 1, describes: "Allow" },
    ]);
    expect(seen.some((p) => p.id === "approve" && p.patch.phase === "done")).toBe(false);
    expect(seen.some((p) => p.patch.note !== undefined)).toBe(false);
    expect(seen.at(-1)).toEqual({ id: "approve", patch: { phase: "blocked" } });
  });

  it("shows it done once the approval itself is confirmed, or skipped", () => {
    expect(
      run3([
        { kind: "confirmed", index: 0, hash: H },
        { kind: "awaiting-signature", index: 1, describes: "Allow" },
        { kind: "sent", index: 1, hash: H },
        { kind: "confirmed", index: 1, hash: H },
      ]).filter((p) => p.patch.phase === "done"),
    ).toEqual([{ id: "approve", patch: { phase: "done" } }]);
    expect(
      run3([
        { kind: "skipped", index: 0, why: "reset" },
        { kind: "skipped", index: 1, why: "You have already allowed this." },
      ]).filter((p) => p.patch.phase === "done"),
    ).toEqual([
      { id: "approve", patch: { phase: "done", note: "You have already allowed this." } },
    ]);
  });
});
