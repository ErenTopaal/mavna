import type { OnChainRef, StepPhase } from "@mavna/core";
import { describe, expect, it } from "vitest";
import {
  applyUpdate,
  escalateIfOverdue,
  outcomeOf,
  progressOf,
  type TrackedStep,
  type TransferState,
} from "./machine.js";

const ref: OnChainRef = { chainId: "stellar", txHash: "h", explorerUrl: "https://x/tx/h" };
const amount = {
  asset: { chainId: "stellar", id: "native", symbol: "XLM", decimals: 7, curatedBy: undefined },
  baseUnits: "1",
};

const step = (id: string, phase: StepPhase, startedAtUnix?: number): TrackedStep => ({
  id,
  label: id,
  phase,
  expectedSeconds: 600,
  startedAtUnix,
});
const state = (...steps: TrackedStep[]): TransferState => ({ id: "t", steps, updatedAtUnix: 0 });

describe("a finished transfer cannot be walked backwards", () => {
  it("ignores a late poll arriving after success", () => {
    const done = state(step("bridge", { phase: "done", ref, received: amount }));
    const after = applyUpdate(done, "bridge", { phase: "pending", ref, expectedByUnix: 0 }, 100);
    // A user who sees "in progress" after "done" will retry, and retrying is how
    // one payment becomes two.
    expect(after.steps[0]?.phase.phase).toBe("done");
  });

  it("ignores a late failure arriving after success", () => {
    const done = state(step("bridge", { phase: "done", ref, received: amount }));
    const after = applyUpdate(
      done,
      "bridge",
      {
        phase: "failed",
        cause: "x",
        remedy: { kind: "retry", because: "x" },
        ref: undefined,
      },
      100,
    );
    expect(after.steps[0]?.phase.phase).toBe("done");
  });

  it("still allows ordinary forward movement", () => {
    const idle = state(step("bridge", { phase: "idle" }));
    const after = applyUpdate(idle, "bridge", { phase: "pending", ref, expectedByUnix: 0 }, 50);
    expect(after.steps[0]?.phase.phase).toBe("pending");
    expect(after.steps[0]?.startedAtUnix).toBe(50);
  });
});

describe("slow is distinguishable from stalled", () => {
  const remedy = () =>
    ({ kind: "add-gas", chainId: "c", because: "the delivery ran out of gas" }) as const;

  it("leaves a step alone while it is merely slow", () => {
    const s = step("bridge", { phase: "pending", ref, expectedByUnix: 0 }, 1000);
    // 500s into a 600s expectation: slow, not stalled.
    expect(escalateIfOverdue(s, 1500, remedy).phase.phase).toBe("pending");
  });

  it("escalates once it is genuinely overdue, with a specific remedy", () => {
    const s = step("bridge", { phase: "pending", ref, expectedByUnix: 0 }, 1000);
    const escalated = escalateIfOverdue(s, 1700, remedy);

    // The market leader's countdown reaches zero and simply vanishes, leaving a
    // user unable to tell "proceeding" from "needs you". This is that gap closed.
    expect(escalated.phase.phase).toBe("stalled");
    if (escalated.phase.phase === "stalled") {
      expect(escalated.phase.overdueSeconds).toBe(100);
      expect(escalated.phase.remedy.kind).toBe("add-gas");
      expect(escalated.phase.remedy.because.length).toBeGreaterThan(0);
    }
  });

  it("never escalates a step that has not started", () => {
    expect(escalateIfOverdue(step("b", { phase: "idle" }), 99999, remedy).phase.phase).toBe("idle");
  });
});

describe("outcomes are named, not inferred", () => {
  it("reports a refund as a refund rather than a success", () => {
    // The prior art buries refunds under "done" and scans nested actions to find
    // them, so a refunded transfer reads as plain success in their history view.
    const s = state(step("b", { phase: "refunded", ref, to: "GA", returned: amount }));
    expect(outcomeOf(s)).toBe("refunded");
  });

  it("reports a partial delivery as partial", () => {
    const s = state(
      step("b", {
        phase: "partial",
        ref,
        received: amount,
        expected: amount,
        remedy: { kind: "retry", because: "some arrived" },
      }),
    );
    expect(outcomeOf(s)).toBe("partial");
  });

  it("reports success only when every step is done", () => {
    expect(
      outcomeOf(
        state(
          step("a", { phase: "done", ref, received: amount }),
          step("b", { phase: "done", ref, received: amount }),
        ),
      ),
    ).toBe("succeeded");
    expect(
      outcomeOf(
        state(
          step("a", { phase: "done", ref, received: amount }),
          step("b", { phase: "pending", ref, expectedByUnix: 0 }),
        ),
      ),
    ).toBe("in-flight");
  });
});

describe("progress tells the interface where to look", () => {
  it("flags when nothing will happen without the user", () => {
    const s = state(
      step("b", { phase: "blocked", blocked: { kind: "needs-signature", signaturesRemaining: 1 } }),
    );
    expect(progressOf(s).needsUser).toBe(true);
  });

  it("does not flag a transfer that is simply working", () => {
    const s = state(step("b", { phase: "pending", ref, expectedByUnix: 0 }));
    expect(progressOf(s).needsUser).toBe(false);
  });

  it("counts what is finished", () => {
    const p = progressOf(
      state(
        step("a", { phase: "done", ref, received: amount }),
        step("b", { phase: "pending", ref, expectedByUnix: 0 }),
      ),
    );
    expect(p.done).toBe(1);
    expect(p.total).toBe(2);
    expect(p.current?.id).toBe("b");
    expect(p.finished).toBe(false);
  });
});
