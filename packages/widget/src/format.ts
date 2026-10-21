/*
 * The small number and address helpers the design uses, ported verbatim so the
 * figures read exactly as designed, and given real base-unit conversion so
 * nothing goes through a float where money is concerned.
 */
import { type Amount, stellarAddress } from "@mavna/core";

// seven places is the most any Stellar asset carries, so no amount here has more;
// at two a review said 10.13 for a route that sends 10.126789, and rounded a
// guaranteed minimum up past what is guaranteed
const FIGURE = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 7,
});

/** The design's `fmt`: a grouped figure, two decimals at least and every one it has. */
export function fmt(value: number): string {
  return FIGURE.format(value);
}

/**
 * An amount read straight from its base units, so nothing passes through a
 * float: grouped, at least two places, and cut toward zero past `places`. The
 * sent amount takes every place it has, which is what the wallet is asked to
 * sign; a minimum takes seven and can only read lower than it is, never higher.
 */
export function fmtAmount(amount: Amount, places = Number.POSITIVE_INFINITY): string {
  const value = BigInt(amount.baseUnits);
  const decimals = amount.asset.decimals;
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toLocaleString("en-US");
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, Math.min(decimals, places))
    .replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** The design's `short`: a 5…4 elision for anything longer than 12 characters. */
export function short(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 5)}…${address.slice(-4)}`;
}

/**
 * The design's `destValid`: an address value can be paid to, an account (G), a
 * muxed account (M) or a contract (C), with its checksum checked too. A
 * mistyped one has the right shape, so a shape check passed it here while
 * every rail refused it as not an address. What each rail can deliver to is
 * that rail's answer, given when it quotes.
 */
export function destValid(address: string): boolean {
  return stellarAddress.safeParse(address.trim()).success;
}

/**
 * Decimal text to integer base units, string arithmetic throughout.
 *
 * Ported from Transfer.tsx. `Number("0.1") * 1e6` is 100000.00000000001, and
 * truncating that is how an amount quietly loses its last unit.
 */
export function toBaseUnits(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return "0";
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}

/** Integer base units to a JS number for display formatting only. */
export function fromBaseUnits(baseUnits: string, decimals: number): number {
  const scale = 10 ** decimals;
  return Number(BigInt(baseUnits)) / scale;
}

/** The decimal value of an Amount, for display formatting only. */
export function amountValue(amount: Amount): number {
  return fromBaseUnits(amount.baseUnits, amount.asset.decimals);
}

/**
 * Base units to a figure in the asset's own decimals: at least two places, and
 * as many more as the amount needs up to eight, so 0.0003 ETH of gas reads as
 * that and not as 0.00. String arithmetic, so nothing is rounded up.
 */
export function fmtUnits(baseUnits: string, decimals: number): string {
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = FIGURE.format(Number(value / scale)).split(".")[0] ?? "0";
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, 8)
    .replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
