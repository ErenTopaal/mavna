import { MavnaError } from "@mavna/core";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * A pool of accounts that exist only to carry sequence numbers for pre-signed
 * settlements.
 *
 * Sizing is the part that is easy to get wrong, and an earlier draft did. A
 * settlement ladder occupies consecutive sequence numbers on ONE channel, and
 * they must be consumed in order, so a permanent failure on one rung leaves a gap
 * the rest can never cross. One channel therefore serves exactly one in-flight
 * settlement, and is not reusable until that settlement lands or expires.
 *
 * Successes hold a channel for the length of a bridge, roughly twenty minutes.
 * Strandings hold one for the full validity window, a whole day. Strandings
 * dominate the pool by roughly four to one, which is why the pool is governed by
 * the same cap as the float rather than sized independently.
 */

export interface Channel {
  readonly keypair: Keypair;
  readonly address: string;
}

export interface ChannelPoolOptions {
  readonly channels: readonly Keypair[];
}

/** One lease as it is written down: who holds which channel, until when. */
export interface LeaseRecord {
  readonly owner: string;
  readonly channel: string;
  readonly untilUnix: number;
}

/**
 * A pool as it is written down. Carries secret keys, so it belongs only in
 * storage the operator keeps private, never in a log or a response.
 */
export interface ChannelPoolSnapshot {
  readonly secrets: readonly string[];
  readonly leases: readonly LeaseRecord[];
}

interface Lease {
  readonly channel: Channel;
  readonly heldFor: string;
  /**
   * A few minutes while the settlement waits for the user's signature, then
   * the settlement's maxTime, past which nothing can land on its sequence.
   */
  readonly untilUnix: number;
}

/**
 * How long past a lease's bound before its channel is reused. maxTime is
 * inclusive on the network and this clock is not the ledger's, so a settlement
 * can still land just after it looks expired from here.
 */
const RECLAIM_GRACE_SECONDS = 30;

export class ChannelPool {
  private readonly available: Channel[];
  private readonly leased = new Map<string, Lease>();
  /** Owners whose lease is not reclaimed at its end, whatever its bound says. */
  private keep: (owner: string) => boolean = () => false;

  constructor(options: ChannelPoolOptions) {
    if (options.channels.length === 0) {
      throw new MavnaError("A channel pool needs at least one channel.", { retryable: false });
    }
    this.available = options.channels.map((keypair) => ({
      keypair,
      address: keypair.publicKey(),
    }));
  }

  /** Rebuild a pool from what `snapshot` wrote, keys and live leases both. */
  static fromSnapshot(
    snapshot: ChannelPoolSnapshot,
    nowUnix: number,
    keep?: (owner: string) => boolean,
  ): ChannelPool {
    const pool = new ChannelPool({
      channels: snapshot.secrets.map((secret) => Keypair.fromSecret(secret)),
    });
    // before the leases, so one past its bound that must be kept is kept
    if (keep !== undefined) pool.holdWhile(keep);
    pool.restoreLeases(snapshot.leases, nowUnix);
    return pool;
  }

  /** Everything needed to rebuild this pool after a restart. */
  snapshot(): ChannelPoolSnapshot {
    const leased = [...this.leased.values()].map((lease) => lease.channel);
    return {
      secrets: [...this.available, ...leased].map((channel) => channel.keypair.secret()),
      leases: [...this.leased.values()].map((lease) => ({
        owner: lease.heldFor,
        channel: lease.channel.address,
        untilUnix: lease.untilUnix,
      })),
    };
  }

  /**
   * Put back leases written before a restart. Without them every channel looks
   * free, and the next settlement would be built on a sequence a held one
   * already occupies. A lease on a channel this pool does not have is ignored,
   * since nothing here could sign for it; one already past its bound is
   * dropped as reclaim would drop it.
   */
  restoreLeases(leases: readonly LeaseRecord[], nowUnix: number): void {
    for (const lease of leases) {
      if (lease.untilUnix + RECLAIM_GRACE_SECONDS < nowUnix && !this.keep(lease.owner)) continue;
      const index = this.available.findIndex((channel) => channel.address === lease.channel);
      const channel = this.available[index];
      if (channel === undefined) continue;
      // Two leases for one owner (state written before leases were keyed by
      // account, or edited): the later one is kept and the other channel goes
      // back to the pool, so no key drops out of the next snapshot.
      const earlier = this.leased.get(lease.owner);
      if (earlier !== undefined && earlier.untilUnix >= lease.untilUnix) continue;
      this.available.splice(index, 1);
      if (earlier !== undefined) this.available.push(earlier.channel);
      this.leased.set(lease.owner, { channel, heldFor: lease.owner, untilUnix: lease.untilUnix });
    }
  }

  /**
   * Take a channel for one settlement. Exhaustion is a refusal at quote time,
   * never a transfer breaking halfway, so this returns undefined rather than
   * throwing: the caller decides how to tell the user.
   *
   * A lease ends at `untilUnix` whether or not anyone releases it. Without that,
   * every settlement built and never signed would hold its channel forever, and
   * a few abandoned quotes would exhaust the pool. Asking again for the same
   * transfer hands back the channel it already holds and changes nothing else:
   * asking is free, so it must never lengthen a lease.
   */
  acquire(transferId: string, untilUnix: number, nowUnix: number): Channel | undefined {
    this.reclaim(nowUnix);
    const existing = this.leased.get(transferId);
    if (existing !== undefined) return existing.channel;
    const channel = this.available.pop();
    if (channel === undefined) return undefined;
    this.leased.set(transferId, { channel, heldFor: transferId, untilUnix });
    return channel;
  }

