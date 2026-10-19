import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CCTP_CONTRACTS,
  contractAddressToBytes32,
  EVM_DEPLOYMENTS,
  fromHex,
  NON_EVM_CHAINS,
  parseForwarderHookData,
  SOLANA_PROGRAMS,
  STARKNET_DEPLOYMENTS,
  solanaAddressToBytes32,
  stellarDomainFor,
} from "@mavna/adapter-cctp";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import {
  AccountNotFound,
  buildPreparation,
  buildSettlement,
  classifyAddress,
  inspectDestination,
  readAccountEntry,
  SubmitRejected,
  spareStroops,
  stroopsToXlm,
  XlmPriceSource,
} from "@mavna/stellar";
import {
  Account,
  type Asset,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import * as z from "zod";
import { BuiltLedger, type BuiltRecord, type Repayment, signedBy } from "./built.js";
import { CapLedger, classifySourceChain, DEFAULT_CHEAP_GAS_CHAINS } from "./caps.js";
import { ChannelPool, type ChannelPoolSnapshot } from "./channels.js";
import { ComposeRefused, Composer, parseComposeRequest } from "./compose.js";
import type { ReserveFunding } from "./config.js";
import { Deliverer, type DeliveryOutcome } from "./deliver.js";
import { clientAddress, RequestLimiter } from "./ratelimit.js";
import type { SoroswapProxy } from "./soroswap.js";
import { DocumentCapStore, type DocumentStore, MemoryDocumentStore } from "./state.js";

/**
 * The small server the specification says must exist, and what it may not do.
 *
 * Two things force a server into an otherwise client-side product: sponsorship
 * needs a funded signer, and a funded signer cannot live in a browser. This is
 * that signer's home, and its entire authority is listed in the routes below:
 * it prepares accounts it pays for, and it triggers deliveries whose recipient
 * is fixed inside Circle's attested message. It never holds user funds, never
 * signs a user's transfer, and never sees a user's key.
 *
 * Self-hostable by construction: plain node:http, no framework, every endpoint
 * configurable, run it with your own keys and none of our limits are yours.
 */

export interface SponsorServerOptions {
  readonly rpc: RpcClient;
  readonly network: NetworkConfig;
  readonly networkId: "testnet" | "mainnet";
  /** The sponsor's secret. Operational; never logged, never serialised. */
  readonly sponsorSecret: string;
  /**
   * The assets this sponsor will open trustlines for, by name.
   *
   * A curated list with a named curator, because anyone can issue an asset
   * called USDC and sponsoring a trustline to an imitation costs a real deposit
   * and dresses a phishing asset in our credibility. Clients ask by name and
   * the issuer comes from here, never from the request.
   */
  readonly curatedAssets: Readonly<Record<string, Asset>>;
  /** Builds the CCTP delivery. Injected as in the Deliverer. */
  readonly buildDelivery: ConstructorParameters<typeof Deliverer>[0]["buildDelivery"];
  /** Where Circle's attestation service lives. */
  readonly irisUrl: string;
  readonly caps?: CapLedger;
  /**
   * Channel accounts, which carry settlement sequence numbers.
   *
   * A pre-signed settlement occupies its channel's sequence until it lands or
   * expires, so one channel serves exactly one in-flight settlement. Given none,
   * the server creates and funds one from the sponsor on first use, which is a
   * capacity of one concurrent settlement: enough to run everything yourself,
   * and the pool is the knob when it is not.
   */
  readonly channels?: ChannelPool;
  /** Prices the reserve in the arriving asset, for the settlement's ceiling. */
  readonly prices?: XlmPriceSource;
  /**
   * Origins allowed to call this from a browser. The app's own origin in
   * production; localhost while developing. Never `*`: this server spends
   * money on request.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * How often held settlements are swept, in seconds. Zero turns the sweep off.
   *
   * LayerZero and Axelar deliver without this server, and only the user's open
   * page asks for the settlement afterwards. A tab closed in between would
   * otherwise leave the reserve unpaid until the settlement's time bound.
   */
  readonly settleSweepSeconds?: number;
  /**
   * Where held settlements, built transactions, channel keys and leases, and
   * (unless `caps` is given) the cap counts are kept. In memory when omitted,
   * which loses all of it on a restart; a deployment gives it a directory.
   */
  readonly state?: DocumentStore;
  /** Who pays an arriving account's reserve. Defaults to the sponsor. */
  readonly reserveFunding?: ReserveFunding;
  /**
   * The smallest CCTP mint, in USDC base units, this sponsor pays to deliver.
   * Delivery is permissionless and costs the payer a fee whatever the amount,
   * so without a floor a stream of dust burns spends the sponsor's XLM.
   */
  readonly minDeliveryBaseUnits?: bigint;
  /** Requests per client address per minute. Zero or omitted means no limit. */
  readonly rateLimitPerMinute?: number;
  /** Take the client address from the last X-Forwarded-For entry. */
  readonly trustProxy?: boolean;
  /**
   * The Soroswap proxy, present only when this deployment holds a Soroswap key.
   * Without one its endpoints do not exist, and the browser falls to the next
   * venue.
   */
  readonly soroswap?: SoroswapProxy;
  /**
   * The Mavna Arrival Contract whose overdue conversions this sponsor finishes.
   * Absent means /compose answers that it finishes none.
   */
  readonly arrivalContract?: string;
  /**
   * The key named as `lz_compose`'s executor, separate from the sponsor key and
   * holding only its minimum balance. Required with `arrivalContract`.
   */
  readonly arrivalExecutorSecret?: string;
}

/** The HTTP server, and the sweep that settles what no page came back for. */
export interface SponsorServer extends Server {
  /** Resolves once stored state is loaded; rejects if it cannot be read. */
  ready(): Promise<void>;
  /** Start sweeping on the configured interval. Does nothing when it is zero. */
  startSweep(): void;
  /** Stop sweeping. Resolves once a sweep already under way has finished. */
  stopSweep(): Promise<void>;
}

const DEFAULT_SETTLE_SWEEP_SECONDS = 120;

/** One USDC at Circle's six decimals. */
const DEFAULT_MIN_DELIVERY_BASE_UNITS = 1_000_000n;

/**
 * The fee on a trustline an account opens for itself, in stroops. It pays it,
 * so it is kept small; ten times the network minimum leaves room for ordinary
 * surge pricing.
 */
const SELF_FUNDED_FEE_STROOPS = 1_000;

/**
 * How long the sweep waits on one account. A settlement normally lands in a few
 * ledgers; past this the call is left to finish on its own and the sweep moves
 * on, so one hung node cannot stall every later tick.
 */
const SWEEP_ACCOUNT_DEADLINE_MS = 60_000;

interface PrepareBody {
  readonly destination?: string;
  readonly assets?: readonly string[];
  readonly sourceChainId?: string;
}

interface SubmitBody {
  readonly signedXdr?: string;
}

interface DeliverBody {
  readonly txHash?: unknown;
  readonly domain?: unknown;
  /**
   * Accepted from older clients and never acted on. Who the transfer is for is
   * read from Circle's attested message, the one source a caller cannot choose.
   */
  readonly destination?: unknown;
}

interface SettlementBody {
  readonly destination?: string;
  readonly sourceChainId?: string;
}

interface ComposeBody {
  readonly from?: unknown;
  readonly guid?: unknown;
  readonly index?: unknown;
  readonly message?: unknown;
}

interface SettleBody {
  readonly destination?: unknown;
}

interface SettlementCommitBody {
  readonly destination?: string;
  readonly signedXdr?: string;
}

/** A settlement the user signed, held until their money lands. */
interface HeldSettlement {
  xdr: string;
  createdAtUnix: number;
  sourceChainId: string;
  channel: string | undefined;
  maxTimeUnix: number;
  /** What this settlement repays, which the preparation must match exactly. */
  repays: Repayment;
  /**
   * Whether the preparation this settlement repays has landed. Until it
   * has, the revokes have nothing to revoke and the settlement can only
   * fail, which would count as a stranding and drop it.
   */
  prepared: boolean;
  /**
   * Whether a preparation against this settlement is being submitted by
   * this process. It is matched to what this settlement repays before it
   * goes out, so the settlement cannot be swapped while it is on its way.
   */
  preparing: boolean;
  /**
   * The preparation sent against this settlement whose outcome is not yet
   * known, written down before it is sent. After a restart it is looked up
   * by hash before anything else is prepared or settled for the account.
   */
  preparation: { hash: string; expiresAtUnix: number } | undefined;
}

/** Held settlements and recent repayments, as written to the state store. */
interface HeldDocument {
  readonly held: Record<string, Omit<HeldSettlement, "preparing">>;
  readonly settled: Record<string, { txHash: string; untilUnix: number }>;
}

/** The channel pool as written down, with a key whose funding is unconfirmed. */
interface ChannelDocument extends ChannelPoolSnapshot {
  readonly pending?: string;
}

/**
 * The shapes this version writes, checked on load. A file in another shape,
 * from another version or edited by hand, stops the process with its name
 * rather than failing later on some field it lacked.
 */
const repaymentShape = z.object({ createdAccount: z.boolean(), assets: z.array(z.string()) });
const storedShapes = {
  built: z.array(
    z.looseObject({
      hash: z.string(),
      kind: z.string(),
      destination: z.string(),
      signer: z.string(),
      sourceChainId: z.string(),
      expiresAtUnix: z.number(),
      repays: repaymentShape.optional(),
    }),
  ),
  held: z.object({
    held: z.record(
      z.string(),
      z.looseObject({
        xdr: z.string(),
        createdAtUnix: z.number(),
        sourceChainId: z.string(),
        maxTimeUnix: z.number(),
        repays: repaymentShape,
        prepared: z.boolean(),
        preparation: z.object({ hash: z.string(), expiresAtUnix: z.number() }).optional(),
      }),
    ),
    settled: z.record(z.string(), z.object({ txHash: z.string(), untilUnix: z.number() })),
  }),
  channels: z.object({
    secrets: z.array(z.string()),
    leases: z.array(z.object({ owner: z.string(), channel: z.string(), untilUnix: z.number() })),
    pending: z.string().optional(),
  }),
} as const;

async function readStored<K extends keyof typeof storedShapes>(
  state: DocumentStore,
  name: K,
): Promise<unknown> {
  const value = await state.read(name);
  if (value === undefined) return undefined;
  if (!storedShapes[name].safeParse(value).success) {
    throw new Error(`The sponsor's ${name} state is not in the shape this version writes.`);
  }
  return value;
}

/**
 * How long past a preparation's time bound before it is taken as never
 * landing. The bound is inclusive on the network and this clock is not the
 * ledger's.
 */
const PREPARATION_GRACE_SECONDS = 30;

/** One JSON answer shape, so callers never parse two formats. */
const reply = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  origin: string | undefined,
): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(origin === undefined ? {} : { "access-control-allow-origin": origin }),
  });
  res.end(JSON.stringify(body));
};

