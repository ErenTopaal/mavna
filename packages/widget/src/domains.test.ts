import { describe, expect, it } from "vitest";
import { circleDomain } from "./domains";

describe("circleDomain", () => {
  it("names Circle's domain for a chain it knows", () => {
    expect(circleDomain("testnet", "arbitrum-sepolia")).toBe(3);
  });

  it("refuses a chain it does not know, rather than guessing Ethereum's", () => {
    expect(() => circleDomain("testnet", "nowhere")).toThrow(/nowhere/);
  });
});
