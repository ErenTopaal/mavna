import type { RouteRejection, TrustModel } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { describeRejection, explainTrust } from "./RouteList.js";

const ALL_MODELS: readonly TrustModel[] = [
  "native-mint",
  "validator-set",
  "solver-network",
  "liquidity-pool",
];

describe("explainTrust", () => {
  it("has an explanation for every trust model", () => {
    for (const model of ALL_MODELS) {
      expect(explainTrust(model).length).toBeGreaterThan(0);
    }
  });

  /**
   * The requirement is that a trust model be legible WITHOUT expanding anything,
   * which rules out the badge-plus-tooltip pattern this category ships. A badge
   * reading "Validator Set" transfers nothing to the person deciding, who is by
   * definition the person who does not already know the term.
   */
  it("never answers with the jargon term itself", () => {
    for (const model of ALL_MODELS) {
      const words = model.split("-");
      for (const word of words) {
        expect(explainTrust(model).toLowerCase()).not.toContain(`${word} model`);
      }
    }
    expect(explainTrust("native-mint")).not.toContain("native-mint");
    expect(explainTrust("solver-network")).not.toContain("solver");
  });

  it("says who could hold the money, since that is the actual question", () => {
    expect(explainTrust("native-mint")).toContain("Nobody holds your money");
    expect(explainTrust("validator-set")).toContain("agree");
    expect(explainTrust("solver-network")).toContain("fronts you the money");
    expect(explainTrust("liquidity-pool")).toContain("pool");
  });

  it("is a sentence rather than a label", () => {
    for (const model of ALL_MODELS) {
      expect(explainTrust(model).endsWith(".")).toBe(true);
      expect(explainTrust(model).split(" ").length).toBeGreaterThan(4);
    }
  });
});

describe("describeRejection", () => {
  it("names the source, so a user knows which rail declined", () => {
    const rejection: RouteRejection = {
      source: "allbridge",
      reason: "amount-too-small",
      explanation: "Send at least 50 USDC to use this route.",
    };
    expect(describeRejection(rejection)).toBe(
      "allbridge: Send at least 50 USDC to use this route.",
    );
  });
});
