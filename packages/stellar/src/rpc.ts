import { MavnaError } from "@mavna/core";
import type { Account, FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";

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
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await this.server.getAccount(address);
      } catch (cause) {
        if (attempt === this.maxAttempts - 1) {
          throw new MavnaError(`Account ${address} is not readable.`, {
            retryable: true,
            cause,
          });
        }
        await this.sleep(this.baseDelayMs * 2 ** attempt);
      }
    }
    // Unreachable: the loop either returns or throws on its final attempt.
    throw new MavnaError(`Account ${address} is not readable.`, { retryable: true });
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
    for (;;) {
      const result = await this.server.getTransaction(hash);
      if (result.status !== "NOT_FOUND") {
        if (result.status === "SUCCESS") this.observeWrite(result.ledger);
        return result;
      }
      if (Math.floor(Date.now() / 1000) > deadlineUnix) break;
      await this.sleep(this.baseDelayMs * 2);
    }
    throw new MavnaError(`Transaction ${hash} was not included before it expired.`, {
      retryable: true,
    });
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
    attempts = 8,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    let lastReason = "unknown";

    for (let attempt = 0; attempt < attempts; attempt++) {
      const tx = await build();
      const sent = await this.server.sendTransaction(tx);

      if (sent.status === "ERROR") {
        const reason = sent.errorResult?.result().switch().name ?? "unknown";
        if (!TRANSIENT_SUBMIT_ERRORS.has(reason)) {
          throw new MavnaError(`${label} was rejected: ${reason}`, { retryable: false });
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
      const result = await this.waitForTransaction(sent.hash, maxTime > 0 ? maxTime : undefined);
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
