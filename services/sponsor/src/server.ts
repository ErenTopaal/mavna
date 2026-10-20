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
  readAccountEntry,
  SubmitRejected,
  spareStroops,
  stroopsToXlm,
  XlmPriceSource,
} from "@mavna/stellar";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import * as z from "zod";
import {
  type BuiltChange,
  BuiltLedger,
  type BuiltRecord,
  type Repayment,
  signedBy,
} from "./built.js";
import { type CapDecision, CapLedger } from "./caps.js";
import {
  type Channel,
  ChannelPool,
  type ChannelPoolSnapshot,
  type LeaseRecord,
} from "./channels.js";
import { ComposeRefused, Composer, parseComposeRequest } from "./compose.js";
import type { ReserveFunding } from "./config.js";
import {
  Deliverer,
  DeliveryBudgetSpent,
  DeliveryFailedOnChain,
  type DeliveryOutcome,
  DeliveryOutcomeUnknown,
} from "./deliver.js";
import { DeliveryBudget } from "./delivery-budget.js";
import { clientAddress, RequestLimiter } from "./ratelimit.js";
import {
  type ChainSponsorshipView,
  HorizonSponsorshipView,
  reconcile,
  type SponsoredRecord,
} from "./reconcile.js";
import type { SoroswapProxy } from "./soroswap.js";
import { DirectSpendQuote } from "./spend.js";
import {
  DocumentCapStore,
  type DocumentStore,
  MemoryDocumentStore,
  UnreadableState,
} from "./state.js";

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
  /**
   * How many settlements nothing has backed yet may hold a channel at once,
   * across every client. Sixteen by default. With the daily caps it sizes the
   * pool the server funds for itself: see `poolLimit`.
   */
  readonly provisionalSettlements?: number;
  /**
   * Channels the server keeps for itself however long they sit idle. Above it,
   * a channel idle for a day is merged back into the sponsor. Four by default.
   */
  readonly channelFloor?: number;
  /**
   * Settlements one client address may have waiting on a channel at once,
   * before anything backs them. Zero turns the limit off. Two by default.
   */
  readonly settlementsPerClient?: number;
  /** Prices the reserve in the arriving asset, for the settlement's ceiling. */
  readonly prices?: XlmPriceSource;
  /**
   * The chain's view of what the sponsor carries, for the hourly cross-check
   * against its own records. Horizon's, for this network, when not given.
   */
  readonly sponsorshipView?: ChainSponsorshipView;
  /**
   * How many burns Circle had not attested yet the sweep keeps asking about,
   * per client address and in all. 8 and 1,000 by default.
   */
  readonly watchLimits?: { readonly perClient: number; readonly total: number };
  /** Quotes what a settlement's direct path spends now, for the balance check. */
  readonly spendQuote?: DirectSpendQuote;
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
  /**
   * What the sponsor may spend on delivery fees in one UTC day, in stroops,
   * counted in the state store. 25 XLM by default; zero pays for none.
   */
  readonly deliveryBudgetStroops?: bigint;
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

/**
 * A source chain id as the widget sends it, such as "base" or "1". It is written
 * into stored state and read back on every start, so anything else is refused
 * here rather than trusted to be a string later.
 */
const chainIdField = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** Long enough for a muxed address; the address checks themselves come later. */
const addressField = z.string().min(1).max(128);
/** Every route takes a few hundred bytes; the body limit bounds this anyway. */
const xdrField = z.string().min(1).max(60_000);

/**
 * What each route accepts, checked before anything is read from it. A field of
 * the wrong type is the caller's mistake and answered with 400; nothing it
 * carries reaches stored state unchecked.
 */
const prepareBody = z.object({
  destination: addressField.optional(),
  assets: z.array(z.string().min(1).max(12)).max(8).optional(),
  sourceChainId: chainIdField.optional(),
});
const submitBody = z.object({ signedXdr: xdrField.optional() });
const settlementBody = z.object({
  destination: addressField.optional(),
  sourceChainId: chainIdField.optional(),
});
const settlementCommitBody = z.object({
  destination: addressField.optional(),
  signedXdr: xdrField.optional(),
});
const settleBody = z.object({ destination: addressField.optional() });
const deliverBody = z.object({
  txHash: z.string().max(200).optional(),
  domain: z.number().int().nonnegative().optional(),
  /**
   * Accepted from older clients and never acted on. Who the transfer is for is
   * read from Circle's attested message, the one source a caller cannot choose.
   */
  destination: z.unknown().optional(),
});

type PrepareBody = z.infer<typeof prepareBody>;
type SubmitBody = z.infer<typeof submitBody>;
type SettlementBody = z.infer<typeof settlementBody>;
type SettlementCommitBody = z.infer<typeof settlementCommitBody>;
type SettleBody = z.infer<typeof settleBody>;
type DeliverBody = z.infer<typeof deliverBody>;

interface ComposeBody {
  readonly from?: unknown;
  readonly guid?: unknown;
  readonly index?: unknown;
  readonly message?: unknown;
}

/** A body in the route's shape, or a 400 naming the first field that is not. */
function bodyOf<T>(schema: z.ZodType<T>, body: Record<string, unknown>): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join(".") ?? "";
  throw new RequestError(
    field === ""
      ? "The request is not in the shape this endpoint reads."
      : `The field "${field}" is not in the shape this endpoint reads.`,
    400,
  );
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
  /**
   * When this settlement was first sent, written down before it went. Once
   * sent it may land unseen, after the wait or across a restart, and spend
   * what the balance check reads, so from then on it is looked up by hash
   * before anything else is decided about it.
   */
  sentAtUnix?: number | undefined;
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
 * The shapes this version writes, checked entry by entry on load. An entry in
 * another shape, from another version or edited by hand, is logged, set aside
 * in the "rejected" document and skipped, so one bad record cannot keep the
 * service from starting; the rest load as written.
 */
