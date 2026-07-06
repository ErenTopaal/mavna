import { describe, expect, it } from "vitest";
import { applySlippage } from "./provider.js";
import { protocolsFor } from "./soroswap.js";

describe("slippage bounds the user's exposure", () => {
  it("reduces the floor by exactly the tolerance", () => {
    expect(applySlippage("1000000", 50)).toBe("995000");
    expect(applySlippage("1000000", 0)).toBe("1000000");
  });

  it("rounds the floor DOWN, never up", () => {
    // Promising a floor higher than the maths supports is worse than useless.
    expect(applySlippage("999", 50)).toBe("994");
  });

  it("stays exact on amounts a double would mangle", () => {
    expect(applySlippage("90071992547409930000", 100)).toBe("89171272621935830700");
  });

  it("refuses unbounded slippage rather than accepting it", () => {
    // Unbounded slippage is not acceptable on any path, and a remote response
    // must not be able to smuggle it in.
    expect(() => applySlippage("1000", 10_001)).toThrow();
    expect(() => applySlippage("1000", -1)).toThrow();
    expect(() => applySlippage("1000", 1.5)).toThrow();
  });

  it("refuses anything that is not integer base units", () => {
    for (const bad of ["1.5", "-1", "", "1e6"]) {
      expect(() => applySlippage(bad, 50)).toThrow();
    }
  });
});

describe("venue choice follows the destination, not the price", () => {
  it("excludes the classic orderbook when paying a contract", () => {
    // A classic path payment cannot pay a contract address. The orderbook often
    // WINS on price, so including it and finding out at build time is the trap.
    expect(protocolsFor("contract")).not.toContain("sdex");
  });

  it("allows the orderbook when paying an ordinary account", () => {
    expect(protocolsFor("account")).toContain("sdex");
  });
});
