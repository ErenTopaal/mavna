import { describe, expect, it } from "vitest";
import { canonicalToLocal, localToCanonical } from "./delivery.js";

/**
 * The decimal boundary.
 *
 * CCTP message amounts are always six decimals; Stellar's USDC is seven. This is
 * the exact place where someone reaches for a float and loses a user's money in
 * the seventh decimal.
 */

describe("canonical to local", () => {
  it("scales six decimals up to seven", () => {
    // 1 USDC: 1_000_000 canonical becomes 10_000_000 local.
    expect(canonicalToLocal("1000000")).toBe("10000000");
    expect(canonicalToLocal("0")).toBe("0");
  });

  it("stays exact far beyond what a double can represent", () => {
    const huge = "9007199254740993";
    // A float would round this. Integer arithmetic does not.
    expect(canonicalToLocal(huge)).toBe("90071992547409930");
  });

  it("refuses anything that is not integer base units", () => {
    for (const bad of ["1.5", "-1", "1e6", "", "0x10"]) {
      expect(() => canonicalToLocal(bad)).toThrow();
    }
  });
});

describe("local to canonical", () => {
  it("scales seven decimals down and reports the dust", () => {
    expect(localToCanonical("10000000")).toEqual({ canonical: "1000000", dust: "0" });
  });

  it("does not silently discard the seventh decimal", () => {
    // The dust stays with the sender. Reporting it is what stops it becoming a
    // rounding error nobody can account for.
    expect(localToCanonical("10000007")).toEqual({ canonical: "1000000", dust: "7" });
    expect(localToCanonical("9")).toEqual({ canonical: "0", dust: "9" });
  });

  it("round trips exactly when there is no dust", () => {
    for (const canonical of ["1", "1000000", "123456789"]) {
      expect(localToCanonical(canonicalToLocal(canonical)).canonical).toBe(canonical);
      expect(localToCanonical(canonicalToLocal(canonical)).dust).toBe("0");
    }
  });

  it("never loses value: canonical times ten plus dust equals the original", () => {
    for (const local of ["1", "7", "10000007", "99999999999"]) {
      const { canonical, dust } = localToCanonical(local);
      expect(BigInt(canonical) * 10n + BigInt(dust)).toBe(BigInt(local));
    }
  });
});
