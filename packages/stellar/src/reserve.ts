import { MavnaError } from "@mavna/core";
import type { DestinationLane } from "./destination.js";

/**
 * What sponsorship costs, and what a user must be sending before it is possible.
 *
 * All of this follows from one measured fact: Stellar locks a deposit per unit of
 * ledger space, an account occupies 2 units and each trustline 1, at 0.5 XLM per
 * unit. See resources/cost_decision.md, which is the authority.
 */

/** Slots consumed by holding one additional asset. */
const SLOTS_PER_TRUSTLINE = 1;

export interface ReserveQuote {
  /** Reserve slots the sponsor must cover. Zero means no sponsorship is needed. */
  readonly slots: number;
  /** Those slots in stroops, at the network's current base reserve. */
  readonly stroops: bigint;
  /** The same amount in whole XLM, for display. */
  readonly xlm: string;
  /**
   * The minimum a user must be sending for this to be recoverable at all.
   * Below the bare deposit there is not enough arriving to convert back, so
   * recovery is not unlikely, it is impossible.
   */
  readonly floorStroops: bigint;
}

export interface ReserveInputs {
  /** What the destination needs, from inspectDestination. */
  readonly lane: DestinationLane;
  /** True when the asset the user wants differs from the asset the bridge delivers. */
  readonly destinationAssetDiffers: boolean;
  /** Network parameter, read from a ledger header rather than assumed. */
  readonly baseReserveStroops: number;
  /**
   * Multiple of the bare deposit used as the minimum transfer size. Four gives
   * comfortable headroom above the point where recovery becomes impossible,
   * without excluding the small transfers this product exists to serve.
   */
  readonly floorMultiple?: number;
}

const DEFAULT_FLOOR_MULTIPLE = 4;

/**
 * Work out what the sponsor is being asked to lend for one transfer.
 *
 * The second trustline is the expensive case and it is also the product's headline
 * feature: bringing value into an asset other than the one bridged needs one
 * permission to receive the bridge and another to receive the swap.
 */
export function quoteReserve(inputs: ReserveInputs): ReserveQuote {
  const { lane, destinationAssetDiffers, baseReserveStroops } = inputs;

  if (baseReserveStroops <= 0) {
    throw new MavnaError("Base reserve must be read from the network before quoting.", {
      retryable: false,
    });
  }

  let slots = lane.slotsNeeded;

  // A second permission is only needed where the destination asset differs AND we
  // are already opening the first one. An account that is ready for the bridged
  // asset may still be missing the destination asset, which inspectDestination
  // reports separately by being called again for that asset.
  if (destinationAssetDiffers && slots > 0) {
    slots += SLOTS_PER_TRUSTLINE;
  }

  const stroops = BigInt(slots) * BigInt(baseReserveStroops);
  const multiple = BigInt(inputs.floorMultiple ?? DEFAULT_FLOOR_MULTIPLE);

  return {
    slots,
    stroops,
    xlm: stroopsToXlm(stroops),
    floorStroops: stroops * multiple,
  };
}

/**
 * Whether a transfer is large enough for the sponsorship to be recoverable.
 *
 * This is an arithmetic boundary, not a defence against abuse. Below the deposit
 * there is simply not enough arriving value to convert back into the XLM the user
 * needs, so every such transfer would be a guaranteed loss rather than a risk.
 * Abuse is bounded by the daily caps instead.
 */
export function meetsFloor(quote: ReserveQuote, arrivingValueStroops: bigint): boolean {
  if (quote.slots === 0) return true; // nothing is being lent, so any size passes
  return arrivingValueStroops >= quote.floorStroops;
}

/**
 * The message shown when a transfer is below the floor. Guidance with a way
 * forward, never a refusal: this is checked at quote time, before the user has
 * committed to anything.
 */
export function belowFloorGuidance(quote: ReserveQuote): string {
  return (
    `This transfer is too small to set up a new Stellar account. ` +
    `Send at least ${stroopsToXlm(quote.floorStroops)} XLM of value, ` +
    `or send to an address that already has one.`
  );
}

const STROOPS_PER_XLM = 10_000_000n;

/** Exact conversion. Amounts are integers in base units; no floating point, ever. */
export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = stroops % STROOPS_PER_XLM;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}.${padded}`;
}

export function xlmToStroops(xlm: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(xlm)) {
    throw new MavnaError(`Not a valid XLM amount: ${xlm}`, { retryable: false });
  }
  const [whole, fraction = ""] = xlm.split(".");
  return BigInt(whole ?? "0") * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, "0"));
}
