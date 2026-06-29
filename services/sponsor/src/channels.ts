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
   */
  acquire(transferId: string): Channel | undefined {
    if (this.leased.has(transferId)) return this.leased.get(transferId)?.channel;
    const channel = this.available.pop();
    if (channel === undefined) return undefined;
    this.leased.set(transferId, { channel, heldFor: transferId });
    return channel;
  }

  /**
   * Return a channel once its settlement has landed or its window has closed.
   * Releasing early would let a second ladder be built on sequence numbers the
   * first ladder still occupies.
   */
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
