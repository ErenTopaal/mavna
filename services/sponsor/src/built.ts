import { Keypair, type Transaction } from "@stellar/stellar-sdk";

/**
 * A ledger of the transactions this server built itself.
 *
 * A Stellar transaction hash covers the body and not the signatures, so a hash
 * is a stable identity for what the server agreed to sponsor. The server must
 * only countersign or hold a transaction whose hash is in here; anything else
 * is a body the caller chose, however well it is signed.
 */

export type BuiltKind = "preparation" | "settlement";

export interface BuiltRecord {
  /** Hex of the transaction hash. */
  readonly hash: string;
  readonly kind: BuiltKind;
  /** As the server received it, not normalised. */
  readonly destination: string;
  /** G address whose signature the transaction still needs. */
  readonly signer: string;
  readonly sourceChainId: string;
  readonly expiresAtUnix: number;
  /**
   * When the server stops honouring the record, if before `expiresAtUnix`. A
   * settlement can only be held while its short channel lease lasts, so its
   * record closes with that lease rather than living for the settlement's day.
   */
  readonly openUntilUnix?: number;
  readonly channel?: string;
  /**
   * For a settlement, what it repays: whether it revokes the account's own
   * sponsorship, and the trustlines whose sponsorship it revokes, as
   * `CODE:ISSUER`. A preparation is countersigned only if it sponsors exactly
   * this, or the settlement leaves part of the loan unpaid.
   */
  readonly repays?: Repayment;
  /**
   * A preparation the account pays for out of its own XLM. It is submitted as
   * the user signed it: no sponsor signature, and no settlement to wait for.
   */
  readonly selfFunded?: boolean;
}

export interface Repayment {
  readonly createdAccount: boolean;
  readonly assets: readonly string[];
}

/**
 * Open records the ledger holds before it refuses more. Every one is written to
 * disk on each change, so this bounds what anonymous builds can make the
 * sponsor carry and rewrite, far above what honest traffic leaves open.
 */
export const DEFAULT_OPEN_RECORDS = 10_000;

/** Open records kept per account and kind; the oldest goes first. */
const OPEN_PER_ACCOUNT = 3;

export class BuiltLedger {
  private readonly records = new Map<string, BuiltRecord>();
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_OPEN_RECORDS) {
    this.capacity = capacity;
  }

  /** Rebuild a ledger from what `snapshot` wrote, less what expired meanwhile. */
  static fromSnapshot(
    records: readonly BuiltRecord[],
    nowUnix: number,
    capacity: number = DEFAULT_OPEN_RECORDS,
  ): BuiltLedger {
    const ledger = new BuiltLedger(capacity);
    for (const record of records) ledger.records.set(record.hash, record);
    ledger.prune(nowUnix);
    return ledger;
  }

  /** Every record still open, for writing down. */
  snapshot(): readonly BuiltRecord[] {
    return [...this.records.values()];
  }

  /**
   * Expired records are pruned here as well as in take. Building is open to
   * anyone and signing is not, so a ledger pruned only on take would keep
   * every abandoned build until someone next signs.
   */
  record(record: BuiltRecord, nowUnix: number): void {
    this.prune(nowUnix);
    // A few open builds per account and kind, the latest. Asking again builds
    // afresh, and each answer would otherwise add one more record.
    const same = [...this.records.values()].filter(
      (open) => open.signer === record.signer && open.kind === record.kind,
    );
    for (const stale of same.slice(0, Math.max(0, same.length - (OPEN_PER_ACCOUNT - 1)))) {
      this.records.delete(stale.hash);
    }
    this.records.set(record.hash, record);
  }

  /** Whether as many records are open as the ledger holds, so the next build is refused. */
  full(nowUnix: number): boolean {
    this.prune(nowUnix);
    return this.records.size >= this.capacity;
  }

  /**
   * Once only. A record is removed as it is returned so a signed transaction
   * cannot be presented twice. A request of the wrong kind leaves it in place,
   * because a mistaken call should not destroy a record the right call needs.
   * Expired records are pruned on every call, so the map cannot grow unbounded
   * without a timer.
   */
  take(hash: string, kind: BuiltKind, nowUnix: number): BuiltRecord | undefined {
    this.prune(nowUnix);
    const found = this.records.get(hash);
    if (found === undefined || found.kind !== kind) return undefined;
    this.records.delete(hash);
    return found;
  }

  private prune(nowUnix: number): void {
    for (const [key, record] of this.records) {
      if ((record.openUntilUnix ?? record.expiresAtUnix) <= nowUnix) this.records.delete(key);
    }
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * Whether `signer` has validly signed this transaction. The hint is only four
 * bytes and anyone can copy it, so it is a filter and the signature itself is
 * verified against the transaction hash.
 */
export function signedBy(tx: Transaction, signer: string): boolean {
  const keypair = Keypair.fromPublicKey(signer);
  const hint = keypair.signatureHint();
  const hash = tx.hash();
  return tx.signatures.some((s) => hint.equals(s.hint()) && keypair.verify(hash, s.signature()));
}
