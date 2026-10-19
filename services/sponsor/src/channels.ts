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
  /** The settlement's maxTime. Past it nothing can land on this channel's sequence. */
  readonly untilUnix: number;
}

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
    for (const [owner, lease] of this.leased) {
      if (lease.untilUnix <= nowUnix) this.release(owner);
    }
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
   * Return a channel once its settlement has landed or its window has closed.
   * Releasing early would let a second ladder be built on sequence numbers the
   * first ladder still occupies.
   */
  /**
   * The key for a channel this pool owns, by address.
   *
   * Exists so a settlement stored as XDR can be signed at submission time: the
   * transaction names its channel as source, and the store holds no keys.
   */
  keypairFor(address: string): Keypair | undefined {
    const leased = [...this.leased.values()].find((l) => l.channel.address === address);
    if (leased !== undefined) return leased.channel.keypair;
    return this.available.find((c) => c.address === address)?.keypair;
  }

  release(transferId: string): void {
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
