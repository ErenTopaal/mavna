import { describe, expect, it } from "vitest";
import { clientAddress, RequestLimiter } from "./ratelimit.js";

describe("a per-address request limit", () => {
  it("lets an address make its allowance in a minute and refuses the next", () => {
    const limiter = new RequestLimiter(3);
    expect([1, 2, 3, 4].map(() => limiter.allow("a", 0))).toEqual([true, true, true, false]);
  });

  it("counts each address on its own", () => {
    const limiter = new RequestLimiter(1);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
  });

  it("starts over once the minute has passed", () => {
    const limiter = new RequestLimiter(1);
    limiter.allow("a", 0);
    expect(limiter.allow("a", 59_999)).toBe(false);
    expect(limiter.allow("a", 60_000)).toBe(true);
  });

  it("forgets addresses whose minute is over, so the map cannot grow without bound", () => {
    const limiter = new RequestLimiter(5);
    for (let n = 0; n < 100; n += 1) limiter.allow(`addr-${n}`, 0);
    limiter.allow("late", 60_000);
    expect(limiter.size).toBe(1);
  });

  it("allows everything when the limit is zero", () => {
    const limiter = new RequestLimiter(0);
    expect(Array.from({ length: 1000 }, () => limiter.allow("a", 0)).every(Boolean)).toBe(true);
  });
});

describe("whose request it is", () => {
  it("is the connecting address when no proxy is trusted, whatever the headers claim", () => {
    expect(clientAddress("10.0.0.1", "203.0.113.9", false)).toBe("10.0.0.1");
  });

  it("is the address the trusted proxy appended, not one the client wrote before it", () => {
    expect(clientAddress("10.0.0.1", "198.51.100.7, 203.0.113.9", true)).toBe("203.0.113.9");
  });

  it("falls to the connecting address when a trusted proxy sent no header", () => {
    expect(clientAddress("10.0.0.1", undefined, true)).toBe("10.0.0.1");
  });
});