export function createSponsorServer(options: SponsorServerOptions): SponsorServer {
  const sweepSeconds = options.settleSweepSeconds ?? DEFAULT_SETTLE_SWEEP_SECONDS;
  if (!Number.isInteger(sweepSeconds) || sweepSeconds < 0) {
    throw new Error(
      `The settlement sweep interval must be a whole number of seconds, zero to turn it off; ` +
        `got ${String(options.settleSweepSeconds)}.`,
    );
  }
  const keypair = Keypair.fromSecret(options.sponsorSecret);
  const state = options.state ?? new MemoryDocumentStore();
  const caps = options.caps ?? new CapLedger(new DocumentCapStore(state));
  const reserveFunding: ReserveFunding = options.reserveFunding ?? "sponsor";
  const minDelivery = options.minDeliveryBaseUnits ?? DEFAULT_MIN_DELIVERY_BASE_UNITS;
  if (minDelivery < 0n) {
    throw new Error(`The minimum delivery cannot be negative; got ${minDelivery}.`);
  }
  const limiter = new RequestLimiter(options.rateLimitPerMinute ?? 0);
  const composesPerClient = new RequestLimiter(COMPOSES_PER_CLIENT_PER_MINUTE);
  const deliverer = new Deliverer({
    rpc: options.rpc,
    network: options.network,
    networkId: options.networkId,
    payerSecret: options.sponsorSecret,
    buildDelivery: options.buildDelivery,
  });
  // An account paying its own way finishes its own composes, so in that mode the
  // sponsor neither finishes nor keeps the contract alive, and needs no executor.
  const finishes = (options.reserveFunding ?? "sponsor") === "sponsor";
  if (
    finishes &&
    options.arrivalContract !== undefined &&
    options.arrivalExecutorSecret === undefined
  ) {
    throw new Error(
      "Finishing conversions needs its own executor key (arrivalExecutorSecret), separate " +
        "from the sponsor key.",
    );
  }
  const composer =
    !finishes ||
    options.arrivalContract === undefined ||
    options.arrivalExecutorSecret === undefined
      ? undefined
      : new Composer({
          rpc: options.rpc,
          network: options.network,
          contract: options.arrivalContract,
          payerSecret: options.sponsorSecret,
          executorSecret: options.arrivalExecutorSecret,
        });
  // the chain refuses a second finish anyway; these keep repeated or spammed asks
  // from costing simulations and fees. Per message and overall, not per address:
  // behind the reverse proxy every caller has the proxy's address.
  const composing = new Set<string>();
  const lastComposeCall = new Map<string, number>();
  const recentComposes: number[] = [];

  /**
   * Settlements collected before any capital moved, waiting for delivery.
   * Written to the state store on every change, so a restart neither forgets
   * a loan it is owed nor lets a second preparation in against one.
   */
  const heldSettlements = new Map<string, HeldSettlement>();

  /**
   * When each account last had a settlement asked for through /settle. Entries
   * older than the window are pruned on every call, so this holds at most the
   * accounts asked about in the last window.
   */
  const lastSettleCall = new Map<string, number>();

  /**
   * Accounts whose settlement is being submitted right now. The sweep and a
   * page's /settle can reach the same account at once, and a second submission
   * of the same transaction fails on its sequence, which would read as a
   * stranding and drop a settlement that in fact landed.
   */
  const settling = new Map<string, symbol>();

  /**
   * Settlements that landed, kept until their own time bound so a page asking
   * after the sweep got there first hears that it was repaid rather than that
   * nothing was held. Pruned on every write and read, so it never holds more
   * than one window's worth of settlements.
   */
  const recentlySettled = new Map<string, { txHash: string; untilUnix: number }>();

  function pruneSettled(): void {
    const now = nowUnix();
    for (const [account, record] of recentlySettled) {
      if (record.untilUnix <= now) recentlySettled.delete(account);
    }
  }

  function settledRecently(destination: string): string | undefined {
    pruneSettled();
    return recentlySettled.get(destination)?.txHash;
  }

  /**
   * The held settlement for an account, if it can still land. One past its
   * time bound never will, so sponsoring against it would be the gift the
   * ordering exists to prevent, and it is dropped. Its channel is not released
   * here: the lease ends on its own at the same bound, and by now the account
   * may hold a newer lease on the same channel for a settlement still live.
   *
   * Dropping one whose preparation landed is a stranding like any other: the
   * reserve went out and nothing will repay it. That is also the cheapest way
   * to cause one, by preparing and never sending, so the brake must see it.
   */
  async function liveSettlement(destination: string): Promise<HeldSettlement | undefined> {
    const held = heldSettlements.get(destination);
    if (held === undefined) return undefined;
    if (held.preparation !== undefined && !held.preparing) {
      await resolvePreparation(destination, held);
    }
    if (heldSettlements.get(destination) !== held) return heldSettlements.get(destination);
    if (held.maxTimeUnix <= nowUnix()) {
      heldSettlements.delete(destination);
      await persist();
      if (held.prepared) await caps.recordStranded();
      return undefined;
    }
    return held;
  }

  /**
   * Settle what became of a preparation sent before a restart, or whose answer
   * never came. Landed means prepared. Gone for good, either failed or past its
   * own time bound, means another may be sent. Anything else stays marked, so
   * nothing is prepared against the settlement twice. A lookup that fails
   * leaves it marked as well; the next touch asks again.
   */
  async function resolvePreparation(destination: string, held: HeldSettlement): Promise<void> {
    const sent = held.preparation;
    if (sent === undefined) return;
    let found: Awaited<ReturnType<RpcClient["findTransaction"]>>;
    try {
      found = await options.rpc.findTransaction(sent.hash);
    } catch (cause) {
      console.error(
        `[sponsor] could not look up the preparation sent for ${destination}:`,
        cause instanceof Error ? cause.message : cause,
      );
      return;
    }
    if (heldSettlements.get(destination) !== held || held.preparation !== sent) return;
    if (found.status === "SUCCESS") {
      held.prepared = true;
      held.preparation = undefined;
      await persist();
      return;
    }
    if (found.status === "FAILED" || sent.expiresAtUnix + PREPARATION_GRACE_SECONDS < nowUnix()) {
      held.preparation = undefined;
      await persist();
    }
  }

  /** What is written down, read back. Runs once, before the first request. */
  async function load(): Promise<void> {
    const now = nowUnix();
    const builtDocument = (await readStored(state, "built")) as readonly BuiltRecord[] | undefined;
    if (builtDocument !== undefined) built = BuiltLedger.fromSnapshot(builtDocument, now);

    const heldDocument = (await readStored(state, "held")) as HeldDocument | undefined;
    for (const [destination, held] of Object.entries(heldDocument?.held ?? {})) {
      heldSettlements.set(destination, { ...held, preparing: false });
    }
    for (const [destination, record] of Object.entries(heldDocument?.settled ?? {})) {
      recentlySettled.set(destination, record);
    }

    const channelDocument = (await readStored(state, "channels")) as ChannelDocument | undefined;
    if (channelDocument === undefined) return;
    if (channels !== undefined) {
      channels.restoreLeases(channelDocument.leases, now);
    } else if (channelDocument.secrets.length > 0) {
      channels = ChannelPool.fromSnapshot(channelDocument, now);
    }
    if (channels === undefined && channelDocument.pending !== undefined) {
      pendingChannel = Keypair.fromSecret(channelDocument.pending);
    }
  }

  /** What each document was last asked to hold, and that write, to skip unchanged ones. */
  const written = new Map<string, { readonly text: string; readonly done: Promise<void> }>();

  /**
   * Write everything a restart must not lose. Called before any answer that
   * depends on it and before any submission whose outcome it must survive.
   */
  function persist(): Promise<void> {
    pruneSettled();
    const held: Record<string, Omit<HeldSettlement, "preparing">> = {};
    for (const [destination, { preparing: _transient, ...kept }] of heldSettlements) {
      held[destination] = kept;
    }
    const pool: ChannelPoolSnapshot = channels?.snapshot() ?? { secrets: [], leases: [] };
    const channelDocument: ChannelDocument =
      pendingChannel === undefined ? pool : { ...pool, pending: pendingChannel.secret() };
    // In this order, one after another: a held settlement names a channel lease,
    // so the lease is on disk before the settlement that relies on it. A crash
    // between them then leaves a lease without a settlement, which lapses
    // harmlessly, never a settlement whose lease could be handed to another.
    const documents: Record<string, unknown> = {
      built: built.snapshot(),
      channels: channelDocument,
      held: { held, settled: Object.fromEntries(recentlySettled) } satisfies HeldDocument,
    };
    // Most answers change nothing, and rewriting every file (secrets included)
    // for each anonymous refusal is wasted disk and a wider window for a
    // half-finished write, so only a document that differs is written.
    let chain: Promise<void> = Promise.resolve();
    for (const [name, value] of Object.entries(documents)) {
      const text = JSON.stringify(value);
      const last = written.get(name);
      if (last?.text === text) {
        // the same state may still be on its way to disk: waited on, so this
        // answer goes out no sooner than that write lands, and hears if it fails
        const pending = last.done;
        chain = chain.then(() => pending);
        continue;
      }
      const done = chain
        .then(() => state.write(name, value))
        .catch((cause: unknown) => {
          // not written after all, so the next persist tries again
          if (written.get(name)?.text === text) written.delete(name);
          throw cause;
        });
      written.set(name, { text, done });
      chain = done;
    }
    return chain;
  }
  /**
   * What this server built and has not yet seen signed. The funded key signs
   * nothing whose hash is not in here, because a signature check on a body the
   * caller chose proves only that the caller can sign.
   */
  let built = new BuiltLedger();
  const expected = expectedMessageFields(options.networkId);
  /** Circle domains this network routes into Stellar from, and nothing else. */
  const sourceDomains = new Set(
    [
      ...Object.values(EVM_DEPLOYMENTS[options.networkId]),
      ...Object.values(NON_EVM_CHAINS[options.networkId]),
    ].map((chain) => chain.domain),
  );
  let channels = options.channels;
  /** A channel key written down whose funding has not been seen to land. */
  let pendingChannel: Keypair | undefined;
  const prices =
    options.prices ??
    new XlmPriceSource({
      horizonUrl:
        options.networkId === "mainnet"
          ? "https://horizon.stellar.org"
          : "https://horizon-testnet.stellar.org",
    });

  /**
   * The one channel this deployment runs on, created and funded on first use.
   *
   * 2 XLM: the account's own 1 XLM minimum plus fee headroom for the
   * settlements it will carry. Reused serially; the pool is the upgrade path.
   * The funding is shared by every request that arrives while it runs, so two
   * first settlements fund one channel, and forgotten if it fails so the next
   * request tries again.
   */
  let funding: Promise<ChannelPool> | undefined;
  function ensureChannels(): Promise<ChannelPool> {
    if (channels !== undefined) return Promise.resolve(channels);
    funding ??= fundChannel().then(
      (pool) => {
        channels = pool;
        return pool;
      },
      (cause: unknown) => {
        funding = undefined;
        throw cause;
      },
    );
    return funding;
  }

  async function fundChannel(): Promise<ChannelPool> {
    // Written down before any XLM goes to it, so a crash mid-funding leaves a
    // key that is funded again, or found funded, rather than an account
    // nobody can sign for.
    const channel = pendingChannel ?? Keypair.random();
    pendingChannel = channel;
    await persist();
    if (!(await accountExists(options.rpc, channel.publicKey()))) {
      await submitChannelFunding(channel);
    }
    const pool = new ChannelPool({ channels: [channel] });
    channels = pool;
    pendingChannel = undefined;
    await persist();
    return pool;
  }

  async function submitChannelFunding(channel: Keypair): Promise<void> {
    const sponsorAccount = await options.rpc.loadAccount(keypair.publicKey());
    const create = new TransactionBuilder(sponsorAccount, {
      fee: "1000000",
      networkPassphrase: options.network.passphrase,
    })
      .addOperation(
        Operation.createAccount({ destination: channel.publicKey(), startingBalance: "2" }),
      )
      .setTimeout(120)
      .build();
    create.sign(keypair);
    await options.rpc.submit("channel funding", async () => create);
  }

  /**
   * Turn down a transaction the server did build, and put its record back. The
   * refusal is about this request, not the transaction: the right signature or
   * a settlement held a moment later makes the same body acceptable, and a
   * stranger who replays someone's transaction should not be able to burn it.
   */
  async function refuse(
    record: BuiltRecord,
    res: ServerResponse,
    origin: string | undefined,
    status: number,
    error: string,
    retryable = false,
  ): Promise<void> {
    built.record(record, nowUnix());
    await answer(res, status, { error, retryable }, origin);
  }

  /**
   * Write down what changed, then answer. A write that fails is logged and
   * the answer still goes out: what happened on the network happened, and
   * saying otherwise invites a retry of something that worked. So an answer
   * can outlive its record; what is lost then fails closed (a forgotten
   * settlement or preparation is refused at /submit, not paid for).
   */
  async function answer(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    origin: string | undefined,
  ): Promise<void> {
    try {
      await persist();
    } catch (cause) {
      console.error(
        "[sponsor] could not write state before answering:",
        cause instanceof Error ? cause.message : cause,
      );
    }
    reply(res, status, body, origin);
  }

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweepRun: Promise<void> | undefined;

  /**
   * Try every held settlement that could land now, one at a time.
   *
   * Sequential on purpose: each is a balance read and maybe a submission, and
   * there is no deadline here worth spending the RPC's patience on. One account
   * failing is logged and does not stop the rest.
   */
  async function sweepHeld(): Promise<void> {
    for (const destination of [...heldSettlements.keys()]) {
      try {
        // Inside the try: dropping an expired settlement writes to the cap
        // store, and one account's failed write must not end the sweep.
        const held = await liveSettlement(destination);
        if (held === undefined || !held.prepared) continue;
        const outcome = await settleIfHeld(destination, SWEEP_ACCOUNT_DEADLINE_MS);
        if (outcome.settled === true) {
          console.error(`[sponsor] sweep settled a held settlement for ${destination}`);
        }
      } catch (cause) {
        console.error(
          `[sponsor] sweep could not settle for ${destination}:`,
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  }

  function sweepTick(): void {
    // A slow node can make one sweep outlast the interval. The next tick is
    // skipped rather than queued, so sweeps never overlap or pile up.
    if (sweepRun !== undefined) return;
    sweepRun = sweepHeld().finally(() => {
      sweepRun = undefined;
    });
  }

  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  function keepArrivalAlive(): void {
    if (composer === undefined) return;
    composer.keepAlive().then(
      (done) => console.error(`[sponsor] arrival contract kept alive, tx ${done.txHash}`),
      (cause: unknown) =>
        console.error(
          "[sponsor] could not keep the arrival contract alive:",
          cause instanceof Error ? cause.message : cause,
        ),
    );
  }

  function startSweep(): void {
    if (!finishes && options.arrivalContract !== undefined && keepAliveTimer === undefined) {
      console.error(
        "[sponsor] reserves are paid by the accounts themselves, so this sponsor spends nothing: " +
          "the Arrival Contract is not kept alive here, and whoever finishes a conversion pays " +
          "any storage renewal then due (the widget shows it before they sign).",
      );
    }
    if (composer !== undefined && keepAliveTimer === undefined) {
      keepArrivalAlive();
      keepAliveTimer = setInterval(keepArrivalAlive, KEEP_ALIVE_EVERY_MS);
      keepAliveTimer.unref?.();
    }
    if (sweepSeconds === 0 || sweepTimer !== undefined) return;
    sweepTimer = setInterval(sweepTick, sweepSeconds * 1000);
    // The sweep alone is no reason to keep the process alive.
    sweepTimer.unref?.();
  }

  function stopSweep(): Promise<void> {
    if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    sweepTimer = undefined;
    return sweepRun ?? Promise.resolve();
  }

  const corsOrigin = (req: IncomingMessage): string | undefined => {
    const origin = req.headers.origin;
    return origin !== undefined && options.allowedOrigins.includes(origin) ? origin : undefined;
  };

  // Started here, once everything it fills in exists. A failure is kept for
  // ready() and for every request, and logged now so it is never silent.
  const loaded = load();
  loaded.catch((cause: unknown) => {
    console.error(
      "[sponsor] could not read stored state:",
      cause instanceof Error ? cause.message : cause,
    );
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      if (cause instanceof RequestError) {
        reply(res, cause.status, { error: cause.message, retryable: false }, corsOrigin(req));
        return;
      }
      // Nothing internal reaches the wire. A caller learns that it failed and
      // whether to retry; the operator reads the rest from the process log.
      console.error("[sponsor]", cause instanceof Error ? cause.message : cause);
      reply(
        res,
        500,
        { error: "That did not work. Nothing was spent.", retryable: true },
        corsOrigin(req),
      );
    });
  });
  server.on("close", () => {
    void stopSweep();
  });
  return Object.assign(server, { startSweep, stopSweep, ready: () => loaded });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = corsOrigin(req);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(origin === undefined ? 403 : 204, {
        ...(origin === undefined ? {} : { "access-control-allow-origin": origin }),
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    const client = clientAddress(
      req.socket.remoteAddress,
      req.headers["x-forwarded-for"],
      options.trustProxy === true,
    );
    if (!limiter.allow(client, Date.now())) {
      reply(
        res,
        429,
        { error: "Too many requests from this address. Try again in a minute.", retryable: true },
        origin,
      );
      return;
    }

    await loaded;

    if (req.method === "GET" && url.pathname === "/health") {
      reply(
        res,
        200,
        {
          ok: true,
          network: options.networkId,
          sponsor: keypair.publicKey(),
          // What a client needs to quote honestly: whether a new account can
          // be served at all, and the smallest Circle transfer delivered.
          reserveFunding,
          minDeliveryBaseUnits: minDelivery.toString(),
        },
        origin,
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/prepare") {
      await prepare((await readJson(req)) as PrepareBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      await submit((await readJson(req)) as SubmitBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement") {
      await settlement((await readJson(req)) as SettlementBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement/commit") {
      await settlementCommit((await readJson(req)) as SettlementCommitBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settle") {
      await settle((await readJson(req)) as SettleBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/deliver") {
      await deliver((await readJson(req)) as DeliverBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/compose") {
      await compose((await readJson(req)) as ComposeBody, res, origin, client);
      return;
    }

    if (options.soroswap?.owns(url.pathname) === true) {
      const answer = await options.soroswap.handle({
        method: req.method ?? "",
        path: url.pathname,
        originAllowed: origin !== undefined,
        client,
        // An origin that will be refused costs nothing to read.
        body: req.method === "POST" && origin !== undefined ? await readJson(req) : undefined,
      });
      reply(res, answer.status, answer.body, origin);
      return;
    }

    reply(res, 404, { error: "No such endpoint.", retryable: false }, origin);
  }

  /**
   * Build the preparation for the user to sign.
   *
   * Nothing is spent here and nothing is signed here: the transaction goes back
   * unsigned, the user signs the operations that create obligations on their own
   * account, and only /submit commits the sponsor. The caps are checked at this
   * step too, so a refusal happens before anyone is asked for a signature.
   */
  async function prepare(
    body: PrepareBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.destination === undefined) {
      await answer(res, 400, { error: "Say which account to prepare.", retryable: false }, origin);
      return;
    }

    // The caps bound the sponsor's money, and an account paying for itself
    // spends none of it.
    if (reserveFunding === "sponsor") {
      const decision = await caps.check(
        classifySourceChain(body.sourceChainId ?? "unknown", DEFAULT_CHEAP_GAS_CHAINS),
      );
      if (!decision.allowed) {
        await answer(res, 429, { error: decision.reason, retryable: true }, origin);
        return;
      }
    }

    const names = body.assets ?? ["USDC"];
    const assets = names.map((name) => options.curatedAssets[name]);
    if (assets.some((asset) => asset === undefined)) {
      // By name from the curated list, never by issuer from the wire: sponsoring
      // a trustline to an imitation asset is paying to phish our own users.
      await answer(
        res,
        400,
        { error: "This sponsor only prepares accounts for assets it curates.", retryable: false },
        origin,
      );
      return;
    }
    // The settlement repays one USDC trustline, so any other set is a
    // preparation /submit would refuse after the user had already signed it.
    // An account paying its own reserve borrows nothing, so it may open any one
    // curated trustline.
    if (reserveFunding === "self" && names.length !== 1) {
      await answer(
        res,
        400,
        { error: "Ask for one trustline at a time.", retryable: false },
        origin,
      );
      return;
    }
    if (reserveFunding === "sponsor" && (names.length !== 1 || names[0] !== "USDC")) {
      await answer(
        res,
        400,
        {
          error: "This sponsor only prepares a USDC trustline, the one its settlement repays.",
          retryable: false,
        },
        origin,
      );
      return;
    }

    let classified: ReturnType<typeof classifyAddress>;
    try {
      classified = classifyAddress(body.destination);
    } catch {
      await answer(
        res,
        400,
        { error: "That is not an address a Stellar account can use.", retryable: false },
        origin,
      );
      return;
    }
    if (!classified.needsTrustline) {
      await answer(
        res,
        400,
        { error: "That address can already receive; nothing to prepare.", retryable: false },
        origin,
      );
      return;
    }
    if (reserveFunding === "self") {
      await prepareSelfFunded(body.destination, body.sourceChainId, assets as Asset[], res, origin);
      return;
    }
    const created = !(await accountExists(
      options.rpc,
      classified.trustlineHolder ?? body.destination,
    ));

    const sponsorAccount = await options.rpc.loadAccount(keypair.publicKey());
    const transaction = buildPreparation({
      network: options.network,
      sponsorAccount,
      userAddress: body.destination,
      createAccount: created,
      assets: assets as Asset[],
    });
    built.record(
      {
        hash: transaction.hash().toString("hex"),
        kind: "preparation",
        destination: body.destination,
        signer: signerFor(body.destination),
        sourceChainId: body.sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
      },
      nowUnix(),
    );

    await answer(res, 200, { xdr: transaction.toXDR(), sponsor: keypair.publicKey() }, origin);
  }

  /**
   * The preparation for an account that pays its own reserve: a trustline it
   * opens from its own XLM, sourced to it and paid by it, with nothing of the
   * sponsor's in it. There is no loan, so there is no settlement.
   *
   * Refused before anyone signs when it cannot work: an account that does not
   * exist cannot pay for anything, and one without the spare XLM would sign a
   * transaction the network then refuses.
   */
  async function prepareSelfFunded(
    destination: string,
    sourceChainId: string | undefined,
    assets: readonly Asset[],
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    const holder = signerFor(destination);
    const base = BigInt(options.network.baseReserveStroops);
    const holds = assets.map((asset) => asset.getCode()).join(" and ");
    const entry = await readAccountEntry(options.rpc, holder);
    if (entry === undefined) {
      await answer(
        res,
        400,
        {
          error:
            "That Stellar account does not exist yet, and this service does not front " +
            `reserves. It needs at least ${stroopsToXlm(2n * base)} XLM sent to it to exist, ` +
            `and ${stroopsToXlm(base)} XLM more to hold ${holds}, before it can receive this.`,
          retryable: false,
        },
        origin,
      );
      return;
    }
    const needed = base * BigInt(assets.length) + BigInt(SELF_FUNDED_FEE_STROOPS);
    const spare = spareStroops(entry, options.network.baseReserveStroops);
    if (spare < needed) {
      await answer(
        res,
        400,
        {
          error:
            `Holding ${holds} locks ${stroopsToXlm(base * BigInt(assets.length))} XLM in this ` +
            `account, plus a fee of ${stroopsToXlm(BigInt(SELF_FUNDED_FEE_STROOPS))} XLM, and it ` +
            `has ${stroopsToXlm(spare > 0n ? spare : 0n)} XLM to spare. Add XLM to it, then try again.`,
          retryable: false,
        },
        origin,
      );
      return;
    }

    const builder = new TransactionBuilder(new Account(holder, entry.seqNum().toString()), {
      fee: String(SELF_FUNDED_FEE_STROOPS),
      networkPassphrase: options.network.passphrase,
    });
    for (const asset of assets) builder.addOperation(Operation.changeTrust({ asset }));
    const transaction = builder.setTimeout(300).build();
    built.record(
      {
        hash: transaction.hash().toString("hex"),
        kind: "preparation",
        destination,
        signer: holder,
        sourceChainId: sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
        selfFunded: true,
      },
      nowUnix(),
    );
    await answer(res, 200, { xdr: transaction.toXDR(), selfFunded: true }, origin);
  }

  /**
   * Submit a trustline the account signed and pays for. Nothing here signs:
   * the sponsor only checks it is the transaction it built and passes it on.
   */
  async function submitSelfFunded(
    transaction: Transaction,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (transaction.operations.some((op) => op.type !== "changeTrust")) {
      await answer(
        res,
        400,
        { error: "That transaction does more than open a trustline.", retryable: false },
        origin,
      );
      return;
    }
    const record = built.take(transaction.hash().toString("hex"), "preparation", nowUnix());
    if (record === undefined || record.selfFunded !== true) {
      if (record !== undefined) built.record(record, nowUnix());
      await answer(
        res,
        409,
        {
          error: "That preparation was not built here, or has expired. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }
    if (transaction.source !== record.signer || !signedBy(transaction, record.signer)) {
      await refuse(
        record,
        res,
        origin,
        400,
        "That preparation is not signed by the account it is for.",
      );
      return;
    }
    let result: Awaited<ReturnType<RpcClient["submit"]>>;
    try {
      result = await options.rpc.submit("self-funded preparation", async () => transaction, {
        presigned: true,
      });
    } catch (cause) {
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      console.error(
        "[sponsor] a self-funded preparation was not accepted:",
        cause instanceof Error ? cause.message : cause,
      );
      await answer(
        res,
        502,
        { error: "The preparation could not be submitted.", retryable },
        origin,
      );
      return;
    }
    await answer(res, 200, { txHash: result.txHash, ledger: result.ledger }, origin);
  }

  /** Refuse the settlement endpoints when there is no loan to settle. */
  async function noLoans(res: ServerResponse, origin: string | undefined): Promise<void> {
    await answer(
      res,
      409,
      {
        error:
          "This sponsor does not front reserves right now: an account pays its own, so " +
          "there is no repayment to sign.",
        retryable: false,
      },
      origin,
    );
  }

  /**
   * Build the settlement for the user to sign, before anything is committed.
   *
   * This is §5.2 of the cost decision, the piece that turns the deposit from a
   * permanent gift into a loan: one transaction, one amount, bounded life,
   * signed while the user is present. It buys exactly the XLM the reserve needs
   * out of the arriving money and hands the obligation over, releasing the
   * sponsor's capital to serve the next person.
   */
  async function settlement(
    body: SettlementBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.destination === undefined) {
      await answer(res, 400, { error: "Say which account will settle.", retryable: false }, origin);
      return;
    }
    if (reserveFunding === "self") {
      await noLoans(res, origin);
      return;
    }
    // A settlement being submitted may already have spent its channel's
    // sequence. Building now would put this one on the next sequence, which is
    // the next user's once the channel is released.
    if (settling.has(body.destination)) {
      await answer(
        res,
        409,
        {
          error: "This account's last settlement is still landing. Ask again shortly.",
          retryable: true,
        },
        origin,
      );
      return;
    }
    const decision = await caps.check(
      classifySourceChain(body.sourceChainId ?? "unknown", DEFAULT_CHEAP_GAS_CHAINS),
    );
    if (!decision.allowed) {
      await answer(res, 429, { error: decision.reason, retryable: true }, origin);
      return;
    }

    const usdc = options.curatedAssets.USDC;
    if (usdc === undefined) {
      await answer(
        res,
        500,
        { error: "This sponsor curates no settling asset.", retryable: false },
        origin,
      );
      return;
    }

    let classified: ReturnType<typeof classifyAddress>;
    try {
      classified = classifyAddress(body.destination);
    } catch {
      await answer(
        res,
        400,
        { error: "That is not a usable Stellar address.", retryable: false },
        origin,
      );
      return;
    }
    if (!classified.needsTrustline) {
      await answer(
        res,
        400,
        { error: "That address needs no settling.", retryable: false },
        origin,
      );
      return;
    }
    const createdAccount = !(await accountExists(
      options.rpc,
      classified.trustlineHolder ?? body.destination,
    ));

    const pool = await ensureChannels();
    const now = nowUnix();
    // Short until the settlement comes back signed, which settlementCommit
    // extends to the settlement's own bound. Anyone can ask for a settlement,
    // and a day-long lease per request would let one caller take every slot.
    const channel = pool.acquire(body.destination, now + PROVISIONAL_LEASE_SECONDS, now);
    if (channel === undefined) {
      await answer(
        res,
        503,
        { error: "Every settlement slot is in use. Try again shortly.", retryable: true },
        origin,
      );
      return;
    }

    // Account 2 slots + one trustline = 3, or 1 when the account already exists.
    const slots = createdAccount ? 3 : 1;
    const xlmNeededStroops = BigInt(slots) * BigInt(options.network.baseReserveStroops);
    // The ceiling is twice the reserve at the live rate: generous enough that
    // ordinary movement between signing and settling is absorbed, bounded enough
    // that the user's exposure is a number they can read.
    const stroopsPerUsdc = await prices.xlmStroopsPerUnit(usdc);
    const maxSpendBase = (xlmNeededStroops * 2n * 10_000_000n) / stroopsPerUsdc;

    const channelAccount = await options.rpc.loadAccount(channel.address);
    const transaction = buildSettlement({
      network: options.network,
      channelAccount,
      sponsorAddress: keypair.publicKey(),
      userAddress: body.destination,
      payingAsset: usdc,
      xlmNeeded: stroopsToDecimal(xlmNeededStroops),
      maxSpend: stroopsToDecimal(maxSpendBase),
      assets: [usdc],
      createdAccount,
      validForSeconds: SETTLEMENT_VALIDITY_SECONDS,
    });
    built.record(
      {
        hash: transaction.hash().toString("hex"),
        kind: "settlement",
        destination: body.destination,
        signer: signerFor(body.destination),
        sourceChainId: body.sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
        channel: channel.address,
        repays: { createdAccount, assets: [usdc.toString()] },
      },
      nowUnix(),
    );

    await answer(res, 200, { xdr: transaction.toXDR(), channel: channel.address }, origin);
  }

  /**
   * Hold what the user signed until their money lands.
   *
   * Nothing is signed by the server here: the channel and sponsor signatures go
   * on at submission time, so what sits in memory can move nothing on its own.
   * That makes what gets held the whole question, so only a settlement this
   * server built, signed by the account it was built for, is held, and only
   * under that account.
   */
  async function settlementCommit(
    body: SettlementCommitBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.signedXdr === undefined) {
      await answer(res, 400, { error: "Send the signed settlement.", retryable: false }, origin);
      return;
    }
    if (reserveFunding === "self") {
      await noLoans(res, origin);
      return;
    }
    const transaction = parseTransaction(body.signedXdr, options.network.passphrase);
    if ("innerTransaction" in transaction) {
      await answer(
        res,
        400,
        { error: "Fee bumps are not accepted here.", retryable: false },
        origin,
      );
      return;
    }
    const allowed = new Set([
      "pathPaymentStrictReceive",
      "revokeTrustlineSponsorship",
      "revokeAccountSponsorship",
      "revokeSponsorship",
    ]);
    if (transaction.operations.some((op) => !allowed.has(op.type))) {
      await answer(
        res,
        400,
        { error: "That transaction does more than settle.", retryable: false },
        origin,
      );
      return;
    }

    const record = built.take(transaction.hash().toString("hex"), "settlement", nowUnix());
    if (record === undefined) {
      await answer(
        res,
        409,
        {
          error: "That settlement was not built here, or has expired. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }
    if (body.destination !== undefined && body.destination !== record.destination) {
      await refuse(record, res, origin, 400, "That settlement was built for a different account.");
      return;
    }
    if (!signedBy(transaction, record.signer)) {
      await refuse(
        record,
        res,
        origin,
        400,
        "That settlement is not signed by the account it is for.",
      );
      return;
    }

    // Replacing a settlement whose preparation has landed would let the loan be
    // repaid by a cheaper settlement than the one it was made against.
    const current = await liveSettlement(record.destination);
    if (current?.prepared === true) {
      await refuse(
        record,
        res,
        origin,
        409,
        "This account's preparation has landed against the settlement already held.",
      );
      return;
    }
    if (current !== undefined && (current.preparing || current.preparation !== undefined)) {
      await refuse(
        record,
        res,
        origin,
        409,
        "This account's preparation is being submitted against the settlement already held.",
      );
      return;
    }
    if (record.repays === undefined) {
      throw new Error("a built settlement has no record of what it repays");
    }

    // The settlement sits on its channel's next sequence, which is only this
    // account's while it holds the lease. A lease that lapsed or moved on means
    // that sequence now belongs to someone else's settlement, and holding this
    // one would let it spend theirs. Held, the lease runs to the settlement's
    // own bound.
    const pool = await ensureChannels();
    if (
      record.channel === undefined ||
      !pool.extend(record.destination, record.channel, record.expiresAtUnix, nowUnix())
    ) {
      await answer(
        res,
        409,
        {
          error: "That settlement's slot has lapsed or passed to someone else. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }

    heldSettlements.set(record.destination, {
      xdr: body.signedXdr,
      createdAtUnix: nowUnix(),
      sourceChainId: record.sourceChainId,
      channel: record.channel,
      maxTimeUnix: record.expiresAtUnix,
      repays: record.repays,
      prepared: false,
      preparing: false,
      preparation: undefined,
    });
    await answer(res, 200, { held: true }, origin);
  }

  /**
   * Submit a held settlement, once the money it spends from exists.
   *
   * Failure here is the recoverable direction: the user keeps everything that
   * arrived and the sponsor stays sponsoring, retryable from the same held
   * transaction until its time bound. A permanent failure is recorded against
   * the stranding cap, which is the exposure brake.
   */
  async function settleIfHeld(
    destination: string,
    deadlineMs?: number,
  ): Promise<Record<string, unknown>> {
    if (settling.has(destination)) return { settled: false, settlementRetryable: true };
    // A claim of its own, so a call abandoned at its deadline that finishes
    // later cannot release a newer call's claim on the same account.
    const claim = Symbol(destination);
    settling.set(destination, claim);
    const release = (): void => {
      if (settling.get(destination) === claim) settling.delete(destination);
    };
    // Written down as soon as it is known, because the sweep has no answer to
    // write it before and a landed repayment must not be retried after a restart.
    const work = settleHeld(destination)
      .then(async (outcome) => {
        try {
          await persist();
        } catch (cause) {
          console.error(
            `[sponsor] could not write state after settling for ${destination}:`,
            cause instanceof Error ? cause.message : cause,
          );
        }
        return outcome;
      })
      .finally(release);
    if (deadlineMs === undefined) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    try {
      const outcome = await Promise.race([work, expired]);
      if (outcome !== "expired") return outcome;
    } finally {
      clearTimeout(timer);
    }

    // Released so the next sweep can try again. Submitting the same signed
    // transaction twice is safe: the network answers the second as a duplicate
    // of the first, or refuses it on sequence once the first has landed.
    release();
    console.error(
      `[sponsor] settling for ${destination} did not finish within ${deadlineMs} ms; ` +
        "the sweep moved on and will try again",
    );
    void work.then(
      (late) => {
        if (late.settled === true) {
          console.error(
            `[sponsor] a settlement for ${destination} landed after the sweep moved on`,
          );
        }
      },
      (cause: unknown) => {
        console.error(
          `[sponsor] a settlement for ${destination} failed after the sweep moved on:`,
          cause instanceof Error ? cause.message : cause,
        );
      },
    );
    return { settled: false, settlementRetryable: true };
  }

  async function settleHeld(destination: string): Promise<Record<string, unknown>> {
    const held = await liveSettlement(destination);
    if (held === undefined) return { settled: false };
    if (!held.prepared) return { settled: false, settlementRetryable: true };
    const pool = await ensureChannels();

    const transaction = TransactionBuilder.fromXDR(held.xdr, options.network.passphrase);
    if ("innerTransaction" in transaction) return { settled: false };
    // Only while this account still holds the channel. Once the lease has moved
    // on, the channel's next sequence belongs to someone else's settlement, and
    // signing this one would spend it.
    const channelKeypair = pool.keypairFor(destination, transaction.source);
    if (channelKeypair === undefined) {
      console.error(
        `[sponsor] the settlement held for ${destination} is on a channel it no longer leases`,
      );
      return { settled: false };
    }

    // A delivery landing proves Circle minted something, not that it was this
    // user's transfer or enough of it. Submitting before the money is there
    // fails on-chain, burns the channel's sequence, and counts as a stranding,
    // so a dust burn naming someone would spend their settlement for them.
    let covered: boolean;
    try {
      covered = await holdsEnoughToSettle(destination, transaction);
    } catch (cause) {
      console.error(
        "[sponsor] could not read the recipient's balance before settling:",
        cause instanceof Error ? cause.message : cause,
      );
      return { settled: false, settlementRetryable: true };
    }
    if (!covered) return { settled: false, settlementRetryable: true };

    // The answer can arrive after this settlement was dropped as expired and
    // a newer one held for the account. That one, and its lease, are not this
    // call's to clear.
    const stillHeld = (): boolean => heldSettlements.get(destination) === held;
    const settled = (txHash: string): Record<string, unknown> => {
      if (stillHeld()) {
        heldSettlements.delete(destination);
        pool.release(destination, transaction.source);
      }
      pruneSettled();
      recentlySettled.set(destination, { txHash, untilUnix: held.maxTimeUnix });
      return { settled: true, settlementTxHash: txHash };
    };
    const stranded = async (): Promise<Record<string, unknown>> => {
      // The held transaction can never land. The capital it would have
      // released is now the §6.1 loss, counted where the brake can see it.
      // One no longer held was counted when it was dropped as expired. Cleared
      // before the count is awaited, so a newer settlement held meanwhile is
      // not the one cleared.
      if (stillHeld()) {
        heldSettlements.delete(destination);
        pool.release(destination, transaction.source);
        await caps.recordStranded();
      }
      return { settled: false, settlementRetryable: false };
    };

    try {
      transaction.sign(channelKeypair);
      transaction.sign(keypair);
      const result = await options.rpc.submit("settlement", async () => transaction, {
        presigned: true,
        waitSeconds: SETTLEMENT_WAIT_SECONDS,
      });
      return settled(result.txHash);
    } catch (cause) {
      if (cause instanceof SubmitRejected && cause.code === "txBadSeq") {
        return await spentSequence(transaction.hash().toString("hex"), settled, stranded);
      }
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      if (!retryable) return await stranded();
      return { settled: false, settlementRetryable: retryable };
    }
  }

  /**
   * The channel's sequence is past this settlement's. Either this settlement
   * landed already, from an earlier attempt whose answer never arrived, or
   * something else took the sequence and it never can. Only the ledger knows
   * which, so it is asked by hash.
   */
  async function spentSequence(
    hash: string,
    settled: (txHash: string) => Record<string, unknown>,
    stranded: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    let found: Awaited<ReturnType<RpcClient["findTransaction"]>>;
    try {
      found = await options.rpc.findTransaction(hash);
    } catch (cause) {
      console.error(
        "[sponsor] could not look up a settlement whose sequence is spent:",
        cause instanceof Error ? cause.message : cause,
      );
      return { settled: false, settlementRetryable: true };
    }
    if (found.status === "SUCCESS") return settled(hash);
    return await stranded();
  }

  /**
   * Whether the recipient's trustline already holds the most the settlement's
   * path payment may spend. A settlement without exactly one such payment is
   * not one this server built, and is never treated as covered.
   */
  async function holdsEnoughToSettle(
    destination: string,
    transaction: Transaction,
  ): Promise<boolean> {
    const payments = transaction.operations.filter(
      (op): op is Operation.PathPaymentStrictReceive => op.type === "pathPaymentStrictReceive",
    );
    const payment = payments[0];
    if (payments.length !== 1 || payment === undefined) return false;
    const state = await inspectDestination(options.rpc, destination, payment.sendAsset);
    if (state.trustline === undefined || !state.trustline.authorized) return false;
    return BigInt(state.trustline.balanceStroops) >= decimalToStroops(payment.sendMax);
  }

  /** Countersign what the user signed, and submit it. This is where money moves. */
  async function submit(
    body: SubmitBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.signedXdr === undefined) {
      await answer(
        res,
        400,
        { error: "Send the signed transaction back.", retryable: false },
        origin,
      );
      return;
    }

    const transaction = parseTransaction(body.signedXdr, options.network.passphrase);
    if ("innerTransaction" in transaction) {
      await answer(
        res,
        400,
        { error: "Fee bumps are not accepted here.", retryable: false },
        origin,
      );
      return;
    }
    if (reserveFunding === "self") {
      await submitSelfFunded(transaction, res, origin);
      return;
    }
    // Defence in depth only. The ledger below is what decides: a body the
    // sponsor did not build is refused however plausible its operations look.
    if (transaction.source !== keypair.publicKey()) {
      await answer(
        res,
        400,
        { error: "That is not a transaction this sponsor built.", retryable: false },
        origin,
      );
      return;
    }
    const allowed = new Set([
      "beginSponsoringFutureReserves",
      "endSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
    ]);
    if (transaction.operations.some((op) => !allowed.has(op.type))) {
      await answer(
        res,
        400,
        { error: "That transaction does more than prepare an account.", retryable: false },
        origin,
      );
      return;
    }

    // Taken, not read: once countersigned, the same signed body must never earn
    // a second signature.
    const record = built.take(transaction.hash().toString("hex"), "preparation", nowUnix());
    if (record === undefined) {
      await answer(
        res,
        409,
        {
          error: "That preparation was not built here, or has expired. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }

    // Before the held check, so a body anyone could copy cannot be used to ask
    // whether a given account is mid-transfer.
    if (!signedBy(transaction, record.signer)) {
      await refuse(
        record,
        res,
        origin,
        400,
        "That preparation is not signed by the account it is for.",
      );
      return;
    }

    // The governing order: no capital commits until the settlement that releases
    // it is already signed and held. Without this the deposit is a gift, which is
    // the model the cost decision explicitly rejected.
    const held = await liveSettlement(record.destination);
    if (held === undefined) {
      await refuse(
        record,
        res,
        origin,
        409,
        "No settlement is held for this account. The deposit is a loan, and the " +
          "repayment is signed before the loan is made, not after.",
      );
      return;
    }
    // Whether the account exists is read separately at each step, and it can
    // change in between, so the preparation is held to what the settlement
    // revokes rather than to what was true when each was built.
    if (!sameRepayment(sponsoredBy(transaction), held.repays)) {
      await refuse(
        record,
        res,
        origin,
        409,
        "That preparation does not match the settlement held for this account.",
      );
      return;
    }
    // One settlement repays one preparation. A second in flight would clear the
    // mark below when it fails while the first is still out, and a second after
    // the first landed has nothing left to repay it.
    if (held.preparing || held.preparation !== undefined || held.prepared) {
      await refuse(
        record,
        res,
        origin,
        409,
        "A preparation has already been submitted against this account's settlement.",
      );
      return;
    }
    // Marked before the first await, so the settlement just matched cannot be
    // swapped for a cheaper one while this preparation is on its way.
    held.preparing = true;
    const source = classifySourceChain(record.sourceChainId, DEFAULT_CHEAP_GAS_CHAINS);
    let result: Awaited<ReturnType<RpcClient["submit"]>>;
    try {
      const decision = await caps.check(source);
      if (!decision.allowed) {
        await refuse(record, res, origin, 429, decision.reason, true);
        return;
      }

      transaction.sign(keypair);
      // Written down before it is sent, so a restart mid-flight looks this
      // preparation up by hash instead of letting another in beside it.
      const sent = { hash: record.hash, expiresAtUnix: record.expiresAtUnix };
      held.preparation = sent;
      try {
        await persist();
      } catch (cause) {
        held.preparation = undefined;
        throw cause;
      }
      try {
        result = await options.rpc.submit("sponsored preparation", async () => transaction);
      } catch (cause) {
        const retryable = cause instanceof MavnaError ? cause.retryable : true;
        // A refusal is final. Anything else (a timeout, an answer that never
        // came) may still land, so the mark stays and the next touch looks it up.
        if (!retryable && held.preparation === sent) held.preparation = undefined;
        await answer(
          res,
          502,
          { error: "The preparation could not be submitted.", retryable },
          origin,
        );
        return;
      }
    } finally {
      held.preparing = false;
    }
    if (heldSettlements.get(record.destination) === held) {
      held.prepared = true;
      held.preparation = undefined;
    } else {
      // Dropped as expired while the preparation was out, before it was marked
      // prepared, so nothing counted it. The reserve is out and unrepaid.
      console.error(
        `[sponsor] a preparation for ${record.destination} landed after its settlement was dropped`,
      );
      try {
        await caps.recordStranded();
      } catch (cause) {
        console.error(
          "[sponsor] a stranded preparation was not counted against the cap:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
    try {
      await caps.recordStarted(source);
    } catch (cause) {
      // The preparation is on the ledger whatever the count says. Reporting a
      // failure would invite the user to retry something that worked, so the
      // operator hears about the undercount and the user hears the truth.
      console.error(
        "[sponsor] a sponsorship landed but was not counted against the cap:",
        cause instanceof Error ? cause.message : cause,
      );
    }
    await answer(res, 200, { txHash: result.txHash, ledger: result.ledger }, origin);
  }

  /**
   * Submit a held settlement for rails that deliver without this server.
   *
   * LayerZero and Axelar land funds on Stellar by themselves, so nothing here
   * learns when they arrive. Anyone may ask, because settleIfHeld only submits
   * once the preparation has landed and the money is on the trustline, and the
   * per-account limit keeps a caller from turning that into balance polling at
   * our expense.
   */
  async function settle(
    body: SettleBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    const destination = body.destination;
    if (typeof destination !== "string" || !settlesOnStellar(destination)) {
      await answer(
        res,
        400,
        { error: "That is not a usable Stellar address.", retryable: false },
        origin,
      );
      return;
    }

    // Answered before the limit: with nothing to submit the answer costs a map
    // lookup, and a page asking right after a repayment should hear about it.
    if ((await liveSettlement(destination)) === undefined) {
      const settledHash = settledRecently(destination);
      if (settledHash !== undefined) {
        await answer(res, 200, { settled: true, settlementTxHash: settledHash }, origin);
        return;
      }
      await answer(
        res,
        404,
        { error: "No settlement is held for that account.", retryable: false },
        origin,
      );
      return;
    }

    const now = nowUnix();
    for (const [account, at] of lastSettleCall) {
      if (at + SETTLE_INTERVAL_SECONDS <= now) lastSettleCall.delete(account);
    }
    if (lastSettleCall.has(destination)) {
      await answer(
        res,
        429,
        { error: "That account was asked about moments ago. Try again shortly.", retryable: true },
        origin,
      );
      return;
    }
    lastSettleCall.set(destination, now);

    await answer(res, 200, await settleIfHeld(destination), origin);
  }

  /**
   * Finish an overdue conversion on arrival. Safe to call any number of times:
   * the endpoint runs a queued message once and refuses every later attempt.
   */
  async function compose(
    body: ComposeBody,
    res: ServerResponse,
    origin: string | undefined,
    client: string,
  ): Promise<void> {
    // An account paying its own way also runs its own compose (lz_compose is
    // permissionless), so a sponsor in that mode spends nothing here.
    if (reserveFunding === "self") {
      reply(
        res,
        409,
        {
          error:
            "This sponsor does not pay to finish conversions right now: the receiving " +
            "account's own wallet runs it.",
          retryable: false,
        },
        origin,
      );
      return;
    }
    if (composer === undefined) {
      reply(
        res,
        404,
        { error: "This sponsor finishes no conversions on arrival.", retryable: false },
        origin,
      );
      return;
    }
    let request: ReturnType<typeof parseComposeRequest>;
    try {
      request = parseComposeRequest(body as Parameters<typeof parseComposeRequest>[0]);
    } catch (cause) {
      if (cause instanceof ComposeRefused) {
        reply(res, 400, { error: cause.message, retryable: false }, origin);
        return;
      }
      throw cause;
    }
    const key = request.guid;
    {
      const now = nowUnix();
      for (const [guid, at] of lastComposeCall) {
        if (at + COMPOSE_INTERVAL_SECONDS <= now) lastComposeCall.delete(guid);
      }
      while (recentComposes.length > 0 && (recentComposes[0] ?? 0) + 60 <= now) {
        recentComposes.shift();
      }
      if (composing.has(key) || lastComposeCall.has(key)) {
        reply(
          res,
          429,
          {
            error: "This conversion was asked about moments ago. Try again shortly.",
            retryable: true,
          },
          origin,
        );
        return;
      }
      // each finish is paid for, so one client gets a few a minute, counted by
      // the same client address every other limit uses
      if (!composesPerClient.allow(client, Date.now())) {
        reply(
          res,
          429,
          {
            error: "Too many conversions finished from this address. Try again in a minute.",
            retryable: true,
          },
          origin,
        );
        return;
      }
    }
    // Only a message the endpoint really holds is worth a place in the minute's
    // cap: invented guids would otherwise fill it and turn real finishes away.
    let slot: Awaited<ReturnType<Composer["slot"]>>;
    try {
      slot = await composer.slot(request);
    } catch (cause) {
      if (cause instanceof ComposeRefused) {
        reply(res, 400, { error: cause.message, retryable: false }, origin);
        return;
      }
      throw cause;
    }
    if (slot !== "queued") {
      reply(res, slot === "not-queued" ? 404 : 200, { kind: slot }, origin);
      return;
    }
    {
      const now = nowUnix();
      if (recentComposes.length >= COMPOSES_PER_MINUTE) {
        reply(
          res,
          429,
          {
            error: "Too many conversions are being finished right now. Try again shortly.",
            retryable: true,
          },
          origin,
        );
        return;
      }
      lastComposeCall.set(key, now);
      recentComposes.push(now);
    }
    composing.add(key);
    try {
      const outcome = await composer.finish(request);
      reply(res, outcome.kind === "not-queued" ? 404 : 200, { ...outcome }, origin);
    } catch (cause) {
      if (cause instanceof ComposeRefused) {
        reply(res, 400, { error: cause.message, retryable: false }, origin);
        return;
      }
      throw cause;
    } finally {
      composing.delete(key);
    }
  }

  /** Trigger the mint for an attested burn. Idempotent; retrying is always safe. */
  async function deliver(
    body: DeliverBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    // An account paying its own reserve also signs and pays its own delivery,
    // so a sponsor in that mode spends nothing here, whoever asks.
    if (reserveFunding === "self") {
      await answer(
        res,
        409,
        {
          error:
            "This sponsor does not pay for deliveries right now: the receiving account " +
            "signs and pays its own.",
          retryable: false,
        },
        origin,
      );
      return;
    }
    if (
      typeof body.txHash !== "string" ||
      !TX_HASH.some((form) => form.test(body.txHash as string))
    ) {
      await answer(
        res,
        400,
        { error: "Say which transaction to deliver.", retryable: false },
        origin,
      );
      return;
    }
    const domain = body.domain;
    if (typeof domain !== "number" || !sourceDomains.has(domain)) {
      await answer(
        res,
        400,
        { error: "That is not a chain this sponsor delivers from.", retryable: false },
        origin,
      );
      return;
    }

    const unavailable = (): Promise<void> =>
      answer(
        res,
        502,
        { error: "Circle's attestation service did not answer usefully.", retryable: true },
        origin,
      );
    let iris: Response;
    try {
      iris = await fetch(
        `${options.irisUrl}/v2/messages/${domain}?transactionHash=${encodeURIComponent(body.txHash)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (cause) {
      console.error(
        "[sponsor] iris could not be reached:",
        cause instanceof Error ? cause.message : cause,
      );
      await unavailable();
      return;
    }
    if (iris.status === 404) {
      await answer(
        res,
        404,
        { error: "Circle has no attested record of that transaction yet.", retryable: true },
        origin,
      );
      return;
    }
    if (!iris.ok) {
      console.error("[sponsor] iris answered", iris.status);
      await unavailable();
      return;
    }
    let parsed: { messages?: readonly { message?: string; attestation?: string }[] };
    try {
      parsed = (await iris.json()) as typeof parsed;
    } catch (cause) {
      console.error("[sponsor] iris answered with something that is not JSON", cause);
      await unavailable();
      return;
    }
    const message = parsed?.messages?.[0];
    if (typeof message?.message !== "string" || typeof message.attestation !== "string") {
      await answer(
        res,
        404,
        { error: "Circle has no attested record of that transaction yet.", retryable: true },
        origin,
      );
      return;
    }

    // Paying to deliver dust is how a stream of tiny burns spends the
    // sponsor's XLM, so below the floor nothing is paid. An attested message
    // whose amount cannot be read is refused the same way: this is the one
    // place the sponsor spends on a stranger's say-so.
    if (message.attestation !== "PENDING") {
      const minted = mintedAmount(message.message);
      if (minted === undefined || minted < minDelivery) {
        await answer(
          res,
          400,
          {
            error:
              minted === undefined
                ? "Circle's record of that transfer has no amount this sponsor can read, so it will not pay to deliver it."
                : `This sponsor delivers Circle transfers of at least ${usdcText(minDelivery)} USDC, ` +
                  `and this one mints ${usdcText(minted)} USDC.`,
            retryable: false,
          },
          origin,
        );
        return;
      }
    }

    const outcome: DeliveryOutcome = await deliverer.deliver({
      messageHex: message.message,
      attestationHex: message.attestation,
    });

    // The lateness rule's payoff: the settlement was signed before anything
    // moved, and the moment the delivery lands it is submitted, releasing the
    // sponsor's capital in the same breath. Only for the account Circle
    // attested: a destination named in the request is the caller's claim, and
    // settling on it would spend a stranger's arrival on someone else's loan.
    const recipient = attestedRecipient(message.message, domain, expected);
    const settled =
      (outcome.kind === "delivered" || outcome.kind === "already-delivered") &&
      recipient !== undefined
        ? await settleIfHeld(recipient)
        : {};

    await answer(
      res,
      outcome.kind === "recipient-not-ready" ? 409 : 200,
      { ...outcome, ...settled },
      origin,
    );
  }
}

/**
 * A refusal caused by the request itself, carrying the status to answer with.
 * The message is written for the caller, so it is safe to send as is.
 */
class RequestError extends MavnaError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message, { retryable: false });
    this.name = "RequestError";
    this.status = status;
  }
}

/**
 * Read a JSON object body, refusing anything past `limit` bytes. Every route
 * here takes a few hundred bytes at most, and an unbounded read lets one client
 * hold as much of our memory as it cares to send. Past the limit the rest of the
 * body is drained unread, so the answer still reaches the caller.
 */
function readJson(req: IncomingMessage, limit = 65_536): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new RequestError("The request body is too large.", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (refused) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new RequestError("The request body is not JSON.", 400));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new RequestError("The request body must be a JSON object.", 400));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
  });
}

/** Decode a transaction from the wire, where anything at all may arrive. */
function parseTransaction(
  xdrText: unknown,
  passphrase: string,
): ReturnType<typeof TransactionBuilder.fromXDR> {
  if (typeof xdrText !== "string") {
    throw new RequestError("That is not a Stellar transaction.", 400);
  }
  try {
    return TransactionBuilder.fromXDR(xdrText, passphrase);
  } catch {
    throw new RequestError("That is not a Stellar transaction.", 400);
  }
}

const nowUnix = (): number => Math.floor(Date.now() / 1000);

/**
 * What an honest burn into Stellar through the forwarder looks like, as the
 * 32-byte fields Circle's transmitter writes. Source TokenMessengers are keyed
 * by domain; a domain with none in the adapter's config is absent, and a
 * message from it settles nothing.
 */
interface ExpectedMessageFields {
  readonly stellarDomain: number;
  readonly sourceMessengers: ReadonlyMap<number, Uint8Array>;
  readonly stellarMessenger: Uint8Array;
  readonly forwarder: Uint8Array;
}

function expectedMessageFields(networkId: "testnet" | "mainnet"): ExpectedMessageFields {
  const sourceMessengers = new Map<number, Uint8Array>();
  for (const deployment of Object.values(EVM_DEPLOYMENTS[networkId])) {
    sourceMessengers.set(deployment.domain, leftPad32(fromHex(deployment.tokenMessengerV2)));
  }
  for (const chain of Object.values(NON_EVM_CHAINS[networkId])) {
    if (chain.family === "solana") {
      sourceMessengers.set(
        chain.domain,
        solanaAddressToBytes32(SOLANA_PROGRAMS.tokenMessengerMinterV2),
      );
    }
    if (chain.family === "starknet") {
      sourceMessengers.set(
        chain.domain,
        leftPad32(fromHex(STARKNET_DEPLOYMENTS[networkId].tokenMessengerMinterV2)),
      );
    }
  }
  return {
    stellarDomain: stellarDomainFor(networkId),
    sourceMessengers,
    stellarMessenger: contractAddressToBytes32(CCTP_CONTRACTS[networkId].tokenMessengerMinter),
    forwarder: contractAddressToBytes32(CCTP_CONTRACTS[networkId].cctpForwarder),
  };
}

/** An address shorter than a word, as CCTP carries it: zeros on the left. */
function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new MavnaError("An address longer than 32 bytes cannot be a CCTP word.", {
      retryable: false,
    });
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** Where the body starts in a CCTP v2 message, per Circle's MessageV2. */
const MESSAGE_BODY_INDEX = 148;
/** Where the hook data starts in a v2 burn body, per Circle's BurnMessageV2. */
const HOOK_DATA_INDEX = 228;

/**
 * The Stellar recipient Circle attested to, read from the hook data at the end
 * of the burn body, for a message that is provably a burn by the source
 * TokenMessenger, to Stellar's TokenMessenger, minted to and callable only by
 * the forwarder. Anything else is undefined and settles nothing: Circle signs
 * every message, including a burn whose hook data names someone else's account
 * while paying somewhere it cannot reach them. Delivery does not depend on this.
 */
function attestedRecipient(
  messageHex: string,
  sourceDomain: number,
  expected: ExpectedMessageFields,
): string | undefined {
  try {
    const message = fromHex(messageHex);
    if (message.length < MESSAGE_BODY_INDEX + HOOK_DATA_INDEX) return undefined;
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const word = (at: number): Uint8Array => message.subarray(at, at + 32);
    const sourceMessenger = expected.sourceMessengers.get(sourceDomain);
    if (
      sourceMessenger === undefined ||
      view.getUint32(4, false) !== sourceDomain ||
      view.getUint32(8, false) !== expected.stellarDomain ||
      !sameBytes(word(44), sourceMessenger) ||
      !sameBytes(word(76), expected.stellarMessenger) ||
      !sameBytes(word(108), expected.forwarder) ||
      !sameBytes(word(MESSAGE_BODY_INDEX + 36), expected.forwarder)
    ) {
      return undefined;
    }
    return parseForwarderHookData(message.subarray(MESSAGE_BODY_INDEX + HOOK_DATA_INDEX)).recipient;
  } catch (cause) {
    console.error(
      "[sponsor] attested message has no readable recipient:",
      cause instanceof Error ? cause.message : cause,
    );
    return undefined;
  }
}

/** Where the amount and the fee Circle took sit in a v2 burn body. */
const BURN_AMOUNT_INDEX = 68;
const BURN_FEE_EXECUTED_INDEX = 164;

/**
 * What a burn mints on Stellar, in the source token's base units: the amount
 * burned less the fee Circle executed, both from the attested burn body.
 * Undefined when the message is too short to be a v2 burn or the fee exceeds
 * the amount.
 */
function mintedAmount(messageHex: string): bigint | undefined {
  let message: Uint8Array;
  try {
    message = fromHex(messageHex);
  } catch {
    return undefined;
  }
  if (message.length < MESSAGE_BODY_INDEX + HOOK_DATA_INDEX) return undefined;
  const uint = (at: number): bigint =>
    BigInt(`0x${Buffer.from(message.subarray(at, at + 32)).toString("hex")}`);
  const amount = uint(MESSAGE_BODY_INDEX + BURN_AMOUNT_INDEX);
  const fee = uint(MESSAGE_BODY_INDEX + BURN_FEE_EXECUTED_INDEX);
  return fee > amount ? undefined : amount - fee;
}

/** USDC base units at six decimals, as a person reads them. */
function usdcText(baseUnits: bigint): string {
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${baseUnits / 1_000_000n}` : `${baseUnits / 1_000_000n}.${fraction}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The source transaction id forms CCTP chains use: an EVM hash, a Solana
 * signature in base58, or a Starknet felt, which may drop leading zeros.
 */
const TX_HASH: readonly RegExp[] = [
  /^0x[0-9a-fA-F]{64}$/,
  /^[1-9A-HJ-NP-Za-km-z]{64,90}$/,
  /^0x[0-9a-fA-F]{1,64}$/,
];

/**
 * How long one attempt waits to see a settlement included. Its time bound is
 * a day away, and waiting that long would hold the account's claim and a
 * request open for nothing: the next sweep or /settle sends it again, and the
 * network answers that as a duplicate or, once it landed, a spent sequence.
 */
const SETTLEMENT_WAIT_SECONDS = 120;

/** How often one account's held settlement may be asked for through /settle. */
const SETTLE_INTERVAL_SECONDS = 30;
/** How often one message may be asked to finish, and how many finishes a minute in all. */
const COMPOSE_INTERVAL_SECONDS = 30;
/** Finishes one client address may ask the sponsor to pay for in a minute. */
const COMPOSES_PER_CLIENT_PER_MINUTE = 3;
const COMPOSES_PER_MINUTE = 10;
/** Daily, well inside the thirty days KEEP_ALIVE_LEDGERS buys. */
const KEEP_ALIVE_EVERY_MS = 24 * 60 * 60 * 1000;

/** A whole day, as the builder defaults to: Circle's standard transfer has no ceiling. */
const SETTLEMENT_VALIDITY_SECONDS = 86_400;

/**
 * How long a channel is held for a settlement nobody has signed yet. Long
 * enough for a person to read and sign in their wallet, short enough that an
 * abandoned or hostile request gives the slot back within minutes.
 */
const PROVISIONAL_LEASE_SECONDS = 300;

/**
 * Whether an address is one a settlement can be held for: an account or muxed
 * account, which holds its balance on a trustline. Anything else, including a
 * secret key sent by mistake, is not.
 */
function settlesOnStellar(address: string): boolean {
  try {
    return classifyAddress(address).needsTrustline;
  } catch {
    return false;
  }
}

/**
 * The account whose signature a built transaction still needs. A muxed address
 * is signed for by the account it wraps, and an account about to be created
 * signs too, because it owns the trustline being opened.
 */
function signerFor(destination: string): string {
  return classifyAddress(destination).trustlineHolder ?? destination;
}

/** What a preparation sponsors, in the terms a settlement records what it repays. */
function sponsoredBy(transaction: Transaction): Repayment {
  return {
    createdAccount: transaction.operations.some((op) => op.type === "createAccount"),
    assets: transaction.operations.flatMap((op) =>
      op.type === "changeTrust" ? [op.line.toString()] : [],
    ),
  };
}

function sameRepayment(a: Repayment, b: Repayment): boolean {
  const key = (r: Repayment): string => [...r.assets].sort().join("\n");
  return a.createdAccount === b.createdAccount && key(a) === key(b);
}

/**
 * When the server stops honouring what it built. Both builders set a time
 * bound; one without would sit in the ledger forever, so that is refused.
 */
function expiryOf(transaction: Transaction): number {
  const maxTime = Number(transaction.timeBounds?.maxTime ?? 0);
  if (!(maxTime > 0)) {
    throw new MavnaError("A built transaction has no time bound.", { retryable: false });
  }
  return maxTime;
}

/** Horizon's decimal form to stroops, integer arithmetic only. */
function decimalToStroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (match === null) {
    throw new MavnaError(`Not a Stellar amount: ${amount}`, { retryable: false });
  }
  return BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

/** Stroops to Horizon's decimal form, integer arithmetic only. */
function stroopsToDecimal(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/**
 * Whether an account exists, from a node that has caught up. Only a definite
 * absence is false: a read that failed is thrown, because guessing "missing"
 * would build a settlement and preparation for an account creation that is not
 * needed.
 */
async function accountExists(rpc: RpcClient, address: string): Promise<boolean> {
  try {
    await rpc.loadAccount(address);
    return true;
  } catch (cause) {
    if (cause instanceof AccountNotFound) return false;
    throw cause;
  }
}
