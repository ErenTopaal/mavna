import { MavnaError } from "@mavna/core";
import { describe, expect, it } from "vitest";
import {
  belowFloorGuidance,
  meetsFloor,
  quoteReserve,
  stroopsToXlm,
  valueInXlm,
  xlmToStroops,
} from "./reserve.js";

const BASE_RESERVE = 5_000_000;

describe("stroopsToXlm", () => {
  it("writes whole and fractional amounts exactly", () => {
    expect(stroopsToXlm(0n)).toBe("0");
    expect(stroopsToXlm(10_000_000n)).toBe("1");
    expect(stroopsToXlm(12_345_678n)).toBe("1.2345678");
    expect(stroopsToXlm(5n)).toBe("0.0000005");
    expect(stroopsToXlm(15_000_000n)).toBe("1.5");
  });

  it("puts the sign in front of a negative amount, which spare reserve can be", () => {
    expect(stroopsToXlm(-12_345_678n)).toBe("-1.2345678");
    expect(stroopsToXlm(-5n)).toBe("-0.0000005");
    expect(stroopsToXlm(-10_000_000n)).toBe("-1");
  });
});

describe("xlmToStroops", () => {
  it("reads up to seven decimals", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("1.2345678")).toBe(12_345_678n);
    expect(xlmToStroops("0.5")).toBe(5_000_000n);
  });

  it("refuses more decimals than a stroop, signs and words", () => {
    for (const bad of ["1.23456789", "-1", "+1", "1e3", "", "one"]) {
      expect(() => xlmToStroops(bad)).toThrow(MavnaError);
    }
  });

  it("round trips with stroopsToXlm", () => {
    for (const s of [0n, 1n, 9_999_999n, 10_000_001n, 123_456_789_012n]) {
      expect(xlmToStroops(stroopsToXlm(s))).toBe(s);
    }
  });
});

describe("quoteReserve", () => {
  it("costs nothing for a destination that is ready", () => {
    const quote = quoteReserve({
      lane: { kind: "ready", slotsNeeded: 0 },
      destinationAssetDiffers: true,
      baseReserveStroops: BASE_RESERVE,
    });
    expect(quote).toEqual({ slots: 0, stroops: 0n, xlm: "0", floorStroops: 0n });
  });

  it("adds the second trustline only when it is already opening the first", () => {
    const opening = quoteReserve({
      lane: { kind: "needs-trustline", slotsNeeded: 1 },
      destinationAssetDiffers: true,
      baseReserveStroops: BASE_RESERVE,
    });
    expect(opening.slots).toBe(2);
    expect(opening.stroops).toBe(10_000_000n);
    expect(opening.xlm).toBe("1");
    expect(opening.floorStroops).toBe(40_000_000n);
  });

  it("prices a new account with one trustline at three slots", () => {
    const quote = quoteReserve({
      lane: { kind: "needs-account", slotsNeeded: 3 },
      destinationAssetDiffers: false,
      baseReserveStroops: BASE_RESERVE,
      floorMultiple: 2,
    });
    expect(quote.slots).toBe(3);
    expect(quote.stroops).toBe(15_000_000n);
    expect(quote.floorStroops).toBe(30_000_000n);
  });

  it("refuses to quote before the base reserve is known", () => {
    expect(() =>
      quoteReserve({
        lane: { kind: "needs-trustline", slotsNeeded: 1 },
        destinationAssetDiffers: false,
        baseReserveStroops: 0,
      }),
    ).toThrow(MavnaError);
  });
});

describe("the floor", () => {
  const quote = quoteReserve({
    lane: { kind: "needs-trustline", slotsNeeded: 1 },
    destinationAssetDiffers: false,
    baseReserveStroops: BASE_RESERVE,
  });

  it("passes a transfer worth at least the floor and refuses one under it", () => {
    expect(meetsFloor(quote, { stroopsOfXlm: quote.floorStroops })).toBe(true);
    expect(meetsFloor(quote, { stroopsOfXlm: quote.floorStroops - 1n })).toBe(false);
  });

  it("passes anything when nothing is lent", () => {
    const free = quoteReserve({
      lane: { kind: "ready", slotsNeeded: 0 },
      destinationAssetDiffers: false,
      baseReserveStroops: BASE_RESERVE,
    });
    expect(meetsFloor(free, { stroopsOfXlm: 0n })).toBe(true);
  });

  it("names the floor in XLM in its guidance", () => {
    expect(belowFloorGuidance(quote)).toMatch(/at least 2 XLM/);
  });
});

describe("valueInXlm", () => {
  it("converts base units at the given rate, rounding down", () => {
    // 2.5 USDC (7 decimals) at 5.6920949 XLM each
    expect(valueInXlm(25_000_000n, 7, 56_920_949n)).toEqual({ stroopsOfXlm: 142_302_372n });
    // 1 unit of a 6 decimal token at 3 XLM
    expect(valueInXlm(1_000_000n, 6, 30_000_000n)).toEqual({ stroopsOfXlm: 30_000_000n });
    expect(valueInXlm(1n, 7, 3n)).toEqual({ stroopsOfXlm: 0n });
  });

  it("refuses a rate that is not positive", () => {
    expect(() => valueInXlm(1n, 7, 0n)).toThrow(MavnaError);
    expect(() => valueInXlm(1n, 7, -1n)).toThrow(MavnaError);
  });
});
