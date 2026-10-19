import { MavnaError } from "@mavna/core";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { Account, Address, rpc, xdr } from "@stellar/stellar-sdk";

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

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const result = await read();
      if (result.ledger >= this.floor.value) {
        this.floor.observe(result.ledger);
        return result.value;
      }
      lastSeenLedger = result.ledger;
      await this.sleep(this.baseDelayMs * 2 ** attempt);
    }

    throw new MavnaError(
      `Could not read ${label} from a node at or past ledger ${this.floor.value}; ` +
        `the closest was ${lastSeenLedger}.`,
      { retryable: true },
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
    const accountId = Address.fromString(address).toScAddress().accountId();
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));

    const entry = await this.read(`account ${address}`, async () => {
      const response = await this.server.getLedgerEntries(key);
      return { value: response.entries[0], ledger: response.latestLedger };
    });

    if (entry === undefined) {
      throw new AccountNotFound(address);
    }

    const parsed = entry.val.account();
    return new Account(address, parsed.seqNum().toString());
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
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.loadAccount(address);
      } catch {
        await this.sleep(this.baseDelayMs * 2);
      }
    }
    throw new MavnaError(`Account ${address} never appeared.`, { retryable: true });
  }

  /**
   * Wait for a submitted transaction to be included, raising the high-water mark
   * when it is.
   *
   * "Not found" means keep waiting, never failed. A lagging node's silence is
   * indistinguishable from a transaction that was never seen, so absence is only
   * conclusive once the transaction could no longer be included.
   */
  async waitForTransaction(
    hash: string,
    /**
     * Unix seconds after which the transaction can no longer be included. Absence
     * is only conclusive past this point: before it, "not found" means the network
     * has not got to it yet, and giving up early turns congestion into a false
     * failure. Defaults to five minutes, matching the timeout we build with.
     */
    deadlineUnix: number = Math.floor(Date.now() / 1000) + 300,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const result = await this.pollUntil(hash, deadlineUnix);
    if (result !== undefined) return result;
    throw new MavnaError(`Transaction ${hash} was not included before it expired.`, {
      retryable: true,
    });
  }

  /** The polling behind waitForTransaction. Undefined means the deadline passed first. */
  private async pollUntil(
    hash: string,
    deadlineUnix: number,
  ): Promise<rpc.Api.GetTransactionResponse | undefined> {
    for (;;) {
      const result = await this.server.getTransaction(hash);
      if (result.status !== "NOT_FOUND") {
        if (result.status === "SUCCESS") this.observeWrite(result.ledger);
        return result;
      }
      if (Math.floor(Date.now() / 1000) > deadlineUnix) return undefined;
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
    await this.read("ledger head before simulating", async () => {
      const latest = await this.server.getLatestLedger();
      return { value: latest.sequence, ledger: latest.sequence };
    });
    return this.server.prepareTransaction(tx);
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

    for (let attempt = 0; attempt < attempts; attempt++) {
      const tx = await build();
      const sent = await this.server.sendTransaction(tx);

      if (sent.status === "ERROR") {
        const reason = sent.errorResult?.result().switch().name ?? "unknown";
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
        await this.sleep(this.baseDelayMs * 2 ** Math.min(attempt, 4));
        continue;
      }

      if (sent.status === "TRY_AGAIN_LATER") {
        lastReason = "TRY_AGAIN_LATER";
        await this.sleep(this.baseDelayMs * 2 ** Math.min(attempt, 4));
        continue;
      }

      // The transaction's own time bound is the only correct deadline: past it
      // the network cannot include it, and before it silence means nothing.
      // A fee-bump carries its bounds on the inner transaction, not the envelope.
      const bounds = "timeBounds" in tx ? tx.timeBounds : tx.innerTransaction.timeBounds;
      const maxTime = Number(bounds?.maxTime ?? 0);
      const expires = maxTime > 0 ? maxTime : Math.floor(Date.now() / 1000) + 300;
      const capped =
        options.waitSeconds === undefined
          ? expires
          : Math.min(expires, Math.floor(Date.now() / 1000) + options.waitSeconds);
      const result = await this.pollUntil(sent.hash, capped);
      if (result === undefined) {
        throw new MavnaError(
          capped < expires
            ? `${label} was not seen included within ${options.waitSeconds} seconds; it may still land.`
            : `Transaction ${sent.hash} was not included before it expired.`,
          { retryable: true },
        );
      }
      if (result.status === "SUCCESS") return result;

      throw new MavnaError(`${label} failed on-chain.`, { retryable: false });
    }

    throw new MavnaError(
      `${label} could not be submitted after ${attempts} attempts; ` +
        `the last reason was ${lastReason}.`,
      { retryable: true },
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
