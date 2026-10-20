import { describe, expect, it } from "vitest";
import { canAdvance, isSuccess, isTerminal, type StepPhase } from "./execution.js";
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

  it("treats a compose arrival delivered as it came as terminal, and not as done", () => {
    const asCame: StepPhase = {
      phase: "delivered-as-came",
      ref,
      received: amountOf(usdc, "1000"),
      because: "the conversion could not meet your minimum",
    };
    expect(isTerminal(asCame)).toBe(true);
    expect(isSuccess(asCame)).toBe(false);
    expect(canAdvance(asCame, done)).toBe(false);
    expect(canAdvance(pending, asCame)).toBe(true);
  });

  it("treats a delivery too old to re-verify as an ending, and never as done", () => {
    const unverified: StepPhase = {
      phase: "delivered-unverified",
      ref,
      because: "The token is its own contract, and its movements are no longer kept.",
    };
    expect(isTerminal(unverified)).toBe(true);
    expect(isSuccess(unverified)).toBe(false);
    expect(canAdvance(unverified, done)).toBe(false);
  });

  it("keeps a conversion still to run apart from both endings", () => {
    const converting: StepPhase = {
      phase: "delivered-conversion-pending",
      ref,
      deliveredAtUnix: 100,
      finish: undefined,
    };
    const converted: StepPhase = {
      phase: "delivered-and-converted",
      ref,
      received: amountOf(usdc, "990"),
      fee: amountOf(usdc, "10"),
    };
    expect(isTerminal(converting)).toBe(false);
    expect(isSuccess(converting)).toBe(false);
    expect(canAdvance(converting, converted)).toBe(true);
    expect(isTerminal(converted)).toBe(true);
    expect(isSuccess(converted)).toBe(true);
    expect(isSuccess(done)).toBe(true);
    // a late poll that still sees the step queued must not undo the conversion
    expect(canAdvance(converted, converting)).toBe(false);
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

  it("refuses a late poll that walks a step that is not finished back to an earlier phase", () => {
    const converting: StepPhase = {
      phase: "delivered-conversion-pending",
      ref,
      deliveredAtUnix: 100,
      finish: undefined,
    };
    const stalled: StepPhase = {
      phase: "stalled",
      ref,
      overdueSeconds: 30,
      remedy: { kind: "wait", untilUnix: 200, because: "the network is slow" },
    };
    expect(canAdvance(converting, pending)).toBe(false);
    expect(canAdvance(converting, { phase: "idle" })).toBe(false);
    expect(canAdvance(pending, { phase: "idle" })).toBe(false);
    // the same transaction still reported pending is not news: it is still overdue
    expect(canAdvance(stalled, pending)).toBe(false);
    // a new transaction (the user acted on the remedy) does set the step moving again
    expect(canAdvance(stalled, { ...pending, ref: { ...ref, txHash: "def" } })).toBe(true);
    expect(canAdvance(stalled, converting)).toBe(true);
    expect(canAdvance(pending, pending)).toBe(true);
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
