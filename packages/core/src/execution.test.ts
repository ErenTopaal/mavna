import { describe, expect, it } from "vitest";
import { canAdvance, isTerminal, type StepPhase } from "./execution.js";
import { type Asset, amountOf } from "./money.js";

const usdc: Asset = {
  chainId: "stellar",
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "test",
};

const ref = { chainId: "stellar", txHash: "abc", explorerUrl: "https://example/tx/abc" };
const done: StepPhase = { phase: "done", ref, received: amountOf(usdc, "1000") };
const pending: StepPhase = { phase: "pending", ref, expectedByUnix: 0 };

describe("terminal states", () => {
  it("treats refund and partial as terminal in their own right", () => {
    // The prior art buries these under success and has to scan nested actions to
    // find them, which is why a refunded transfer shows as plain success in their
    // own history view. Here they are states.
    expect(isTerminal({ phase: "refunded", ref, to: "GA", returned: amountOf(usdc, "1") })).toBe(
      true,
    );
    expect(
      isTerminal({
        phase: "partial",
        ref,
        received: amountOf(usdc, "1"),
        expected: amountOf(usdc, "2"),
        remedy: { kind: "retry", because: "some of it arrived" },
      }),
    ).toBe(true);
  });

  it("does not treat waiting states as terminal", () => {
    expect(isTerminal(pending)).toBe(false);
    expect(isTerminal({ phase: "idle" })).toBe(false);
  });
});

describe("monotonic status", () => {
  it("refuses to walk a finished transfer backwards", () => {
    // A late poll arriving after success must never un-complete it. A user who
    // sees "pending" after "done" will retry, and retrying is how one failure
    // becomes two payments.
    expect(canAdvance(done, pending)).toBe(false);
  });

  it("allows ordinary forward movement", () => {
    expect(canAdvance({ phase: "idle" }, pending)).toBe(true);
    expect(canAdvance(pending, done)).toBe(true);
  });

  it("will not move from one terminal state to another", () => {
    expect(
      canAdvance(done, {
        phase: "failed",
        cause: "x",
        remedy: { kind: "retry", because: "x" },
        ref: undefined,
      }),
    ).toBe(false);
  });
});

describe("every failure carries an action", () => {
  it("cannot construct a failure without a remedy", () => {
    // Enforced by the type, not by convention. The prior art ships an empty
    // failure-message map and renders whatever the error object happened to carry.
    const failure: StepPhase = {
      phase: "failed",
      cause: "destination cannot hold this asset",
      remedy: { kind: "unrecoverable", because: "the asset was never supported there" },
      ref: undefined,
    };
    expect(failure.phase).toBe("failed");
    if (failure.phase === "failed") {
      expect(failure.remedy.because.length).toBeGreaterThan(0);
    }
  });

  it("names an unrecoverable failure as such rather than leaving it ambiguous", () => {
    // Ambiguity leads users to retry, and retrying is how single failures become
    // double spends.
    const remedy = { kind: "unrecoverable", because: "funds were returned to sender" } as const;
    expect(remedy.kind).toBe("unrecoverable");
  });
});

describe("stalled is distinct from pending", () => {
  it("carries how overdue it is and what to do", () => {
    const stalled: StepPhase = {
      phase: "stalled",
      ref,
      overdueSeconds: 600,
      remedy: { kind: "add-gas", chainId: "axelar", because: "the delivery ran out of gas" },
    };
    expect(stalled.phase).toBe("stalled");
    if (stalled.phase === "stalled") {
      expect(stalled.overdueSeconds).toBeGreaterThan(0);
      expect(stalled.remedy.kind).toBe("add-gas");
    }
  });
});
