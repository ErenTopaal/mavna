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

export class BuiltLedger {
  private readonly records = new Map<string, BuiltRecord>();

  /** Rebuild a ledger from what `snapshot` wrote, less what expired meanwhile. */
  static fromSnapshot(records: readonly BuiltRecord[], nowUnix: number): BuiltLedger {
    const ledger = new BuiltLedger();
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
    this.records.set(record.hash, record);
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
      if (record.expiresAtUnix <= nowUnix) this.records.delete(key);
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
