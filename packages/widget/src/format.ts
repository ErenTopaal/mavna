/*
 * The small number and address helpers the design uses, ported verbatim so the
 * figures read exactly as designed, and given real base-unit conversion so
 * nothing goes through a float where money is concerned.
 */
import type { Amount } from "@mavna/core";

const TWO_DP = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** The design's `fmt`: a plain two-decimal grouped figure. */
export function fmt(value: number): string {
  return TWO_DP.format(value);
}

/** The design's `short`: a 5…4 elision for anything longer than 12 characters. */
export function short(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 5)}…${address.slice(-4)}`;
}

/** The design's `destValid`: a Stellar public key, 56 chars starting with G. */
export function destValid(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address.trim());
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
