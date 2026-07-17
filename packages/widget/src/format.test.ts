import type { Amount, Asset } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { formatAmount, shortenAddress } from "./format.js";

const asset = (decimals: number): Asset => ({
  chainId: "stellar-testnet",
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals,
  curatedBy: "Circle",
});

const amount = (baseUnits: string, decimals: number): Amount => ({
  asset: asset(decimals),
  baseUnits,
});

describe("formatAmount", () => {
  it("places the point by decimals rather than by dividing", () => {
    expect(formatAmount(amount("247500000", 7))).toBe("24.75");
    expect(formatAmount(amount("1000000", 6))).toBe("1");
  });

  it("pads amounts smaller than one whole unit", () => {
    expect(formatAmount(amount("1", 7))).toBe("0.0000001");
    expect(formatAmount(amount("0", 7))).toBe("0");
  });

  it("drops trailing zeros so a column of amounts stays comparable", () => {
    expect(formatAmount(amount("10000000", 7))).toBe("1");
    expect(formatAmount(amount("15000000", 7))).toBe("1.5");
  });

  it("groups thousands", () => {
    expect(formatAmount(amount("1234567890000000", 7))).toBe("123,456,789");
    expect(formatAmount(amount("10000000000", 7))).toBe("1,000");
  });

  it("handles a zero-decimal asset without producing a stray point", () => {
    expect(formatAmount(amount("42", 0))).toBe("42");
  });

  /**
   * The reason this file avoids `Number` entirely.
   *
   * 2^53 is where doubles stop counting integers exactly. A 7-decimal Stellar
   * amount reaches that at roughly 900 million units, which is not a
   * hypothetical for an issued asset, and the failure is silent: the wrong digits
   * simply render.
   */
  it("stays exact past the range a double can represent", () => {
    expect(formatAmount(amount("90071992547409910", 7))).toBe("9,007,199,254.740991");
    expect(formatAmount(amount("99999999999999999", 7))).toBe("9,999,999,999.9999999");
  });
});

describe("shortenAddress", () => {
  it("keeps both ends, because both ends are what people compare", () => {
    expect(shortenAddress("GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU")).toBe(
      "GCKP…VJSU",
    );
  });

  it("leaves anything already short enough to read alone", () => {
    expect(shortenAddress("GCKPC23TA3D6")).toBe("GCKPC23TA3D6");
  });
});
