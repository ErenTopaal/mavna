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
}

export class BuiltLedger {
  private readonly records = new Map<string, BuiltRecord>();

  record(record: BuiltRecord): void {
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
    for (const [key, record] of this.records) {
      if (record.expiresAtUnix <= nowUnix) this.records.delete(key);
    }
    const found = this.records.get(hash);
    if (found === undefined || found.kind !== kind) return undefined;
    this.records.delete(hash);
    return found;
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
