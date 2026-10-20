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

/** One change to the open records, as it is appended to the built log. */
export type BuiltChange = { readonly add: BuiltRecord } | { readonly drop: string };

export class BuiltLedger {
  private readonly records = new Map<string, BuiltRecord>();
  /** Told of every record added, pushed out or handed out. Expiry needs no telling. */
  private listener: (change: BuiltChange) => void = () => {};
  private readonly capacity: number;
  /** Which client asked for each open record, by hash. Kept in memory only. */
  private readonly clients = new Map<string, string>();

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

  /** Hear every change from now on, to write it down as it happens. */
  watch(listener: (change: BuiltChange) => void): void {
    this.listener = listener;
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
  record(record: BuiltRecord, nowUnix: number, client?: string): void {
    this.prune(nowUnix);
    // A few open builds per account and kind for each client, the latest.
    // Asking again builds afresh, and each answer would otherwise add one more
    // record. Counted per client, because anyone may build for any account,
    // and pushing out the owner's own build would void what they just signed.
    const same = [...this.records.values()].filter(
      (open) =>
        open.signer === record.signer &&
        open.kind === record.kind &&
        this.clients.get(open.hash) === client,
    );
    for (const stale of same.slice(0, Math.max(0, same.length - (OPEN_PER_ACCOUNT - 1)))) {
      this.records.delete(stale.hash);
      this.clients.delete(stale.hash);
      this.listener({ drop: stale.hash });
    }
    this.records.set(record.hash, record);
    this.listener({ add: record });
    if (client !== undefined) this.clients.set(record.hash, client);
  }

  /** Open records this client asked for. */
  openFor(client: string, nowUnix: number): number {
    this.prune(nowUnix);
    let count = 0;
    for (const asker of this.clients.values()) if (asker === client) count += 1;
    return count;
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
    this.clients.delete(hash);
    this.listener({ drop: hash });
    return found;
  }

  private prune(nowUnix: number): void {
    for (const [key, record] of this.records) {
      if ((record.openUntilUnix ?? record.expiresAtUnix) <= nowUnix) {
        this.records.delete(key);
        this.clients.delete(key);
      }
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
  return tx.signatures.some(
    (s) => sameBytes(hint, s.hint.toBytes()) && keypair.verify(hash, s.signature.toBytes()),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
