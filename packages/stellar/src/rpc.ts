import { MavnaError } from "@mavna/core";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { Account, Keypair, rpc, xdr } from "@stellar/stellar-sdk";

/**
 * The public Stellar RPC endpoint is load balanced across nodes that are NOT at
 * the same point in the chain's history. Consecutive identical queries come back
 * describing moments roughly ten blocks apart, and an account created a moment
 * ago can be reported present, then absent, then present again.
 *
 * This is not a theoretical hazard. It broke three separate experiments during
 * specification work, each time producing a plausible but wrong conclusion.
 *
 * Every response carries `latestLedger`, which makes the fix possible: keep a
 * high-water mark, refuse answers from behind it, and retry.
 */
export interface LedgerFloor {
  /** The highest ledger we have already observed. Answers from behind it are stale. */
  readonly value: number;
  /** Raise the mark. Called after any write we made, and after any fresh read. */
  observe(ledger: number): void;
}

export function createLedgerFloor(initial = 0): LedgerFloor {
  let value = initial;
  return {
    get value() {
      return value;
    },
    observe(ledger: number): void {
      if (ledger > value) value = ledger;
    },
  };
}

export interface RpcClientOptions {
  readonly url: string;
  /** How many times to retry a read that came back from a lagging node. */
  readonly maxAttempts?: number;
  /** Base delay between retries, doubled each attempt. */
  readonly baseDelayMs?: number;
  /** Injectable so tests do not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The longest any one request may take, in milliseconds. Without it a node that
   * accepts the connection and never answers holds the caller forever.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * How long past a transaction's time bound to keep asking when no node has yet
 * closed a ledger past it, before saying the outcome is unknown.
 */
const EXPIRY_GRACE_SECONDS = 120;

/** What the SDK's HTTP client throws when a request runs past its timeout. */
function isTimeout(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return (
    (cause as { code?: unknown }).code === "ECONNABORTED" ||
    /^timeout of \d+ ?ms exceeded$/.test(cause.message)
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A read whose answer we are willing to believe, together with the ledger it was
 * true at. Callers that need to distinguish "absent" from "not known yet" get
 * that distinction explicitly rather than by convention.
 */
export interface FreshRead<T> {
  readonly value: T;
  readonly ledger: number;
}

export interface SubmitOptions {
  /** How many times to send before giving up on transient failures. */
  readonly attempts?: number;
  /**
   * The builder hands back the same signed envelope every time, as with a
   * settlement the user signed in advance. A stale sequence then means the
   * sequence is spent, not that the view was stale, so it is not retried.
   */
  readonly presigned?: boolean;
  /**
   * The longest to wait for inclusion, in seconds, when that is shorter than
   * the transaction's own time bound. Giving up here says nothing about the
   * transaction's fate, so the failure is retryable and says it may still land.
   */
  readonly waitSeconds?: number;
}

/**
 * The network refused a submission outright. `code` is the transaction result
 * code it gave, such as `txBadSeq`, for callers whose next step depends on it.
 */
export class SubmitRejected extends MavnaError {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message, { retryable: false });
    this.name = "SubmitRejected";
    this.code = code;
  }
}

/**
 * Every attempt at a submission was used up without one being included.
 * `stale-sequence` means each was refused at submission for a stale sequence,
 * so none reached the ledger and none was charged a fee. `exhausted` is any
 * other mix, where a caller cannot assume that.
 */
export class SubmitExhausted extends MavnaError {
  readonly code: "stale-sequence" | "exhausted";
  readonly lastReason: string;

  constructor(message: string, code: "stale-sequence" | "exhausted", lastReason: string) {
    super(message, { retryable: true });
    this.name = "SubmitExhausted";
    this.code = code;
    this.lastReason = lastReason;
  }
}

/**
 * A node at or past our high-water mark has no such account. Its own class so
 * callers can tell this answer from a read that failed, which says nothing
 * about whether the account exists.
 */
export class AccountNotFound extends MavnaError {
  readonly address: string;