const repaymentShape = z.object({
  createdAccount: z.boolean(),
  assets: z.array(z.string()),
});
const builtShape = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["preparation", "settlement"]),
  destination: z.string(),
  signer: z.string(),
  sourceChainId: chainIdField,
  expiresAtUnix: z.number().int(),
  openUntilUnix: z.number().int().optional(),
  channel: z.string().optional(),
  repays: repaymentShape.optional(),
  selfFunded: z.boolean().optional(),
});
const heldShape = z.object({
  xdr: z.string(),
  createdAtUnix: z.number().int(),
  sourceChainId: chainIdField,
  channel: z.string().optional(),
  maxTimeUnix: z.number().int(),
  repays: repaymentShape,
  prepared: z.boolean(),
  preparation: z.object({ hash: z.string(), expiresAtUnix: z.number().int() }).optional(),
  sentAtUnix: z.number().int().optional(),
});
const builtChangeShape = z.union([
  z.object({ add: builtShape }),
  z.object({ drop: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
const settledShape = z.object({ txHash: z.string(), untilUnix: z.number().int() });
const secretShape = z.string().refine((value) => StrKey.isValidEd25519SecretSeed(value));
const leaseShape = z.object({
  owner: z.string(),
  channel: z.string(),
  untilUnix: z.number().int(),
});
const documentShapes = {
  built: z.array(z.unknown()),
  held: z.object({
    held: z.record(z.string(), z.unknown()),
    settled: z.record(z.string(), z.unknown()),
  }),
  channels: z.object({
    secrets: z.array(z.unknown()),
    leases: z.array(z.unknown()),
    pending: z.unknown().optional(),
  }),
} as const;

const networkShape = z.object({ passphrase: z.string() });

/** What load set aside, by document, written once so nothing is lost. */
type Rejected = Record<string, { atUnix: number; entry?: string; value: unknown }[]>;

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
  const provisionalLimit = options.provisionalSettlements ?? DEFAULT_PROVISIONAL_SETTLEMENTS;
  const perClient = options.settlementsPerClient ?? DEFAULT_SETTLEMENTS_PER_CLIENT;
  const channelFloor = options.channelFloor ?? DEFAULT_CHANNEL_FLOOR;
  if (!Number.isSafeInteger(channelFloor) || channelFloor < 0) {
    throw new Error(`The channel floor must be a whole number; got ${channelFloor}.`);
  }
  for (const [name, value, least] of [
    ["number of provisional settlements", provisionalLimit, 1],
    ["settlements per client", perClient, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < least) {
      throw new Error(`The ${name} must be a whole number of at least ${least}; got ${value}.`);
    }
  }
  /**
   * The client address that asked for each account's lease. A settlement costs
   * its caller nothing until a preparation backs it, so the leases one address
   * may hold that way are counted against it. Pruned to live leases on every use.
   */
  const leaseClients = new Map<string, string>();
  /**
   * When each account's unbacked lease began, until it is backed or released.
   * One that lapsed unbacked cannot be taken again straight away, so an account
   * cannot hold a channel indefinitely by asking again as each one lapses.
   */
  const provisionalSince = new Map<string, number>();

  /**
   * Burns asked about before Circle attested them, by domain and hash. A page
   * closed while Circle attests would otherwise leave the burn undelivered,
   * and a held settlement for its recipient would run to its time bound, so
   * the sweep keeps asking until it lands, is found delivered, can never be
   * paid for, or is two days old. Written down with the rest of the state.
   */
  const watch = new Map<string, WatchEntry>();
  const watchLimits = options.watchLimits ?? DEFAULT_WATCH_LIMITS;

  /**
   * The channels the server may fund for itself. A landed preparation holds
   * its channel for at most the settlement's day, and the caps let at most
   * `dailyStartLimit` start in a UTC day, so no more than twice that are held
   * at once (a day's window spans two UTC days). Unbacked leases are at most
   * `provisionalLimit`. Within the caps the pool therefore never runs out.
   */
  function poolLimit(): number {
    return options.channels !== undefined
      ? options.channels.size
      : 2 * caps.dailyStartLimit() + provisionalLimit;
  }
  const composesPerClient = new RequestLimiter(COMPOSES_PER_CLIENT_PER_MINUTE);
  const deliverer = new Deliverer({
    budget: new DeliveryBudget(
      state,
      options.deliveryBudgetStroops ?? DEFAULT_DELIVERY_BUDGET_STROOPS,
    ),
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
  // from costing simulations and fees: per message, per client address (the same
  // one every limit uses, so MAVNA_TRUST_PROXY decides it), and overall.
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
    // Nothing backs a settlement before its preparation, so its lease stays
    // short; once that lapses the channel is someone else's and so is the
    // sequence this one was built on. Dropped, and no stranding: nothing went out.
    if (
      !held.prepared &&
      !held.preparing &&
      held.preparation === undefined &&
      held.channel !== undefined &&
      channels !== undefined &&
      !channels.holds(destination, held.channel, nowUnix())
    ) {
      heldSettlements.delete(destination);
      await persist();
      return undefined;
    }
    if (held.maxTimeUnix <= nowUnix()) {
      // Sent before its bound, so it may have landed unseen: that is a
      // repayment, not a stranding, and only the ledger can say which.
      if (held.prepared && held.sentAtUnix !== undefined) {
        let found: Awaited<ReturnType<RpcClient["findTransaction"]>>;
        try {
          found = await options.rpc.findTransaction(settlementHash(held));
        } catch (cause) {
          // kept, unusable, for the next touch to ask again
          console.error(
            `[sponsor] could not look up the expired settlement sent for ${destination}:`,
            cause instanceof Error ? cause.message : cause,
          );
          return undefined;
        }
        if (heldSettlements.get(destination) !== held) return heldSettlements.get(destination);
        if (found.status === "SUCCESS") {
          heldSettlements.delete(destination);
          if (held.channel !== undefined) channels?.release(destination, held.channel);
          pruneSettled();
          recentlySettled.set(destination, {
            txHash: settlementHash(held),
            untilUnix: nowUnix() + LATE_REPAYMENT_REPORTED_SECONDS,
          });
          await persist();
          return undefined;
        }
      }
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
      backedByLanding(destination, held);
      await persist();
      return;
    }
    if (found.status === "FAILED" || sent.expiresAtUnix + PREPARATION_GRACE_SECONDS < nowUnix()) {
      held.preparation = undefined;
      shortenLease(destination, held);
      await persist();
    }
  }

  /**
   * Refuse to build while the ledger of open builds is full. Every build is
   * written down until it closes, so this is the ceiling on what anonymous
   * requests can make the sponsor carry, and it clears as builds close.
   */
  async function busyBuilding(
    res: ServerResponse,
    origin: string | undefined,
    client: string,
  ): Promise<boolean> {
    // One client's share first, so a few clients cannot fill the whole ledger
    // and turn everyone else away.
    if (built.openFor(client, nowUnix()) >= OPEN_BUILDS_PER_CLIENT) {
      await answer(
        res,
        429,
        {
          error:
            "This address has asked for many transactions it has not signed yet. Finish or " +
            "abandon some, then try again.",
          retryable: true,
        },
        origin,
      );
      return true;
    }
    if (!built.full(nowUnix())) return false;
    console.error("[sponsor] the ledger of open builds is full; refusing to build more for now");
    await answer(
      res,
      503,
      { error: "This sponsor is building too much at once. Try again shortly.", retryable: true },
      origin,
    );
    return true;
  }

  /** The hash a held settlement lands under; its signatures do not change it. */
  function settlementHash(held: { readonly xdr: string }): string {
    return xdr.encodeBytes(
      TransactionBuilder.fromXdr(held.xdr, options.network.passphrase).hash(),
      "hex",
    );
  }

  /**
   * A preparation landed: the sponsor's reserve is out against this settlement
   * and counted against the day's caps, so its channel is now held to the
   * settlement's own bound. The one place a lease is lengthened.
   */
  function backedByLanding(account: string, held: HeldSettlement): void {
    provisionalSince.delete(account);
    if (held.channel === undefined || channels === undefined) return;
    if (!channels.extend(account, held.channel, held.maxTimeUnix, nowUnix())) {
      // the lease is kept while anything is in flight or landed on it, so this
      // means it was lost some other way; said, since the loan now rides on it
      console.error(
        `[sponsor] a preparation landed for ${account}, and its settlement's channel ` +
          `${held.channel} is no longer leased to it`,
      );
    }
  }

  /** Whether a landed preparation backs the account's held settlement. */
  function landed(account: string): boolean {
    return heldSettlements.get(account)?.prepared === true;
  }

  /** Whether a preparation is on its way for the account's held settlement. */
  function inFlight(account: string): boolean {
    const held = heldSettlements.get(account);
    return held !== undefined && (held.preparing || held.preparation !== undefined);
  }

  /** Whether a preparation backs the account's held settlement, landed or on its way. */
  function backed(account: string): boolean {
    const held = heldSettlements.get(account);
    return (
      held !== undefined && (held.prepared || held.preparing || held.preparation !== undefined)
    );
  }

  /**
   * A preparation refused on its sequence, looked up by hash: the landed result
   * if it is what spent the sequence, undefined if it is not. A lookup that
   * fails throws, which leaves the preparation marked for the next touch to
   * look up again.
   */
  async function preparationLanded(
    hash: string,
  ): Promise<Awaited<ReturnType<RpcClient["submit"]>> | undefined> {
    const found = await options.rpc.findTransaction(hash);
    return found.status === "SUCCESS" ? found : undefined;
  }

  /**
   * Back to the short lease, for a settlement whose preparation definitely did
   * not land: the account may try once more, but the slot is not kept for it.
   */
  function shortenLease(destination: string, held: HeldSettlement): void {
    if (held.channel === undefined || channels === undefined) return;
    channels.limit(destination, held.channel, nowUnix() + PROVISIONAL_LEASE_SECONDS);
  }

  /**
   * State is one network's: channel keys, leases, held settlements and cap
   * counts mean nothing on another, and acted on there they fail every
   * settlement. So the network is written down with them, and a sponsor started
   * on another network against the same directory refuses to start.
   */
  async function checkNetwork(
    reject: (name: string, value: unknown, entry?: string) => void,
  ): Promise<void> {
    const passphrase = options.network.passphrase;
    const recorded = await state.read("network");
    const parsed = networkShape.safeParse(recorded);
    if (parsed.success) {
      if (parsed.data.passphrase === passphrase) return;
      throw new Error(
        `The sponsor's stored state was written for ${parsed.data.passphrase}, and this ` +
          `sponsor runs on ${passphrase} (MAVNA_NETWORK). Give each network its own ` +
          "MAVNA_STATE_DIR.",
      );
    }
    if (recorded !== undefined) {
      reject("network", recorded);
    } else {
      const names = ["built", "held", "channels", "caps"] as const;
      // a document too damaged to read still says state was written here
      const existing = await Promise.all(
        names.map((name) =>
          state.read(name).catch((cause: unknown) => {
            if (cause instanceof UnreadableState) return true;
            throw cause;
          }),
        ),
      );
      if (existing.some((value) => value !== undefined)) {
        // written by a version that did not record its network; the deployment
        // that wrote it is the one starting now, on the network it was set up for
        console.error(
          `[sponsor] the stored state has no network recorded; taking it as ${passphrase}'s.`,
        );
      }
    }
    await state.write("network", { passphrase });
  }

  /** What is written down, read back. Runs once, before the first request. */
  async function load(): Promise<void> {
    const now = nowUnix();
    const rejected: Rejected = {};
    const reject = (name: string, value: unknown, entry?: string): void => {
      console.error(
        `[sponsor] skipped ${entry === undefined ? "the whole" : `an entry (${entry}) of the`} ` +
          `${name} state: it is not in the shape this version writes. It is kept in rejected.json.`,
      );
      const list = rejected[name] ?? [];
      rejected[name] = list;
      list.push({
        atUnix: now,
        ...(entry === undefined ? {} : { entry }),
        value,
      });
    };
    const documentOf = async <K extends keyof typeof documentShapes>(
      name: K,
    ): Promise<z.infer<(typeof documentShapes)[K]> | undefined> => {
      const value = await state.read(name);
      if (value === undefined) return undefined;
      const parsed = documentShapes[name].safeParse(value);
      if (parsed.success) return parsed.data as z.infer<(typeof documentShapes)[K]>;
      reject(name, value);
      return undefined;
    };

    await checkNetwork(reject);

    const builtLog = await state.readLog("built");
    if (builtLog !== undefined) {
      // replayed in order: what was added, less what was handed out or pushed out
      const open = new Map<string, BuiltRecord>();
      builtLog.forEach((value, index) => {
        const parsed = builtChangeShape.safeParse(value);
        if (!parsed.success) {
          reject("built", value, `log line ${index + 1}`);
        } else if ("add" in parsed.data) {
          const record = stripUndefined(parsed.data.add) as BuiltRecord;
          open.set(record.hash, record);
        } else {
          open.delete(parsed.data.drop);
        }
      });
      built = BuiltLedger.fromSnapshot([...open.values()], now);
    }
    // written by a version that kept the ledger as one document
    const builtDocument = builtLog === undefined ? await documentOf("built") : undefined;
    if (builtDocument !== undefined) {
      const records: BuiltRecord[] = [];
      builtDocument.forEach((value, index) => {
        const parsed = builtShape.safeParse(value);
        if (parsed.success) records.push(stripUndefined(parsed.data) as BuiltRecord);
        else reject("built", value, String(index));
      });
      built = BuiltLedger.fromSnapshot(records, now);
    }

    const heldDocument = await documentOf("held");
    for (const [destination, value] of Object.entries(heldDocument?.held ?? {})) {
      const parsed = heldShape.safeParse(value);
      if (!parsed.success || !settlesOnStellar(destination)) {
        reject("held", value, destination);
        continue;
      }
      const { channel, preparation, ...rest } = parsed.data;
      // written by the address as sent before held settlements were keyed by
      // account; the account is the key now
      const account = signerFor(destination);
      if (heldSettlements.has(account)) {
        // one account written under two spellings: the first is kept
        reject("held", value, destination);
        continue;
      }
      heldSettlements.set(account, {
        ...rest,
        channel,
        preparation,
        preparing: false,
      });
    }
    for (const [destination, value] of Object.entries(heldDocument?.settled ?? {})) {
      const parsed = settledShape.safeParse(value);
      if (parsed.success) recentlySettled.set(destination, parsed.data);
      else reject("held", value, `settled ${destination}`);
    }

    const channelDocument = await documentOf("channels");
    if (channelDocument !== undefined) {
      const secrets: string[] = [];
      channelDocument.secrets.forEach((value, index) => {
        if (secretShape.safeParse(value).success) secrets.push(value as string);
        else reject("channels", value, `secret ${index}`);
      });
      const leases: LeaseRecord[] = [];
      channelDocument.leases.forEach((value, index) => {
        const parsed = leaseShape.safeParse(value);
        if (parsed.success && settlesOnStellar(parsed.data.owner)) {
          // by account, as the held settlements are
          leases.push({ ...parsed.data, owner: signerFor(parsed.data.owner) });
        } else {
          reject("channels", value, `lease ${index}`);
        }
      });
      if (channels !== undefined) {
        adopt(channels).restoreLeases(leases, now);
      } else if (secrets.length > 0) {
        channels = adopt(ChannelPool.fromSnapshot({ secrets, leases }, now, keptLease));
      }
      const pending = channelDocument.pending;
      if (pending !== undefined && !secretShape.safeParse(pending).success) {
        reject("channels", pending, "pending");
      } else if (pending !== undefined && options.channels === undefined) {
        // a channel whose funding was under way when the process stopped,
        // finished on the next need for one
        pendingChannel = Keypair.fromSecret(pending as string);
      }
    }

    const watchDocument = await state.read("delivery-watch");
    if (watchDocument !== undefined) {
      const parsed = watchDocumentShape.safeParse(watchDocument);
      if (!parsed.success) {
        reject("delivery-watch", watchDocument);
      } else {
        parsed.data.entries.forEach((value, index) => {
          const entry = watchEntryShape.safeParse(value);
          if (entry.success && sourceDomains.has(entry.data.domain)) {
            watch.set(watchKey(entry.data.txHash, entry.data.domain), entry.data);
          } else {
            reject("delivery-watch", value, String(index));
          }
        });
      }
    }

    // From here every change is appended, onto a log of just what is open.
    built.watch(logBuilt);
    compactBuilt();
    await builtWrites;

    if (Object.keys(rejected).length > 0) {
      // added to what earlier starts set aside, never written over it
      const before = ((await state.read("rejected")) ?? {}) as Rejected;
      const merged: Rejected = { ...before };
      for (const [name, entries] of Object.entries(rejected)) {
        merged[name] = [...(Array.isArray(before[name]) ? before[name] : []), ...entries];
      }
      await state.write("rejected", merged);
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
    // After the built log's own writes, then in this order, one after another: a
    // held settlement names a channel lease, so the lease is on disk before the
    // settlement that relies on it. A crash
    // between them then leaves a lease without a settlement, which lapses
    // harmlessly, never a settlement whose lease could be handed to another.
    const documents: Record<string, unknown> = {
      channels: channelDocument,
      held: { held, settled: Object.fromEntries(recentlySettled) } satisfies HeldDocument,
      "delivery-watch": { entries: [...watch.values()] },
    };
    // Most answers change nothing, and rewriting every file (secrets included)
    // for each anonymous refusal is wasted disk and a wider window for a
    // half-finished write, so only a document that differs is written.
    let chain: Promise<void> = builtWrites;
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
  /**
   * The built log's writes, in order. Each build or hand-out is one appended
   * line rather than the whole ledger rewritten, and every answer waits for
   * what came before it. A failed append is reported to the answer waiting on
   * it, and the next change goes on regardless.
   */
  let builtWrites: Promise<void> = Promise.resolve();
  let appendedSinceCompaction = 0;

  function logBuilt(change: BuiltChange): void {
    appendedSinceCompaction += 1;
    builtWrites = builtWrites.catch(() => {}).then(() => state.append("built", change));
    // rewritten as just what is open once it is mostly history
    if (appendedSinceCompaction > BUILT_LOG_SLACK + 2 * built.size) compactBuilt();
  }

  function compactBuilt(): void {
    appendedSinceCompaction = 0;
    const open = built.snapshot().map((record) => ({ add: record }));
    builtWrites = builtWrites.catch(() => {}).then(() => state.writeLog("built", open));
  }
  const expected = expectedMessageFields(options.networkId);
  /** Circle domains this network routes into Stellar from, and nothing else. */
  const sourceDomains = new Set(
    [
      ...Object.values(EVM_DEPLOYMENTS[options.networkId]),
      ...Object.values(NON_EVM_CHAINS[options.networkId]),
    ].map((chain) => chain.domain),
  );
  let channels = options.channels === undefined ? undefined : adopt(options.channels);
  /** A channel key written down whose funding has not been seen to land. */
  let pendingChannel: Keypair | undefined;
  const horizonUrl =
    options.networkId === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org";
  const sponsorshipView = options.sponsorshipView ?? new HorizonSponsorshipView(horizonUrl);
  const spendQuote = options.spendQuote ?? new DirectSpendQuote({ horizonUrl });
  /** When the last cross-check ran, in milliseconds; it runs at most hourly. */
  let reconciledAtMs: number | undefined;
  const prices = options.prices ?? new XlmPriceSource({ horizonUrl });

  /**
   * The channels this deployment runs on, created and funded as they are
   * needed, up to `poolSize`.
   *
   * 2 XLM each: the account's own 1 XLM minimum plus fee headroom for the
   * settlements it will carry. A funding is shared by every request that
   * arrives while it runs, so two first settlements fund one channel, and
   * forgotten if it fails so the next request tries again.
   */
  let funding: Promise<ChannelPool> | undefined;
  function ensureChannels(): Promise<ChannelPool> {
    // A pool that exists is used as it is: settling and holding must never
    // wait on, or fail with, the funding of another channel.
    if (channels !== undefined) return Promise.resolve(adopt(channels));
    return fundOne();
  }

  /**
   * A lease whose preparation may still land is never reclaimed at its end:
   * reused, its sequence would go to someone else while the reserve is out.
   */
  function adopt(pool: ChannelPool): ChannelPool {
    pool.holdWhile(keptLease);
    return pool;
  }

  /**
   * A lease the pool must not reclaim at its bound: a preparation may still
   * land on it, or one has and the settlement that repays it rides on it.
   */
  function keptLease(owner: string): boolean {
    return inFlight(owner) || landed(owner);
  }

  /** Failed fundings in a row, and when the next may be tried. */
  let fundingFailures = 0;
  let fundingRetryAtMs = 0;

  /**
   * Fund one more channel, unless the last attempt failed moments ago. A
   * funding that fails (the sponsor short of XLM, say) is tried again only
   * after a backoff, never on every request, and it never stands in the way
   * of anything but taking a new slot. The key stays written down, so if the
   * failed attempt did land after all, the retry finds it funded.
   */
  function fundOne(): Promise<ChannelPool> {
    if (Date.now() < fundingRetryAtMs) return Promise.reject(new FundingBackoff());
    funding ??= fundChannel()
      .then(
        (pool) => {
          fundingFailures = 0;
          fundingRetryAtMs = 0;
          return pool;
        },
        (cause: unknown) => {
          fundingFailures += 1;
          const waitMs = Math.min(
            FUNDING_BACKOFF_MS * 2 ** (fundingFailures - 1),
            FUNDING_BACKOFF_MAX_MS,
          );
          fundingRetryAtMs = Date.now() + waitMs;
          console.error(
            `[sponsor] channel funding failed (${fundingFailures} in a row); trying again in ` +
              `${Math.round(waitMs / 1000)} s:`,
            cause instanceof Error ? cause.message : cause,
          );
          throw new FundingBackoff();
        },
      )
      .finally(() => {
        funding = undefined;
      });
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
    if (channels === undefined) channels = new ChannelPool({ channels: [channel] });
    else channels.add(channel);
    pendingChannel = undefined;
    await persist();
    return adopt(channels);
  }

  /** When each free channel was first seen idle, by address. */
  const idleSince = new Map<string, number>();

  /**
   * Merge channels that have sat idle for a day back into the sponsor, while
   * the pool is above its floor. The pool grows to meet the caps' worst case,
   * and without this the XLM moved into it would stay there after the traffic
   * is gone. Only a channel no one leases, that no held settlement names and
   * that carries nothing in flight is merged; it is leased to itself while the
   * merge goes out, so nothing else can take it meanwhile.
   */
  async function shrinkPool(): Promise<void> {
    const pool = channels;
    if (pool === undefined) return;
    const now = nowUnix();
    const free = pool.freeAddresses(now);
    for (const address of [...idleSince.keys()]) {
      if (!free.includes(address)) idleSince.delete(address);
    }
    const named = new Set([...heldSettlements.values()].map((held) => held.channel));
    for (const address of free) {
      if (named.has(address)) continue;
      const since = idleSince.get(address);
      if (since === undefined) {
        idleSince.set(address, now);
        continue;
      }
      if (now - since < CHANNEL_IDLE_MERGE_SECONDS || pool.size <= channelFloor) continue;
      const lease = pool.acquireThis(address, address, now + PROVISIONAL_LEASE_SECONDS, now);
      if (lease === undefined) continue;
      // written down leased before the merge, so a crash leaves it unusable, not reused
      await persist();
      try {
        await mergeChannel(lease.keypair);
        console.error(`[sponsor] merged idle channel ${address} back into the sponsor`);
      } catch (cause) {
        if (!(cause instanceof AccountNotFound)) {
          pool.release(address, address);
          console.error(
            `[sponsor] could not merge idle channel ${address}:`,
            cause instanceof Error ? cause.message : cause,
          );
          continue;
        }
        console.error(`[sponsor] channel ${address} no longer exists; dropping it`);
      }
      pool.drop(address, address);
      idleSince.delete(address);
      await persist();
    }
  }

  /** Send everything a channel holds back to the sponsor, closing the account. */
  async function mergeChannel(channel: Keypair): Promise<void> {
    await options.rpc.submit("channel merge", async () => {
      const account = await options.rpc.loadAccount(channel.publicKey());
      const merge = new TransactionBuilder(account, {
        fee: "1000000",
        networkPassphrase: options.network.passphrase,
      })
        .addOperation(Operation.accountMerge({ destination: keypair.publicKey() }))
        .setTimeout(120)
        .build();
      merge.sign(channel);
      return merge;
    });
  }

  /** Channels being topped up right now, so two asks send one payment. */
  const toppingUp = new Map<string, Promise<void>>();

  /**
   * Bring a channel back to its starting 2 XLM once it falls below 1.5. Each
   * settlement's fee comes out of its channel, and one that cannot pay it is
   * refused before anything else happens, so this keeps every settlement
   * landable. Said in the log each time, which is where the operator sees it.
   */
  function topUpChannel(address: string): Promise<void> {
    const running = toppingUp.get(address);
    if (running !== undefined) return running;
    const work = (async () => {
      const entry = await readAccountEntry(options.rpc, address);
      if (entry === undefined) {
        // gone (merged back before a crash, say): out of the pool while free,
        // so no settlement is ever built on it
        const pool = channels;
        if (pool?.acquireThis(address, address, nowUnix() + 60, nowUnix()) !== undefined) {
          console.error(`[sponsor] channel ${address} no longer exists; dropping it`);
          pool.drop(address, address);
          await persist();
        }
        return;
      }
      const balance = entry.balance;
      if (balance >= CHANNEL_LOW_STROOPS) return;
      const amount = CHANNEL_TOP_UP_TO_STROOPS - balance;
      console.error(
        `[sponsor] channel ${address} is short of XLM (${stroopsToXlm(balance)} XLM); ` +
          `sending it ${stroopsToXlm(amount)} XLM from the sponsor`,
      );
      await options.rpc.submit("channel top-up", async () => {
        const sponsorAccount = await options.rpc.loadAccount(keypair.publicKey());
        const payment = new TransactionBuilder(sponsorAccount, {
          fee: "1000000",
          networkPassphrase: options.network.passphrase,
        })
          .addOperation(
            Operation.payment({
              destination: address,
              asset: Asset.native(),
              amount: stroopsToDecimal(amount),
            }),
          )
          .setTimeout(120)
          .build();
        payment.sign(keypair);
        return payment;
      });
    })().finally(() => toppingUp.delete(address));
    toppingUp.set(address, work);
    return work;
  }

  function logTopUpFailure(address: string): (cause: unknown) => void {
    return (cause) =>
      console.error(
        `[sponsor] could not top up channel ${address}:`,
        cause instanceof Error ? cause.message : cause,
      );
  }

  async function submitChannelFunding(channel: Keypair): Promise<void> {
    // Built inside the thunk, so a retry after a stale sequence (anything else
    // the sponsor signs moves it) is built on the sequence as it is now.
    await options.rpc.submit("channel funding", async () => {
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
      return create;
    });
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
    // in self mode nothing is settled, and the sponsor spends nothing
    for (const address of reserveFunding === "sponsor" ? (channels?.addresses() ?? []) : []) {
      try {
        await topUpChannel(address);
      } catch (cause) {
        logTopUpFailure(address)(cause);
      }
    }
    if (
      reserveFunding === "sponsor" &&
      (reconciledAtMs === undefined || Date.now() - reconciledAtMs >= RECONCILE_EVERY_MS)
    ) {
      reconciledAtMs = Date.now();
      try {
        await reconcileCarried();
      } catch (cause) {
        console.error(
          "[sponsor] could not run the reconciliation:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
    // a snapshot: settling an account removes it from the map mid-loop
    // Burns first: delivering one may let its recipient's settlement go below.
    if (reserveFunding === "sponsor") {
      try {
        await sweepWatched();
      } catch (cause) {
        console.error(
          "[sponsor] could not sweep the watched burns:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
    if (reserveFunding === "sponsor" && options.channels === undefined) {
      try {
        await shrinkPool();
      } catch (cause) {
        console.error(
          "[sponsor] could not return idle channels:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
    const destinations = Array.from(heldSettlements.keys());
    for (const destination of destinations) {
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

  /**
   * What the chain says the sponsor carries, against its own records of what
   * it lent and is still owed, as one log line. A difference is capital it may
   * have lost track of, and strandings stay on the chain's side for good, so
   * the operator reads the numbers rather than a verdict.
   */
  async function reconcileCarried(): Promise<void> {
    const records: SponsoredRecord[] = [];
    for (const [account, held] of heldSettlements) {
      if (!held.prepared) continue;
      records.push({
        userAddress: account,
        slots: (held.repays.createdAccount ? 2 : 0) + held.repays.assets.length,
        state: "awaiting-arrival",
      });
    }
    const report = await reconcile(keypair.publicKey(), records, sponsorshipView);
    console.error(
      `[sponsor] reconciliation: the sponsor carries ${report.actualSlots} reserve slots ` +
        `on-chain and ${report.expectedSlots} by its records; ` +
        `untracked: ${report.untracked.join(", ") || "none"}; ` +
        `stale: ${report.stale.join(", ") || "none"}`,
    );
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

  // A node on another network would make every transaction this sponsor builds
  // fail with no clear reason, so start-up refuses one. A node that cannot be
  // asked right now is said, not taken as agreeing or disagreeing.
  let agreed: Promise<void> | undefined;
  function networkAgreed(): Promise<void> {
    agreed ??= options.rpc.server.getNetwork().then(
      (node) => {
        if (node.passphrase !== options.network.passphrase) {
          throw new Error(
            `The Stellar node this sponsor uses serves ${node.passphrase}, and the sponsor is ` +
              `set up for ${options.network.passphrase} (MAVNA_NETWORK and STELLAR_RPC_URL ` +
              "disagree).",
          );
        }
      },
      (cause: unknown) => {
        console.error(
          "[sponsor] could not ask the Stellar node which network it serves:",
          cause instanceof Error ? cause.message : cause,
        );
      },
    );
    return agreed;
  }

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
        // it may have failed after something was sent, so it says no more than that
        {
          error: "That did not work, and it may not have finished. Asking again is safe.",
          retryable: true,
        },
        corsOrigin(req),
      );
    });
  });
  server.on("close", () => {
    void stopSweep();
  });
  return Object.assign(server, {
    startSweep,
    stopSweep,
    ready: () => Promise.all([loaded, networkAgreed()]).then(() => undefined),
  });

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
          // how close the settlement capacity is to full; addresses stay private
          channels: {
            size: channels?.size ?? 0,
            leased: channels?.owners(nowUnix()).length ?? 0,
            maxSize: poolLimit(),
          },
        },
        origin,
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/prepare") {
      await prepare(bodyOf(prepareBody, await readJson(req)), res, origin, client);
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      await submit(bodyOf(submitBody, await readJson(req)), res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement") {
      await settlement(bodyOf(settlementBody, await readJson(req)), res, origin, client);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement/commit") {
      await settlementCommit(bodyOf(settlementCommitBody, await readJson(req)), res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settle") {
      await settle(bodyOf(settleBody, await readJson(req)), res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/deliver") {
      await deliver(bodyOf(deliverBody, await readJson(req)), res, origin, client);
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
    client: string,
  ): Promise<void> {
    if (body.destination === undefined) {
      await answer(res, 400, { error: "Say which account to prepare.", retryable: false }, origin);
      return;
    }
    if (await busyBuilding(res, origin, client)) return;

    // The caps bound the sponsor's money, and an account paying for itself
    // spends none of it.
    if (reserveFunding === "sponsor") {
      const decision = await caps.check(caps.unprovenClass());
      if (!decision.allowed) {
        await answer(res, capStatus(decision), { error: decision.reason, retryable: true }, origin);
        return;
      }
    }

    const names = body.assets ?? ["USDC"];
    // own keys only: a plain object answers "constructor" and "toString" too
    const assets = names.map((name) =>
      Object.hasOwn(options.curatedAssets, name) ? options.curatedAssets[name] : undefined,
    );
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
      await prepareSelfFunded(
        body.destination,
        body.sourceChainId,
        assets as Asset[],
        res,
        origin,
        client,
      );
      return;
    }
    const holder = classified.trustlineHolder ?? body.destination;
    const created = !(await accountExists(options.rpc, holder));
    const usdcLine = assets[0];
    if (
      !created &&
      usdcLine !== undefined &&
      (await readTrustline(options.rpc, holder, usdcLine)) !== undefined
    ) {
      await answer(res, 400, { error: ALREADY_HOLDS_USDC, retryable: false }, origin);
      return;
    }

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
        hash: xdr.encodeBytes(transaction.hash(), "hex"),
        kind: "preparation",
        destination: body.destination,
        signer: signerFor(body.destination),
        sourceChainId: body.sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
      },
      nowUnix(),
      client,
    );

    await answer(res, 200, { xdr: transaction.toXdr(), sponsor: keypair.publicKey() }, origin);
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
    client: string,
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

    const builder = new TransactionBuilder(new Account(holder, entry.seqNum.toString()), {
      fee: String(SELF_FUNDED_FEE_STROOPS),
      networkPassphrase: options.network.passphrase,
    });
    for (const asset of assets) builder.addOperation(Operation.changeTrust({ asset }));
    const transaction = builder.setTimeout(300).build();
    built.record(
      {
        hash: xdr.encodeBytes(transaction.hash(), "hex"),
        kind: "preparation",
        destination,
        signer: holder,
        sourceChainId: sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
        selfFunded: true,
      },
      nowUnix(),
      client,
    );
    await answer(res, 200, { xdr: transaction.toXdr(), selfFunded: true }, origin);
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
    const record = built.take(xdr.encodeBytes(transaction.hash(), "hex"), "preparation", nowUnix());
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
    client: string,
  ): Promise<void> {
    if (body.destination === undefined) {
      await answer(res, 400, { error: "Say which account will settle.", retryable: false }, origin);
      return;
    }
    if (reserveFunding === "self") {
      await noLoans(res, origin);
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
    // Keyed by the account, not by how its address was written: a muxed address
    // and its account are one sequence and one reserve.
    const account = classified.trustlineHolder ?? body.destination;
    // A settlement being submitted may already have spent its channel's
    // sequence. Building now would put this one on the next sequence, which is
    // the next user's once the channel is released.
    if (settling.has(account)) {
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
    const decision = await caps.check(caps.unprovenClass());
    if (!decision.allowed) {
      await answer(res, capStatus(decision), { error: decision.reason, retryable: true }, origin);
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

    const createdAccount = !(await accountExists(options.rpc, account));
    // An account this sponsor already prepared holds the line it sponsored;
    // building again for it is harmless, since nothing can replace a prepared
    // settlement. Anyone else holding USDC has nothing for the sponsor to open.
    if (
      !createdAccount &&
      !backed(account) &&
      (await readTrustline(options.rpc, account, usdc)) !== undefined
    ) {
      await answer(res, 400, { error: ALREADY_HOLDS_USDC, retryable: false }, origin);
      return;
    }

    if (await busyBuilding(res, origin, client)) return;
    const noSlot = (): Promise<void> =>
      answer(
        res,
        503,
        {
          error: "No settlement slot can be added right now. Try again in a few minutes.",
          retryable: true,
        },
        origin,
      );
    let pool: ChannelPool;
    try {
      pool = await ensureChannels();
    } catch (cause) {
      if (!(cause instanceof FundingBackoff)) throw cause;
      await noSlot();
      return;
    }
    const now = nowUnix();
    const live = pool.owners(now);
    for (const owner of leaseClients.keys()) {
      if (!live.includes(owner)) leaseClients.delete(owner);
    }
    for (const [owner, since] of provisionalSince) {
      if (!live.includes(owner) && since + 2 * PROVISIONAL_LEASE_SECONDS < now) {
        provisionalSince.delete(owner);
      }
    }
    if (!live.includes(account)) {
      // Lapsed unbacked a moment ago: wait out one window before another.
      if (provisionalSince.has(account) && !landed(account)) {
        await answer(
          res,
          429,
          {
            error:
              "This account's last settlement slot lapsed without a preparation. Try again " +
              "in a few minutes.",
            retryable: true,
          },
          origin,
        );
        return;
      }
      const unbacked = live.filter((owner) => !landed(owner));
      if (unbacked.length >= provisionalLimit) {
        await answer(
          res,
          503,
          { error: "Every settlement slot is in use. Try again shortly.", retryable: true },
          origin,
        );
        return;
      }
      const waiting = unbacked.filter((owner) => leaseClients.get(owner) === client).length;
      if (perClient > 0 && waiting >= perClient) {
        await answer(
          res,
          429,
          {
            error:
              "This address already has settlements waiting on a preparation. Finish or " +
              "abandon one, then try again.",
            retryable: true,
          },
          origin,
        );
        return;
      }
    }
    // A fixed window from the first ask, lengthened only once a preparation has
    // landed. Asking again hands back the same channel and window, so asking,
    // signing and committing, all free, can never keep a slot.
    let channel: Channel | undefined;
    let channelAccount: Account | undefined;
    // A channel whose account is gone (merged back, and the process stopped
    // before the pool was rewritten) is dropped where it is found, and the
    // next one taken, so this never answers for it with a failure.
    while (channelAccount === undefined) {
      channel = pool.acquire(account, now + PROVISIONAL_LEASE_SECONDS, nowUnix());
      while (channel === undefined && options.channels === undefined && pool.size < poolLimit()) {
        try {
          pool = await fundOne();
        } catch (cause) {
          if (!(cause instanceof FundingBackoff)) throw cause;
          await noSlot();
          return;
        }
        channel = pool.acquire(account, now + PROVISIONAL_LEASE_SECONDS, nowUnix());
      }
      if (channel === undefined) break;
      try {
        channelAccount = await options.rpc.loadAccount(channel.address);
      } catch (cause) {
        if (!(cause instanceof AccountNotFound)) throw cause;
        console.error(`[sponsor] channel ${channel.address} no longer exists; dropping it`);
        pool.drop(account, channel.address);
        await persist();
      }
    }
    if (channel === undefined || channelAccount === undefined) {
      await answer(
        res,
        503,
        { error: "Every settlement slot is in use. Try again shortly.", retryable: true },
        origin,
      );
      return;
    }
    if (!leaseClients.has(account)) leaseClients.set(account, client);
    if (!provisionalSince.has(account) && !landed(account)) provisionalSince.set(account, now);

    // Account 2 slots + one trustline = 3, or 1 when the account already exists.
    const slots = createdAccount ? 3 : 1;
    const xlmNeededStroops = BigInt(slots) * BigInt(options.network.baseReserveStroops);
    // The ceiling is twice the reserve at the live rate: generous enough that
    // ordinary movement between signing and settling is absorbed, bounded enough
    // that the user's exposure is a number they can read.
    const stroopsPerUsdc = await prices.xlmStroopsPerUnit(usdc);
    const maxSpendBase = (xlmNeededStroops * 2n * 10_000_000n) / stroopsPerUsdc;

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
        hash: xdr.encodeBytes(transaction.hash(), "hex"),
        kind: "settlement",
        destination: body.destination,
        signer: account,
        sourceChainId: body.sourceChainId ?? "unknown",
        expiresAtUnix: expiryOf(transaction),
        // only holdable while the short lease lasts, so not kept past it
        openUntilUnix: now + PROVISIONAL_LEASE_SECONDS + LEASE_RECLAIM_GRACE_SECONDS,
        channel: channel.address,
        repays: { createdAccount, assets: [usdc.toString()] },
      },
      nowUnix(),
      client,
    );

    await answer(res, 200, { xdr: transaction.toXdr(), channel: channel.address }, origin);
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

    const record = built.take(xdr.encodeBytes(transaction.hash(), "hex"), "settlement", nowUnix());
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
    // the same account under another spelling is the same account
    if (
      body.destination !== undefined &&
      (!settlesOnStellar(body.destination) || signerFor(body.destination) !== record.signer)
    ) {
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
    const current = await liveSettlement(record.signer);
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
    // one would let it spend theirs. Holding it changes nothing about the
    // lease: a signature from a key the caller made up backs nothing, and only
    // a preparation that has landed lengthens it to the settlement's own bound.
    if (
      record.channel === undefined ||
      channels === undefined ||
      !channels.holds(record.signer, record.channel, nowUnix())
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

    heldSettlements.set(record.signer, {
      xdr: body.signedXdr,
      createdAtUnix: nowUnix(),
      sourceChainId: record.sourceChainId,
      channel: record.channel,
      maxTimeUnix: record.expiresAtUnix,
      repays: record.repays,
      prepared: false,
      preparing: false,
      preparation: undefined,
      sentAtUnix: undefined,
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
    // the pool the settlement was built on; never a reason to fund another
    const pool = channels;
    if (pool === undefined) return { settled: false, settlementRetryable: true };

    const transaction = TransactionBuilder.fromXdr(held.xdr, options.network.passphrase);
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

    // Sent before and not seen to land: it may have, after the wait or before
    // a restart, and then the balance below no longer covers it though the
    // loan is repaid. Asked by hash first.
    if (held.sentAtUnix !== undefined) {
      let found: Awaited<ReturnType<RpcClient["findTransaction"]>>;
      try {
        found = await options.rpc.findTransaction(xdr.encodeBytes(transaction.hash(), "hex"));
      } catch (cause) {
        console.error(
          `[sponsor] could not look up the settlement sent for ${destination}:`,
          cause instanceof Error ? cause.message : cause,
        );
        return { settled: false, settlementRetryable: true };
      }
      if (found.status === "SUCCESS") return settled(xdr.encodeBytes(transaction.hash(), "hex"));
      if (found.status === "FAILED") return await stranded();
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

    held.sentAtUnix ??= nowUnix();
    await persist();

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
        return await spentSequence(xdr.encodeBytes(transaction.hash(), "hex"), settled, stranded);
      }
      // The channel cannot pay the fee: the sponsor's own shortfall, and nothing
      // was spent on-chain, so the settlement stays held while the channel is
      // topped up, rather than being given up as a stranding.
      if (cause instanceof SubmitRejected && cause.code === "txInsufficientBalance") {
        void topUpChannel(transaction.source).catch(logTopUpFailure(transaction.source));
        return { settled: false, settlementRetryable: true };
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
    const line = await readTrustline(options.rpc, signerFor(destination), payment.sendAsset);
    if (line === undefined || !line.authorized) return false;
    // what the owner's own offers have promised away cannot pay the settlement
    const spendable = line.balanceStroops - line.sellingStroops;
    // What the trade costs now on the settlement's own direct path, not the
    // ceiling it was signed with: an arrival between the two would otherwise
    // never settle. A quote over the ceiling would fail on-chain and burn the
    // channel's sequence, so it waits for the market instead.
    const cost = await spendQuote.directSpendStroops(payment.sendAsset, payment.destAmount);
    if (cost === undefined) return false;
    const ceiling = decimalToStroops(payment.sendMax);
    const withMargin = (cost * (10_000n + SPEND_MARGIN_BASIS_POINTS)) / 10_000n;
    if (cost > ceiling) return false;
    return spendable >= (withMargin < ceiling ? withMargin : ceiling);
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
    const record = built.take(xdr.encodeBytes(transaction.hash(), "hex"), "preparation", nowUnix());
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
    const held = await liveSettlement(record.signer);
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
    // the source chain is still only the caller's claim, so it does not pick the class
    const source = caps.unprovenClass();
    let result: Awaited<ReturnType<RpcClient["submit"]>>;
    try {
      // The account may have opened the line itself since it was prepared. The
      // preparation would then sponsor nothing, and the settlement fail on a
      // line the sponsor never sponsored, counted as a stranding.
      const usdc = options.curatedAssets.USDC;
      if (
        usdc !== undefined &&
        !held.repays.createdAccount &&
        (await readTrustline(options.rpc, record.signer, usdc)) !== undefined
      ) {
        await refuse(record, res, origin, 409, ALREADY_HOLDS_USDC);
        return;
      }
      const decision = await caps.check(source);
      if (!decision.allowed) {
        await refuse(record, res, origin, capStatus(decision), decision.reason, true);
        return;
      }

      // The slot must still be this account's. Once the preparation is marked
      // below, the pool keeps the lease while it may still land, and only its
      // landing lengthens the lease to the settlement's own bound.
      if (
        held.channel === undefined ||
        channels === undefined ||
        !channels.holds(record.signer, held.channel, nowUnix())
      ) {
        await refuse(
          record,
          res,
          origin,
          409,
          "The settlement held for this account has lost its slot. Ask for a new one.",
        );
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
        shortenLease(record.signer, held);
        throw cause;
      }
      try {
        // Presigned: the user signed this sequence, so it cannot be rebuilt here,
        // and resending it after a stale sequence can only be refused again.
        result = await options.rpc.submit("sponsored preparation", async () => transaction, {
          presigned: true,
        });
      } catch (cause) {
        if (cause instanceof SubmitRejected && cause.code === "txBadSeq") {
          // Something else the sponsor signed took this sequence while the user
          // was signing. Asked by hash in case this very preparation is what
          // took it; otherwise it can never land, and the account may prepare
          // again at once.
          const landed = await preparationLanded(record.hash);
          if (landed !== undefined) {
            result = landed;
          } else {
            if (held.preparation === sent) {
              held.preparation = undefined;
              shortenLease(record.signer, held);
            }
            await answer(
              res,
              409,
              {
                error:
                  "The sponsor's account moved on before this preparation went out, so it " +
                  "can never land. Ask for a new preparation and sign that one.",
                retryable: true,
                prepareAgain: true,
              },
              origin,
            );
            return;
          }
        } else {
          const retryable = cause instanceof MavnaError ? cause.retryable : true;
          // A refusal is final. Anything else (a timeout, an answer that never
          // came) may still land, so the mark stays and the next touch looks it up.
          if (!retryable && held.preparation === sent) {
            held.preparation = undefined;
            shortenLease(record.signer, held);
          }
          await answer(
            res,
            502,
            { error: "The preparation could not be submitted.", retryable },
            origin,
          );
          return;
        }
      }
    } finally {
      held.preparing = false;
    }
    if (heldSettlements.get(record.signer) === held) {
      held.prepared = true;
      held.preparation = undefined;
      backedByLanding(record.signer, held);
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
    const asked = body.destination;
    if (typeof asked !== "string" || !settlesOnStellar(asked)) {
      await answer(
        res,
        400,
        { error: "That is not a usable Stellar address.", retryable: false },
        origin,
      );
      return;
    }
    const destination = signerFor(asked);

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
    client: string,
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

    const txHash = normalTxHash(body.txHash);
    const result = await deliverBurn(txHash, domain);
    const key = watchKey(txHash, domain);
    if (result.next === "watch") watchBurn(txHash, domain, client);
    if (result.next === "done" || result.next === "never") forgetBurn(key);
    // Said only when it is true: the widget leaves the burn to the sponsor on
    // it, and answer() writes the list down before this goes out.
    await answer(
      res,
      result.status,
      watch.has(key) ? { ...result.body, watching: true } : result.body,
      origin,
    );
  }

  /** Start watching a burn Circle has not attested yet, within the limits. */
  function watchBurn(txHash: string, domain: number, client: string): void {
    const key = watchKey(txHash, domain);
    if (watch.has(key)) return;
    const mine = [...watch.values()].filter((entry) => entry.client === client).length;
    if (mine >= watchLimits.perClient || watch.size >= watchLimits.total) return;
    const now = nowUnix();
    watch.set(key, {
      txHash,
      domain,
      client,
      addedAtUnix: now,
      nextAtUnix: now + WATCH_FIRST_RETRY_SECONDS,
      tries: 0,
    });
  }

  function forgetBurn(key: string): void {
    watch.delete(key);
  }

  /**
   * Ask about every watched burn that is due, a few each sweep, one at a time.
   * Each is delivered through the same path /deliver takes, so the budget,
   * the minimum and the settlement that follows all apply as they would there.
   */
  async function sweepWatched(): Promise<void> {
    const startedAt = nowUnix();
    for (const [key, entry] of [...watch]) {
      if (entry.addedAtUnix + WATCH_MAX_AGE_SECONDS < startedAt) {
        forgetBurn(key);
        console.error(
          `[sponsor] stopped watching burn ${entry.txHash} on domain ${entry.domain}: ` +
            "not delivered within two days",
        );
      }
    }
    // Longest due first, so a burn retried a moment ago waits behind one that
    // has not been tried yet: however many are ahead, each gets its turn.
    const due = [...watch]
      .filter(([, entry]) => entry.nextAtUnix <= startedAt)
      .sort(([, a], [, b]) => a.nextAtUnix - b.nextAtUnix)
      .slice(0, WATCH_PER_SWEEP);
    for (const [key, entry] of due) {
      let result: BurnResult;
      try {
        result = await deliverBurn(entry.txHash, entry.domain);
      } catch (cause) {
        console.error(
          `[sponsor] could not deliver watched burn ${entry.txHash}:`,
          cause instanceof Error ? cause.message : cause,
        );
        result = { status: 500, body: {}, next: "later" };
      }
      if (watch.get(key) !== entry) continue;
      if (result.next === "done") {
        forgetBurn(key);
        console.error(`[sponsor] delivered watched burn ${entry.txHash} on domain ${entry.domain}`);
      } else if (result.next === "never") {
        forgetBurn(key);
        console.error(
          `[sponsor] stopped watching burn ${entry.txHash} on domain ${entry.domain}: ` +
            String(result.body.error ?? "it can never be delivered"),
        );
      } else {
        entry.tries += 1;
        entry.nextAtUnix =
          nowUnix() +
          Math.min(WATCH_FIRST_RETRY_SECONDS * 2 ** entry.tries, WATCH_MAX_BACKOFF_SECONDS);
      }
    }
    await persist();
  }

  /**
   * Deliver one burn: ask Circle, check what it mints, deliver, and settle for
   * the attested recipient. What to answer, and what the watch list should do
   * next: keep watching (not attested yet), try later, or forget it.
   */
  async function deliverBurn(txHash: string, domain: number): Promise<BurnResult> {
    const unavailable: BurnResult = {
      status: 502,
      body: { error: "Circle's attestation service did not answer usefully.", retryable: true },
      next: "later",
    };
    // Circle has never heard of it: not watched, since anyone can make up a
    // hash, and a real burn Circle has not indexed yet is watched once it has
    const notYet: BurnResult = {
      status: 404,
      body: { error: "Circle has no attested record of that transaction yet.", retryable: true },
      next: "unknown",
    };
    let iris: Response;
    try {
      iris = await fetch(
        `${options.irisUrl}/v2/messages/${domain}?transactionHash=${encodeURIComponent(txHash)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (cause) {
      console.error(
        "[sponsor] iris could not be reached:",
        cause instanceof Error ? cause.message : cause,
      );
      return unavailable;
    }
    if (iris.status === 404) return notYet;
    if (!iris.ok) {
      console.error("[sponsor] iris answered", iris.status);
      return unavailable;
    }
    let parsed: { messages?: readonly { message?: string; attestation?: string }[] };
    try {
      parsed = (await iris.json()) as typeof parsed;
    } catch (cause) {
      console.error("[sponsor] iris answered with something that is not JSON", cause);
      return unavailable;
    }
    const message = parsed?.messages?.[0];
    if (typeof message?.message !== "string" || typeof message.attestation !== "string") {
      return notYet;
    }

    // Paying to deliver dust is how a stream of tiny burns spends the
    // sponsor's XLM, so below the floor nothing is paid. An attested message
    // whose amount cannot be read is refused the same way: this is the one
    // place the sponsor spends on a stranger's say-so.
    if (message.attestation !== "PENDING") {
      const minted = mintedAmount(message.message);
      if (minted === undefined || minted < minDelivery) {
        return {
          status: 400,
          body: {
            error:
              minted === undefined
                ? "Circle's record of that transfer has no amount this sponsor can read, so it will not pay to deliver it."
                : `This sponsor delivers Circle transfers of at least ${usdcText(minDelivery)} USDC, ` +
                  `and this one mints ${usdcText(minted)} USDC.`,
            retryable: false,
          },
          next: "never",
        };
      }
    }

    let outcome: DeliveryOutcome;
    try {
      outcome = await deliverer.deliver({
        messageHex: message.message,
        attestationHex: message.attestation,
      });
    } catch (cause) {
      if (cause instanceof UnreadableState) {
        console.error(
          "[sponsor] DELIVERIES PAUSED: the delivery spend state cannot be read, and no delivery " +
            "is paid for until it is repaired:",
          cause.message,
        );
        return {
          status: 503,
          body: {
            error:
              "This sponsor is not paying for deliveries while its records are repaired. Try " +
              "again later, or deliver the transfer from the receiving account.",
            retryable: true,
          },
          next: "later",
        };
      }
      if (cause instanceof DeliveryBudgetSpent) {
        console.error("[sponsor] today's delivery budget is spent; a delivery was turned away");
        return {
          status: 503,
          body: {
            error:
              "This sponsor has spent today's budget for paying deliveries. Try again after " +
              "midnight UTC, or deliver the transfer from the receiving account.",
            retryable: true,
          },
          next: "later",
        };
      }
      if (cause instanceof DeliveryOutcomeUnknown) {
        console.error("[sponsor]", cause.message);
        return {
          status: 502,
          body: {
            error:
              "The delivery was sent and has not been seen to land; it may have landed. " +
              "Asking again is safe.",
            retryable: true,
            deliveryTxHash: cause.txHash,
          },
          // looked up again by the sweep, which finds it delivered if it landed
          next: "watch",
        };
      }
      if (!(cause instanceof DeliveryFailedOnChain)) throw cause;
      console.error("[sponsor]", cause.message);
      return {
        status: 502,
        body: {
          error:
            "The delivery reached Stellar and failed there, so its fee was paid and nothing " +
            "was minted. Asking again is safe.",
          retryable: true,
        },
        next: "later",
      };
    }
    if (outcome.kind === "not-attested-yet") {
      return { status: 200, body: { ...outcome }, next: "watch" };
    }

    // The lateness rule's payoff: the settlement was signed before anything
    // moved, and the moment the delivery lands it is submitted, releasing the
    // sponsor's capital in the same breath. Only for the account Circle
    // attested: a destination named in the request is the caller's claim, and
    // settling on it would spend a stranger's arrival on someone else's loan.
    const recipient = attestedRecipient(message.message, domain, expected);
    const settled =
      (outcome.kind === "delivered" || outcome.kind === "already-delivered") &&
      recipient !== undefined &&
      settlesOnStellar(recipient)
        ? await settleIfHeld(signerFor(recipient))
        : {};

    return {
      status: outcome.kind === "recipient-not-ready" ? 409 : 200,
      body: { ...outcome, ...settled },
      // not ready yet is a wait, so the sweep delivers it once the account is
      next: outcome.kind === "recipient-not-ready" ? "watch" : "done",
    };
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
    return TransactionBuilder.fromXdr(xdrText, passphrase);
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
 * The one window a settlement nobody has backed holds its channel for, from
 * the first ask, never renewed: long enough to sign the settlement and the
 * preparation in a wallet, one after the other.
 */
const PROVISIONAL_LEASE_SECONDS = 600;

/** Channels kept however idle, and how long one sits unused before it is merged back. */
const DEFAULT_CHANNEL_FLOOR = 4;
const CHANNEL_IDLE_MERGE_SECONDS = 24 * 60 * 60;

/** Watched burns: per client and in all, first retry, longest wait, oldest, and per sweep. */
const DEFAULT_WATCH_LIMITS = { perClient: 8, total: 1_000 } as const;
const WATCH_FIRST_RETRY_SECONDS = 60;
const WATCH_MAX_BACKOFF_SECONDS = 30 * 60;
const WATCH_MAX_AGE_SECONDS = 48 * 60 * 60;
const WATCH_PER_SWEEP = 25;

/** Lines the built log may run past twice its open records before it is compacted. */
const BUILT_LOG_SLACK = 1_000;

/** The wait after a failed channel funding, doubled each time, to at most half an hour. */
const FUNDING_BACKOFF_MS = 60_000;
const FUNDING_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Transactions one client may have built and not yet signed. Honest use leaves
 * a handful; this keeps a few clients from filling the whole ledger.
 */
const OPEN_BUILDS_PER_CLIENT = 16;

/** Unbacked settlements that may hold a channel at once, across every client. */
const DEFAULT_PROVISIONAL_SETTLEMENTS = 16;

/**
 * 25 XLM a day for delivery fees. A real delivery measured about 0.013 XLM, so
 * this is well over a thousand a day, and what a day of abuse can cost.
 */
const DEFAULT_DELIVERY_BUDGET_STROOPS = 250_000_000n;

/** How often the sweep cross-checks what the sponsor carries against the chain. */
const RECONCILE_EVERY_MS = 60 * 60 * 1000;

/**
 * Room over the quoted cost, in basis points, for the market moving in the
 * seconds between the quote and the trade.
 */
const SPEND_MARGIN_BASIS_POINTS = 100n;

/** Below this a channel is topped up: its 1 XLM minimum plus a few surge fees. */
const CHANNEL_LOW_STROOPS = 15_000_000n;
/** What a channel is topped up to, the 2 XLM it was funded with. */
const CHANNEL_TOP_UP_TO_STROOPS = 20_000_000n;

/** The channel pool's own grace past a lease's end, before it reuses the channel. */
const LEASE_RECLAIM_GRACE_SECONDS = 30;

/** How long a repayment found only after its time bound is still reported to a page. */
const LATE_REPAYMENT_REPORTED_SECONDS = 3_600;

/** Settlements one client may have waiting on a preparation, unless configured. */
const DEFAULT_SETTLEMENTS_PER_CLIENT = 2;

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

/** A parsed record without the keys zod filled with undefined, as it was written. */
function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;
}

/** An account's trustline as the settlement and the preparation need to see it. */
interface TrustlineState {
  readonly balanceStroops: bigint;
  /** Promised to the account's own open offers, so not spendable. */
  readonly sellingStroops: bigint;
  readonly authorized: boolean;
}

/** Trustline flag bit meaning the issuer authorised this account to hold the asset. */
const AUTHORIZED_FLAG = 1;

/** The account's trustline for an asset, or undefined when it has none. */
async function readTrustline(
  rpc: RpcClient,
  holder: string,
  asset: Asset,
): Promise<TrustlineState | undefined> {
  const accountId = Keypair.fromPublicKey(holder).xdrAccountId();
  const key = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId, asset: asset.toTrustLineXdrObject() }),
  );
  const entries = await rpc.read(`trustline ${holder}`, async () => {
    const response = await rpc.server.getLedgerEntries(key);
    return { value: response.entries, ledger: response.latestLedger };
  });
  for (const entry of entries) {
    if (entry.val.type !== "trustline") continue;
    const line = entry.val.trustLine;
    return {
      balanceStroops: line.balance,
      sellingStroops: line.ext.type === "v1" ? line.ext.v1.liabilities.selling : 0n,
      authorized: (line.flags & AUTHORIZED_FLAG) !== 0,
    };
  }
  return undefined;
}

/**
 * Said when the account already has the line the sponsor would open. Fronting
 * it would sponsor nothing, and the settlement's revoke would then fail on a
 * line the sponsor never sponsored, which reads as a stranding for free.
 */
const ALREADY_HOLDS_USDC =
  "That account already holds USDC, so there is no trustline for this sponsor to open.";

/** One burn the sweep keeps asking about, as written down. */
interface WatchEntry {
  readonly txHash: string;
  readonly domain: number;
  /** Who asked first, so each client's share holds across a restart. */
  readonly client?: string | undefined;
  readonly addedAtUnix: number;
  nextAtUnix: number;
  tries: number;
}

/** What delivering one burn came to, and what its watch should do next. */
interface BurnResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly next: "watch" | "unknown" | "later" | "done" | "never";
}

const watchEntryShape = z.object({
  txHash: z.string().max(200),
  domain: z.number().int().nonnegative(),
  client: z.string().max(100).optional(),
  addedAtUnix: z.number().int(),
  nextAtUnix: z.number().int(),
  tries: z.number().int().nonnegative(),
});
const watchDocumentShape = z.object({ entries: z.array(z.unknown()) });

/** An EVM or Starknet hash in one case, so one burn is one watch; base58 is case-sensitive. */
function normalTxHash(txHash: string): string {
  return txHash.startsWith("0x") ? txHash.toLowerCase() : txHash;
}

function watchKey(txHash: string, domain: number): string {
  return `${domain}:${normalTxHash(txHash)}`;
}

/** A cap reached is 429; the counts themselves unreadable is the sponsor's own 503. */
function capStatus(decision: CapDecision): number {
  return !decision.allowed && decision.cap === "state" ? 503 : 429;
}

/** A channel funding failed recently, so none is tried until its backoff ends. */
class FundingBackoff extends MavnaError {
  constructor() {
    super("A channel funding failed recently and is not retried yet.", { retryable: true });
    this.name = "FundingBackoff";
  }
}
