import { MavnaError } from "@mavna/core";
import type { Keypair } from "@stellar/stellar-sdk";

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

  constructor(options: ChannelPoolOptions) {
    if (options.channels.length === 0) {
      throw new MavnaError("A channel pool needs at least one channel.", { retryable: false });
    }
    this.available = options.channels.map((keypair) => ({
      keypair,
      address: keypair.publicKey(),
    }));
  }

  /**
   * Take a channel for one settlement. Exhaustion is a refusal at quote time,
   * never a transfer breaking halfway, so this returns undefined rather than
   * throwing: the caller decides how to tell the user.
   *
   * A lease ends at `untilUnix` whether or not anyone releases it. Without that,
   * every settlement built and never signed would hold its channel forever, and
   * a few abandoned quotes would exhaust the pool. Asking again for the same
   * transfer only ever extends the lease, because the earlier settlement may
   * still be live on the same sequence.
   */
  acquire(transferId: string, untilUnix: number, nowUnix: number): Channel | undefined {
    this.reclaim(nowUnix);
    const existing = this.leased.get(transferId);
    if (existing !== undefined) {
      this.leased.set(transferId, {
        ...existing,
        untilUnix: Math.max(existing.untilUnix, untilUnix),
      });
      return existing.channel;
    }
    const channel = this.available.pop();
    if (channel === undefined) return undefined;
    this.leased.set(transferId, { channel, heldFor: transferId, untilUnix });
    return channel;
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

  private reclaim(nowUnix: number): void {
    for (const [owner, lease] of this.leased) {
      if (lease.untilUnix + RECLAIM_GRACE_SECONDS < nowUnix) this.free(owner);
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
}