  constructor(address: string) {
    super(`Account ${address} does not exist.`, { retryable: false });
    this.name = "AccountNotFound";
    this.address = address;
  }
}

export class RpcClient {
  readonly server: rpc.Server;
  readonly floor: LedgerFloor;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RpcClientOptions) {
    this.server = new rpc.Server(options.url);
    // rpc.Server's own `timeout` option is declared but never applied (sdk
    // 16.2.0), so the bound goes on the client it builds
    this.server.httpClient.defaults.timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.floor = createLedgerFloor();
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Run a read, rejecting any answer from a node behind our high-water mark.
   *
   * The read function must return both its value and the ledger that value was
   * true at, because only the caller knows where that came from in the response.
   */
  async read<T>(label: string, read: () => Promise<FreshRead<T>>): Promise<T> {
    let lastSeenLedger = -1;
    let lastTimeout: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let result: FreshRead<T>;
      try {
        result = await read();
      } catch (cause) {
        // a stalled node says nothing about the answer, so ask again; any other
        // failure is the caller's to see
        if (!isTimeout(cause)) throw cause;
        lastTimeout = cause;
        await this.sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (result.ledger >= this.floor.value) {
        this.floor.observe(result.ledger);
        return result.value;
      }
      lastSeenLedger = result.ledger;
      await this.sleep(this.baseDelayMs * 2 ** attempt);
    }

    if (lastSeenLedger === -1 && lastTimeout !== undefined) {
      throw new MavnaError(`Could not read ${label}: every request timed out.`, {
        retryable: true,
        cause: lastTimeout,
      });
    }
    throw new MavnaError(
      `Could not read ${label} from a node at or past ledger ${this.floor.value}; ` +
        `the closest was ${lastSeenLedger}.`,
      { retryable: true, cause: lastTimeout },
    );
  }

  /**
   * Record that we just wrote at this ledger, so every later read must come from
   * a node that has caught up to it. This is what turns read-your-writes from
   * luck into an invariant.
   */
  observeWrite(ledger: number): void {
    this.floor.observe(ledger);
  }

  /**
   * Load an account for transaction building, tolerating a lagging node.
   *
   * The SDK's own `getAccount` throws the moment one node has not caught up,
   * which is the single most common way this endpoint produces a false negative.
   * Every caller wants the retrying version, so this is the one to use.
   */
  async loadAccount(address: string): Promise<Account> {
    // The SDK's getAccount does not expose which ledger answered, so a lagging
    // node returns a SUCCESSFUL response carrying a STALE SEQUENCE NUMBER. That is
    // worse than an error: the transaction builds fine, is rejected for a bad
    // sequence, gets rebuilt from the same stale node, and the whole thing
    // cascades into an apparent network failure. Reading the ledger entry directly
    // is the only way to see the ledger and apply the freshness guard.
    const accountId = Keypair.fromPublicKey(address).xdrAccountId();
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));

    const entry = await this.read(`account ${address}`, async () => {
      const response = await this.server.getLedgerEntries(key);
      return { value: response.entries[0], ledger: response.latestLedger };
    });

    if (entry === undefined) {
      throw new AccountNotFound(address);
    }

