import { describe, expect, it } from "vitest";
import aquariusPools from "./__fixtures__/aquarius-pools.json" with { type: "json" };
import circleFees from "./__fixtures__/circle-fees.json" with { type: "json" };
import {
  baseUnits,
  basisPoints,
  displayText,
  futureUnixSeconds,
  parseFrom,
  positiveBaseUnits,
  stellarAddress,
  txHashHex,
} from "./schema.js";

/**
 * The fixtures here were captured live from the real services during this phase.
 * They exist for speed, not as the correctness proof: the live suite is what
 * proves a transfer works. Writing that boundary down is what stops fixtures
 * quietly becoming the thing everyone trusts.
 */

describe("amounts", () => {
  it("accepts integer base units and rejects everything that is not", () => {
    expect(baseUnits.safeParse("1000000").success).toBe(true);
    expect(baseUnits.safeParse("0").success).toBe(true);

    // Every one of these has caused a real bug in a real payments system.
    for (const bad of ["1.5", "-1", "1e6", "", " 1", "1 ", "0x10", "1,000"]) {
      expect(baseUnits.safeParse(bad).success, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("handles amounts far beyond what a double can represent exactly", () => {
    const huge = "9007199254740993000000";
    expect(baseUnits.safeParse(huge).success).toBe(true);
    expect(BigInt(huge).toString()).toBe(huge);
  });

  it("rejects zero where a positive amount is required", () => {
    expect(positiveBaseUnits.safeParse("0").success).toBe(false);
    expect(positiveBaseUnits.safeParse("1").success).toBe(true);
  });

  it("rejects a non-integer as positive base units rather than throwing", () => {
    for (const bad of ["1.5", "-1", "1e6", ""]) {
      expect(positiveBaseUnits.safeParse(bad).success).toBe(false);
    }
  });
});

describe("addresses", () => {
  it("accepts the three Stellar forms that can receive value", () => {
    expect(
      stellarAddress.safeParse("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").success,
    ).toBe(true);
    expect(
      stellarAddress.safeParse("CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ").success,
    ).toBe(true);
  });

  it("accepts a muxed account and refuses an address whose checksum or length is wrong", () => {
    expect(
      stellarAddress.safeParse(
        "MDSZMCDO6MT4WOHOCFNWLSIZZ7FVFZEDAOOTAKAUXKT6XZICPJ3YUAAAAAAETFQC2LMBS",
      ).success,
    ).toBe(true);
    for (const bad of [
      // the last character changed, so the checksum no longer holds
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6",
      // one character too many
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5A",
      // a G body under a C prefix
      "CBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      `G${"A".repeat(60)}`,
    ]) {
      expect(stellarAddress.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects a secret key outright", () => {
    // An S-address reaching a schema means something upstream is handling keys.
    expect(
      stellarAddress.safeParse("SAOJHTVFCYVKUMPNQI7PWFWHCLBQNPKUHVTVNDHYVJKNHTNLQOKQVQFT").success,
    ).toBe(false);
  });

  it("rejects lookalikes rather than tolerating them", () => {
    for (const bad of [
      "",
      "G",
      "gbbd47if6lwk7p7mdevscwr7dpuwv3ny3dtqevfl4nat4aqh3zllfla5",
      "0x1234",
    ]) {
      expect(stellarAddress.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts transaction hashes with or without a prefix, because services differ", () => {
    const hash = "2b66cae735da3265a586c1adfb2827333efd570702f495657729de305246fb34";
    expect(txHashHex.safeParse(hash).success).toBe(true);
    expect(txHashHex.safeParse(`0x${hash}`).success).toBe(true);
    expect(txHashHex.safeParse(hash.slice(0, 63)).success).toBe(false);
  });
});

describe("bounded exposure", () => {
  it("refuses slippage outside nought to one hundred percent", () => {
    expect(basisPoints.safeParse(50).success).toBe(true);
    expect(basisPoints.safeParse(10_000).success).toBe(true);
    // A remote response must not be able to smuggle in unbounded slippage.
    expect(basisPoints.safeParse(10_001).success).toBe(false);
    expect(basisPoints.safeParse(-1).success).toBe(false);
  });

  it("refuses a deadline that has already passed", () => {
    expect(futureUnixSeconds.safeParse(Math.floor(Date.now() / 1000) - 10).success).toBe(false);
    expect(futureUnixSeconds.safeParse(Math.floor(Date.now() / 1000) + 600).success).toBe(true);
  });
});

describe("attacker-influenced display text", () => {
  it("strips control characters that a remote asset list could smuggle in", () => {
    const nasty = "USD\u0000C\u001b[31m";
    const cleaned = displayText.parse(nasty);
    expect(cleaned).not.toContain("\u0000");
    expect(cleaned).not.toContain("\u001b");
    expect(cleaned).toBe("USDC[31m");
  });

  it("bounds the length so a response cannot push a layout around", () => {
    expect(displayText.safeParse("a".repeat(201)).success).toBe(false);
  });
});

describe("errors name their source", () => {
  it("says which service sent something unusable", () => {
    expect(() => parseFrom("Circle attestation", baseUnits, "not-a-number")).toThrow(
      /Circle attestation/,
    );
  });
});

describe("against responses actually captured from the live services", () => {
  it("Circle's fee response has the shape we build against", () => {
    // Captured live. Standard transfer, threshold 2000, is free from every source.
    expect(Array.isArray(circleFees)).toBe(true);
    const standard = (circleFees as { finalityThreshold: number; minimumFee: number }[]).find(
      (row) => row.finalityThreshold === 2000,
    );
    expect(standard).toBeDefined();
    expect(standard?.minimumFee).toBe(0);
  });

  it("Aquarius returns pools on testnet, which is why it is the testnet swap source", () => {
    const pools = aquariusPools as { count: number; results: unknown[] };
    // Soroswap's own health endpoint reports an empty testnet, so this is the
    // provider that makes testnet swaps possible at all.
    expect(pools.count).toBeGreaterThan(0);
    expect(pools.results.length).toBeGreaterThan(0);
  });
});
