import type { Amount } from "@mavna/core";

/**
 * Turning integer base units into something a person reads.
 *
 * There is no `Number` anywhere in this file and there never will be. An amount
 * arrives as an integer string in base units precisely so it survives the trip
 * intact, and parsing it to a float to add a decimal point would throw that away
 * at the last possible moment. 7-decimal Stellar amounts exceed what a double
 * represents exactly, so this would not be a theoretical defect.
 */
export function formatAmount(amount: Amount): string {
  const { baseUnits, asset } = amount;
  const negative = baseUnits.startsWith("-");
  const digits = negative ? baseUnits.slice(1) : baseUnits;
  const padded = digits.padStart(asset.decimals + 1, "0");
  const cut = padded.length - asset.decimals;

  const whole = padded.slice(0, cut);
  const fraction = asset.decimals === 0 ? "" : padded.slice(cut);

  // Trailing zeros carry no information and make columns of amounts harder to
  // compare at a glance, so "1.5000000" reads as "1.5".
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end -= 1;
  const trimmed = fraction.slice(0, end);

  return `${negative ? "-" : ""}${group(whole)}${trimmed === "" ? "" : `.${trimmed}`}`;
}

function group(whole: string): string {
  let out = "";
  for (let i = 0; i < whole.length; i += 1) {
    const fromEnd = whole.length - i;
    if (i > 0 && fromEnd % 3 === 0) out += ",";
    out += whole[i];
  }
  return out;
}

/**
 * Stellar addresses are 56 characters and nobody reads them in full.
 *
 * Both ends are kept because that is what a user compares against their wallet;
 * an abbreviation that keeps only the start is worse than useless for the one
 * thing people actually do with it.
 */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
