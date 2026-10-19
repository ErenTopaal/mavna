/**
 * A request limit per client address, over fixed one-minute windows.
 *
 * Every endpoint is open to anyone, and several cost a ledger read or a call to
 * Circle, so one client asking in a loop would spend the sponsor's RPC quota and
 * patience for everyone. A minute is long enough to stop that and short enough
 * that a person who trips it is back almost at once.
 */
const WINDOW_MS = 60_000;

export class RequestLimiter {
  private readonly perMinute: number;
  private readonly windows = new Map<string, { startedMs: number; count: number }>();
  private lastSweepMs = 0;

  /** Zero turns the limit off. */
  constructor(perMinute: number) {
    if (!Number.isSafeInteger(perMinute) || perMinute < 0) {
      throw new Error(`A request limit must be a whole number, zero for none; got ${perMinute}.`);
    }
    this.perMinute = perMinute;
  }

  allow(address: string, nowMs: number): boolean {
    if (this.perMinute === 0) return true;
    this.sweep(nowMs);
    const window = this.windows.get(address);
    if (window === undefined || nowMs - window.startedMs >= WINDOW_MS) {
      this.windows.set(address, { startedMs: nowMs, count: 1 });
      return true;
    }
    if (window.count >= this.perMinute) return false;
    window.count += 1;
    return true;
  }

  /** Addresses currently counted. */
  get size(): number {
    return this.windows.size;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < WINDOW_MS) return;
    this.lastSweepMs = nowMs;
    for (const [address, window] of this.windows) {
      if (nowMs - window.startedMs >= WINDOW_MS) this.windows.delete(address);
    }
  }
}

/**
 * The client a request counts against.
 *
 * Behind a proxy every connection comes from the proxy, so the limit would be
 * one shared allowance for the whole world. A trusted proxy appends the address
 * it saw to X-Forwarded-For, and only that last entry is its word: anything
 * before it was written by the client and can say anything. Without a trusted
 * proxy the header is ignored outright for the same reason.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean,
): string {
  const socket = socketAddress ?? "unknown";
  if (!trustProxy || forwardedFor === undefined) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const last = header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .at(-1);
  return last ?? socket;
}
