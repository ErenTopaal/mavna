import { describe, expect, it } from "vitest";
import { assertPlanIsSound, planTransfer, signatureCount } from "./plan.js";

const usdcToUsdc = { bridgeDelivers: "USDC", userWants: "USDC", arrivingXlmCoversReserve: false };

describe("what a transfer actually requires", () => {
  it("needs nothing extra for a destination that is already ready", () => {
    const steps = planTransfer({ destination: "ready", ...usdcToUsdc });
    expect(steps.map((s) => s.kind)).toEqual(["bridge"]);
    expect(signatureCount(steps)).toBe(1);
  });

  it("prepares and settles for an account that does not exist", () => {
    const steps = planTransfer({ destination: "needs-account", ...usdcToUsdc });
    expect(steps.map((s) => s.kind)).toEqual(["prepare-account", "bridge", "settle-account"]);
  });

  it("does not ask the user to sign the settlement, because they already did", () => {
    // Collected before any capital was committed and submitted for them on
    // arrival. Asking again would be asking twice for the same consent.
    const steps = planTransfer({ destination: "needs-account", ...usdcToUsdc });
    expect(steps.find((s) => s.kind === "settle-account")?.needsUserSignature).toBe(false);
    expect(signatureCount(steps)).toBe(2);
  });

  it("adds a conversion only when the user wants something else", () => {
    const same = planTransfer({ destination: "ready", ...usdcToUsdc });
    const different = planTransfer({
      destination: "ready",
      bridgeDelivers: "USDC",
      userWants: "XLM",
      arrivingXlmCoversReserve: false,
    });
    expect(same.some((s) => s.kind === "swap")).toBe(false);
    expect(different.some((s) => s.kind === "swap")).toBe(true);
  });

  it("skips sponsorship entirely when the arriving XLM pays for the account itself", () => {
    // Verified on chain: a contract-level XLM transfer CREATES a missing account,
    // so a rail delivering enough XLM needs no help from us at all.
    const steps = planTransfer({
      destination: "needs-account",
      bridgeDelivers: "XLM",
      userWants: "XLM",
      arrivingXlmCoversReserve: true,
    });
    expect(steps.map((s) => s.kind)).toEqual(["bridge"]);
  });
});

describe("orderings that are load-bearing", () => {
  it("accepts a correctly ordered plan", () => {
    expect(() =>
      assertPlanIsSound(planTransfer({ destination: "needs-account", ...usdcToUsdc })),
    ).not.toThrow();
  });

  it("refuses a plan that bridges before preparing", () => {
    // This does not fail loudly at runtime; it fails as a transfer that bounces.
    expect(() =>
      assertPlanIsSound([
        { kind: "bridge", label: "", needsUserSignature: true },
        { kind: "prepare-account", label: "", needsUserSignature: true },
      ]),
    ).toThrow(/must come before the bridge/);
  });

  it("refuses a plan that settles before the funds arrive", () => {
    expect(() =>
      assertPlanIsSound([
        { kind: "prepare-account", label: "", needsUserSignature: true },
        { kind: "settle-account", label: "", needsUserSignature: false },
        { kind: "bridge", label: "", needsUserSignature: true },
      ]),
    ).toThrow(/after the bridge/);
  });

  it("refuses a plan that settles something it never lent", () => {
    expect(() =>
      assertPlanIsSound([
        { kind: "bridge", label: "", needsUserSignature: true },
        { kind: "settle-account", label: "", needsUserSignature: false },
      ]),
    ).toThrow(/nothing to settle/);
  });

  it("refuses a plan that moves nothing", () => {
    expect(() => assertPlanIsSound([])).toThrow(/moves nothing/);
  });
});
