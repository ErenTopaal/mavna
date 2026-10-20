/**
 * Transfers this browser has seen, without an account.
 *
 * The requirement is that a returning user finds their history having never
 * created an account, given an email, or saved anything. So this is the
 * browser's own storage and nothing else: no server, no identifier, nothing that
 * leaves the machine.
 *
 * What that honestly buys and does not buy is worth being clear about, because
 * the interface has to say it rather than imply otherwise. It survives a reload,
 * a closed tab and a restarted browser. It does not survive a different device,
 * a different browser, or clearing site data. A user who loses it is not stuck:
 * every transfer is recoverable from a transaction hash or the destination
 * address alone, which is what the lookup page is for. History is a convenience
 * on top of that, never the only way back to your money.
 */

const KEY = "mavna.transfers.v1";
/** Enough to be useful, small enough that storage never becomes a problem. */
const KEEP = 50;

export interface TransferRecord {
  /** The source-chain transaction. The primary way back to this transfer. */
  readonly sourceTxHash: string;
  readonly sourceChainId: string;
  readonly sourceChainName: string;
  readonly destination: string;
  /** Base units, as a string. Never a number: this is money. */
  readonly sendsBaseUnits: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Seconds since the epoch, so a record is orderable without parsing a date. */
  readonly startedAtUnix: number;
  readonly explorerUrl: string | undefined;
}

/** Reads what is there, and treats anything unreadable as nothing. */
export function readHistory(key: string = KEY): readonly TransferRecord[] {
  migrateUnnetworked(key);
  return readStored(key);
}

const NETWORKED = /\.(testnet|mainnet)$/;

/**
 * History used to be one list for every network, under the key without the
 * network suffix. Only testnet was served then, so that list is testnet's: it
 * is folded into the testnet list, newest first and without repeats, and the
 * old key removed. Done on any read, so it never shows on mainnet first.
 */
function migrateUnnetworked(key: string): void {
  if (!NETWORKED.test(key)) return;
  const old = key.replace(NETWORKED, "");
  let present: boolean;
  try {
    present = window.localStorage.getItem(old) !== null;
  } catch {
    return;
  }
  if (!present) return;
  const testnet = `${old}.testnet`;
  const kept = readStored(testnet);
  const seen = new Set(kept.map((r) => r.sourceTxHash));
  const moved = readStored(old).filter((r) => !seen.has(r.sourceTxHash));
  const merged = [...kept, ...moved]
    .sort((a, b) => b.startedAtUnix - a.startedAtUnix)
    .slice(0, KEEP);
  try {
    window.localStorage.setItem(testnet, JSON.stringify(merged));
    window.localStorage.removeItem(old);
  } catch {
    // storage refused: the old list stays where it was and is tried again next read
  }
}

function readStored(key: string): readonly TransferRecord[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Storage is user-writable and shared with anything else on this origin, so
    // it is untrusted input like any other. A malformed record is dropped rather
    // than rendered.
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

/**
 * Record a transfer, newest first, without duplicating one already there.
 *
 * Keyed on the source transaction because that is the thing that is genuinely
 * unique: the same address can be sent to many times, and the same amount many
 * times over.
 */
export function remember(record: TransferRecord, key: string = KEY): readonly TransferRecord[] {
  const existing = readHistory(key).filter((r) => r.sourceTxHash !== record.sourceTxHash);
  const next = [record, ...existing].slice(0, KEEP);
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage can be full or disabled outright. Losing the convenience is
    // acceptable; failing the transfer over it is not, so this stays quiet.
  }
  return next;
}

/** Drop one transfer, by the source transaction it was recorded under. */
export function forget(sourceTxHash: string, key: string = KEY): void {
  const next = readHistory(key).filter((r) => r.sourceTxHash !== sourceTxHash);
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Same reasoning as in remember.
  }
}

export function forgetHistory(key: string = KEY): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same reasoning as above.
  }
}

function isRecord(value: unknown): value is TransferRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sourceTxHash === "string" &&
    typeof r.sourceChainId === "string" &&
    typeof r.sourceChainName === "string" &&
    typeof r.destination === "string" &&
    typeof r.sendsBaseUnits === "string" &&
    typeof r.symbol === "string" &&
    typeof r.decimals === "number" &&
    typeof r.startedAtUnix === "number"
  );
}