    if (entry.val.type !== "account") throw new AccountNotFound(address);
    return new Account(address, entry.val.account.seqNum.toString());
  }

  /**
   * Wait for an account to appear.
   *
   * Distinct from loadAccount on purpose. Loading asks "what is this account's
   * state now", and a definitive absence is an error. Waiting asks "has it shown
   * up yet", where absence is the expected starting condition. Conflating them
   * means either a newly created account looks like a failure, or a genuinely
   * missing one is retried forever.
   */
  async waitForAccount(address: string, attempts = 40): Promise<Account> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.loadAccount(address);
      } catch (cause) {
        // absence is what is being waited out, and so is a node that could not
        // answer yet; anything else will not change by asking again
        const waitable =
          cause instanceof AccountNotFound || (cause instanceof MavnaError && cause.retryable);
        if (!waitable) throw cause;
        last = cause;
        await this.sleep(this.baseDelayMs * 2);
      }
    }
    throw new MavnaError(`Account ${address} never appeared.`, { retryable: true, cause: last });
  }

  /**
   * Wait for a submitted transaction to be included, raising the high-water mark
   * when it is.
   *
   * "Not found" means keep waiting, never failed. A lagging node's silence is
   * indistinguishable from a transaction that was never seen, so absence is only
   * conclusive once a node at or past our high-water mark has closed a ledger
   * after the transaction's time bound.
   */
  async waitForTransaction(
    hash: string,
    /** The transaction's own maxTime, in unix seconds. */
    maxTimeUnix: number,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const now = Math.floor(Date.now() / 1000);
    const found = await this.pollUntil(
      hash,
      maxTimeUnix,
      Math.max(maxTimeUnix, now) + EXPIRY_GRACE_SECONDS,
    );
    if (found === "expired") {
      throw new MavnaError(`Transaction ${hash} was not included before it expired.`, {
        retryable: true,
      });
    }
    if (found === "unknown") {
      throw new MavnaError(
        `Transaction ${hash} was not seen included, and no node has yet closed a ledger past ` +
          "its time bound; it may still land.",
        { retryable: false },
      );
    }
    return found;
  }

  /**
   * The polling behind waitForTransaction and submit.
   *
   * "expired" only when a node at or past the high-water mark reports a ledger
   * closed after `maxTimeUnix`: the network's clock, not ours, decides whether
   * the transaction can still be included. "unknown" when the local clock passes
   * `stopAtUnix` first, which says nothing about the transaction's fate.
   */
  private async pollUntil(
    hash: string,
    maxTimeUnix: number | undefined,
    stopAtUnix: number,
  ): Promise<rpc.Api.GetTransactionResponse | "expired" | "unknown"> {
    for (;;) {
      let result: rpc.Api.GetTransactionResponse | undefined;
      try {
        result = await this.server.getTransaction(hash);
      } catch (cause) {
        if (!isTimeout(cause)) throw cause;
      }
      if (result !== undefined && result.status !== "NOT_FOUND") {
        if (result.status === "SUCCESS") this.observeWrite(result.ledger);
        return result;
      }
      if (
        result !== undefined &&
        maxTimeUnix !== undefined &&
        result.latestLedger >= this.floor.value &&
        result.latestLedgerCloseTime > maxTimeUnix
      ) {
        return "expired";
      }
      if (Math.floor(Date.now() / 1000) > stopAtUnix) return "unknown";
      await this.sleep(this.baseDelayMs * 2);
    }
  }

  /**
   * Look a transaction up by hash, once, from a node at or past our high-water
   * mark. A lagging node reports NOT_FOUND for a transaction that landed, so
   * only a caught-up node's absence is an answer.
   */
  async findTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    const result = await this.read(`transaction ${hash}`, async () => {
      const response = await this.server.getTransaction(hash);
      return { value: response, ledger: response.latestLedger };
    });
    if (result.status === "SUCCESS") this.observeWrite(result.ledger);
    return result;
  }

  /**
   * Prepare a Soroban transaction, but only against a node that has caught up.
   *
   * The SDK's own prepareTransaction simulates through the raw server, which
   * bypasses the freshness guard entirely. That is not theoretical: it produced a
   * real false failure during the first end-to-end transfer, simulating against a
   * node that had not yet seen a trustline created moments earlier and reporting
   * "trustline entry is missing" for an account that demonstrably had one.
   *
   * Simulation reads current ledger state, so it needs the same discipline as any
   * other read.
   */
  async prepare(tx: Transaction): Promise<Transaction> {
    // the simulation itself carries the ledger it ran against, so the guard is
    // applied to that answer rather than to a separate request a load balancer
    // may send to a different node
    const simulated = await this.read("simulation", async () => {
      const response = await this.server.simulateTransaction(tx);
      return { value: response, ledger: response.latestLedger };
    });
    // what the SDK's prepareTransaction does with the same answer
    if (rpc.Api.isSimulationError(simulated)) throw new Error(simulated.error);
    return rpc.assembleTransaction(tx, simulated).build();
  }

  /**
   * Submit a transaction and wait for it, retrying the transient failures and
   * only the transient failures.
   *
   * Takes a builder rather than a built transaction because the common transient
   * failures invalidate the transaction itself: a stale sequence number has to be
   * rebuilt, not resent. Waiting on the hash of a submission the network never
   * accepted is the specific mistake this exists to prevent.
   *
   * A genuine rejection is returned rather than retried, because retrying a wrong
   * transaction just produces the same wrong answer more slowly.
   */
  async submit(
    label: string,
    build: () => Promise<Transaction | FeeBumpTransaction>,
    options: SubmitOptions = {},
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const attempts = options.attempts ?? 8;
    let lastReason = "unknown";
    // stays true only while every refusal is a stale sequence at submission
    let onlyStaleSequence = true;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const tx = await build();
      // The transaction's own time bound is the only correct deadline: past it
      // the network cannot include it, and before it silence means nothing.
      // A fee-bump carries its bounds on the inner transaction, not the envelope.
      const bounds = "timeBounds" in tx ? tx.timeBounds : tx.innerTransaction.timeBounds;
      const maxTime = Number(bounds?.maxTime ?? 0);
      const now = Math.floor(Date.now() / 1000);
      // measured from now as well, so a local clock running ahead still waits
      const stopAt = maxTime > 0 ? Math.max(maxTime, now) + EXPIRY_GRACE_SECONDS : now + 300;
      const capped =
        options.waitSeconds === undefined ? stopAt : Math.min(stopAt, now + options.waitSeconds);

      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await this.server.sendTransaction(tx);
      } catch (cause) {
        if (!isTimeout(cause)) throw cause;
        // the node may have taken it before going quiet, so a rebuild could act
        // twice; only its hash can say
        sent = {
          status: "PENDING",
          hash: xdr.encodeBytes(tx.hash(), "hex"),
          latestLedger: 0,
          latestLedgerCloseTime: 0,
        };
      }

      if (sent.status === "ERROR") {
        const reason = sent.errorResult?.result.type ?? "unknown";
        // A stale sequence is only transient for a transaction that can be
        // rebuilt. A signed envelope carries its sequence for good, so resending
        // it cannot help, and the caller needs to know which failure this was.
        const transient =
          TRANSIENT_SUBMIT_ERRORS.has(reason) &&
          !(options.presigned === true && reason === "txBadSeq");
        if (!transient) {
          throw new SubmitRejected(`${label} was rejected: ${reason}`, reason);
        }
        lastReason = reason;
        onlyStaleSequence &&= reason === "txBadSeq";
        await this.sleep(this.baseDelayMs * 2 ** Math.min(attempt, 4));
        continue;
      }

      onlyStaleSequence = false;
      if (sent.status === "TRY_AGAIN_LATER") {
        lastReason = "TRY_AGAIN_LATER";
        await this.sleep(this.baseDelayMs * 2 ** Math.min(attempt, 4));
        continue;
      }

      const result = await this.pollUntil(sent.hash, maxTime > 0 ? maxTime : undefined, capped);
      if (result === "expired") {
        // proven out of reach, so building it again cannot act twice
        lastReason = `transaction ${sent.hash} expired before it was included`;
        if (attempt + 1 < attempts) continue;
        throw new MavnaError(`Transaction ${sent.hash} was not included before it expired.`, {
          retryable: true,
        });
      }
      if (result === "unknown") {
        // Sending the same signed envelope again cannot act twice, so a
        // presigned one may be retried. Anything rebuilt would be a new
        // transaction beside one that may still land.
        throw new MavnaError(
          capped < stopAt
            ? `${label} was not seen included within ${options.waitSeconds} seconds; it may still land.`
            : `${label} was not seen included, and no node has closed a ledger past its time bound; it may still land.`,
          { retryable: options.presigned === true },
        );
      }
      if (result.status === "SUCCESS") return result;

      throw new MavnaError(`${label} failed on-chain.`, { retryable: false });
    }

    throw new SubmitExhausted(
      `${label} could not be submitted after ${attempts} attempts; ` +
        `the last reason was ${lastReason}.`,
      onlyStaleSequence ? "stale-sequence" : "exhausted",
      lastReason,
    );
  }
}

/**
 * Failures that mean "the network was busy or our view was stale", as opposed to
 * "this transaction is wrong". Only these are retried.
 */
const TRANSIENT_SUBMIT_ERRORS: ReadonlySet<string> = new Set([
  "txBadSeq",
  "txTryAgainLater",
  "txNoAccount",
  "txInsufficientFee",
]);
