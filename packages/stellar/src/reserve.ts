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
  /** Network parameter, from the network config rather than hardcoded here. */
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
export function meetsFloor(quote: ReserveQuote, arriving: ArrivingValue): boolean {
  if (quote.slots === 0) return true; // nothing is being lent, so any size passes
  return arriving.stroopsOfXlm >= quote.floorStroops;
}

/**
 * The arriving value, already converted into XLM.
 *
 * A named type rather than a bare bigint, because the bug this replaces was a
 * bigint of USDC being compared against a bigint of XLM. Both are integers, both
 * carry seven decimals on Stellar, and nothing about either announces which asset
 * it is. The effect was a floor roughly six times too strict, telling people
 * their transfer was too small when it was not.
 *
 * Wrapping it means the conversion has to happen somewhere a reader can see.
 */
export interface ArrivingValue {
  readonly stroopsOfXlm: bigint;
}

/**
 * Convert an amount of some other asset into XLM, at a price read from the chain.
 *
 * `cost_decision.md` §9 is explicit that the floors are computed from the live
 * reserve cost and the live XLM price rather than stored as constants, so they
 * track the market without anyone editing a number. This is that conversion.
 *
 * The price is given as XLM per one whole unit of the asset, in stroops. Passing
 * it in rather than fetching it here keeps this package free of a network call on
 * a pure arithmetic path, and lets a caller cache a price across a batch of
 * quotes rather than asking once per route.
 */
export function valueInXlm(
  baseUnits: bigint,
  assetDecimals: number,
  xlmStroopsPerUnit: bigint,
): ArrivingValue {
  if (xlmStroopsPerUnit <= 0n) {
    throw new MavnaError(
      "Refusing to price a transfer against a non-positive XLM rate. A zero rate " +
        "would make every transfer look large enough, which is the direction that " +
        "costs the sponsor money.",
      { retryable: false },
    );
  }
  const scale = 10n ** BigInt(assetDecimals);
  return { stroopsOfXlm: (baseUnits * xlmStroopsPerUnit) / scale };
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