  /**
   * Add a channel the caller has just funded. A key already in the pool is
   * not added twice, since two entries for one account would hand its one
   * sequence to two settlements.
   */
  add(keypair: Keypair): void {
    const address = keypair.publicKey();
    const known =
      this.available.some((channel) => channel.address === address) ||
      [...this.leased.values()].some((lease) => lease.channel.address === address);
    if (known) return;
    this.available.push({ keypair, address });
  }

  /**
   * Bring a lease's end forward to `untilUnix` if it is later than that. For a
   * lease lengthened for something that then definitely did not happen.
   */
  limit(transferId: string, channelAddress: string, untilUnix: number): void {
    const lease = this.leased.get(transferId);
    if (lease === undefined || lease.channel.address !== channelAddress) return;
    this.leased.set(transferId, { ...lease, untilUnix: Math.min(lease.untilUnix, untilUnix) });
  }

  /** Whether this owner still holds a live lease on this channel. */
  holds(transferId: string, channelAddress: string, nowUnix: number): boolean {
    this.reclaim(nowUnix);
    return this.leased.get(transferId)?.channel.address === channelAddress;
  }

  /** Owners holding a live lease right now. */
  owners(nowUnix: number): string[] {
    this.reclaim(nowUnix);
    return [...this.leased.keys()];
  }

  /**
   * Lengthen a lease its owner still holds on this channel, to `untilUnix`.
   * False when the owner holds no live lease on it: the lease lapsed, or the
   * channel has since gone to someone else, whose settlement now owns the
   * sequence this owner's was built on.
   */
  extend(transferId: string, channelAddress: string, untilUnix: number, nowUnix: number): boolean {
    this.reclaim(nowUnix);
    const lease = this.leased.get(transferId);
    if (lease === undefined || lease.channel.address !== channelAddress) return false;
    this.leased.set(transferId, { ...lease, untilUnix: Math.max(lease.untilUnix, untilUnix) });
    return true;
  }

  /**
   * The key for a channel, for the owner of its lease and nobody else.
   *
   * Exists so a settlement stored as XDR can be signed at submission time: the
   * transaction names its channel as source, and the store holds no keys. A
   * channel that is free or leased to someone else carries another settlement's
   * sequence, or will, so signing for a former owner would spend it.
   */
  keypairFor(transferId: string, channelAddress: string): Keypair | undefined {
    const lease = this.leased.get(transferId);
    return lease?.channel.address === channelAddress ? lease.channel.keypair : undefined;
  }

  /**
   * Return a channel once its settlement has landed or its window has closed.
   * Releasing early would let a second ladder be built on sequence numbers the
   * first ladder still occupies. Named by channel as well as owner, because the
   * owner may already hold a newer lease, and freeing that one hands a live
   * sequence to someone else.
   */
  release(transferId: string, channelAddress: string): void {
    if (this.leased.get(transferId)?.channel.address !== channelAddress) return;
    this.free(transferId);
  }

  /**
   * Keep an owner's lease past its bound while `keep` says so: for a
   * transaction on the channel that may still land, whose sequence must not
   * pass to anyone else until its fate is known.
   */
  holdWhile(keep: (owner: string) => boolean): void {
    this.keep = keep;
  }

  private reclaim(nowUnix: number): void {
    for (const [owner, lease] of this.leased) {
      if (lease.untilUnix + RECLAIM_GRACE_SECONDS < nowUnix && !this.keep(owner)) {
        this.free(owner);
      }
    }
  }

  private free(transferId: string): void {
    const lease = this.leased.get(transferId);
    if (lease === undefined) return;
    this.leased.delete(transferId);
    this.available.push(lease.channel);
  }

  get availableCount(): number {
    return this.available.length;
  }

  get leasedCount(): number {
    return this.leased.size;
  }

  /** Channels no one leases right now. Public keys only. */
  freeAddresses(nowUnix: number): string[] {
    this.reclaim(nowUnix);
    return this.available.map((channel) => channel.address);
  }

  /** Lease this particular free channel, or undefined when it is not free. */
  acquireThis(
    transferId: string,
    channelAddress: string,
    untilUnix: number,
    nowUnix: number,
  ): Channel | undefined {
    this.reclaim(nowUnix);
    if (this.leased.has(transferId)) return undefined;
    const index = this.available.findIndex((channel) => channel.address === channelAddress);
    const channel = this.available[index];
    if (channel === undefined) return undefined;
    this.available.splice(index, 1);
    this.leased.set(transferId, { channel, heldFor: transferId, untilUnix });
    return channel;
  }

  /**
   * Take a channel out of the pool for good, once the account behind it is
   * gone. Only from its own lease, so nothing else can be on it meanwhile.
   */
  drop(transferId: string, channelAddress: string): void {
    if (this.leased.get(transferId)?.channel.address !== channelAddress) return;
    this.leased.delete(transferId);
  }

  /** Every channel's address, leased or not. Public keys only. */
  addresses(): string[] {
    return [...this.available, ...[...this.leased.values()].map((lease) => lease.channel)].map(
      (channel) => channel.address,
    );
  }

  /** Every channel in the pool, leased or not. */
  get size(): number {
    return this.available.length + this.leased.size;
  }
}
