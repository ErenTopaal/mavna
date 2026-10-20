import { canAdvance, isSuccess, isTerminal, type Remedy, type StepPhase } from "@mavna/core";

/**
 * The state machine behind a transfer in flight.
 *
 * The design rules identify the wait as the largest quality gap available, and
 * the prior-art review confirmed it: the market leader leaves stalled transfers
 * essentially unhandled and ships an empty failure-message map. Everything here
 * exists because of a specific thing they get wrong.
 */

export interface TrackedStep {
  readonly id: string;
  readonly label: string;
  readonly phase: StepPhase;
  /** From the quote. What "on time" means for this step. */
  readonly expectedSeconds: number;
  readonly startedAtUnix: number | undefined;
}

export interface TransferState {
  readonly id: string;
  readonly steps: readonly TrackedStep[];
  readonly updatedAtUnix: number;
}

/**
 * Apply an update, refusing any that would move a transfer backwards.
 *
 * A late poll must never un-complete a finished transfer. Without this, a slow
 * response arriving after success walks the interface backwards, and a user who
 * sees "in progress" after "done" will try again. Retrying is how one payment
 * becomes two.
 */
export function applyUpdate(
  state: TransferState,
  stepId: string,
  next: StepPhase,
  nowUnix: number,
): TransferState {
  const steps = state.steps.map((step) => {
    if (step.id !== stepId) return step;
    if (!canAdvance(step.phase, next)) return step;
    return {
      ...step,
      phase: next,
      startedAtUnix: step.startedAtUnix ?? (next.phase === "pending" ? nowUnix : undefined),
    };
  });
  return { ...state, steps, updatedAtUnix: nowUnix };
}

/**
 * Promote a step that is overdue from "pending" to "stalled".
 *
 * This is the difference between a product that respects the wait and one that
 * does not. The market leader computes an expected finish time, renders a
 * countdown, and when it reaches zero the countdown simply DISAPPEARS: no
 * escalation, no overdue state, no change in what the user is told. A user
 * therefore cannot distinguish "slow but proceeding" from "stalled and needs
 * you", which the design rules require them to do without reading.
 */
export function escalateIfOverdue(
  step: TrackedStep,
  nowUnix: number,
  remedyFor: (step: TrackedStep, overdueSeconds: number) => Remedy,
): TrackedStep {
  if (step.phase.phase !== "pending") return step;
  if (step.startedAtUnix === undefined) return step;

  const dueAt = step.startedAtUnix + step.expectedSeconds;
  if (nowUnix <= dueAt) return step;

  const overdueSeconds = nowUnix - dueAt;
  return {
    ...step,
    phase: {
      phase: "stalled",
      ref: step.phase.ref,
      overdueSeconds,
      remedy: remedyFor(step, overdueSeconds),
    },
  };
}

/** How far along a transfer is, for something to render. */
export interface Progress {
  readonly done: number;
  readonly total: number;
  /** The step a user should be looking at right now. */
  readonly current: TrackedStep | undefined;
  /** True when nothing more will happen without the user. */
  readonly needsUser: boolean;
  readonly finished: boolean;
}

export function progressOf(state: TransferState): Progress {
  const done = state.steps.filter((s) => isSuccess(s.phase)).length;
  const current = state.steps.find((s) => !isTerminal(s.phase));
  const needsUser =
    current?.phase.phase === "blocked" ||
    current?.phase.phase === "stalled" ||
    state.steps.some((s) => s.phase.phase === "failed");

  return {
    done,
    total: state.steps.length,
    current,
    needsUser,
    // every() holds for no steps at all, and a transfer with none has not finished
    finished: state.steps.length > 0 && state.steps.every((s) => isTerminal(s.phase)),
  };
}

/**
 * Whether the transfer ended in a way the user should be told about specifically.
 *
 * Refunds and partial deliveries are terminal outcomes in their own right here,
 * not footnotes under success. The prior art stores them as sub-states of "done"
 * and has to scan nested actions to find them, which is why a refunded transfer
 * shows as a plain success in their own history view.
 */
export function outcomeOf(
  state: TransferState,
): "succeeded" | "refunded" | "partial" | "failed" | "delivered-as-came" | "in-flight" {
  if (state.steps.some((s) => s.phase.phase === "failed")) return "failed";
  if (state.steps.some((s) => s.phase.phase === "refunded")) return "refunded";
  if (state.steps.some((s) => s.phase.phase === "partial")) return "partial";
  // the money arrived, but not as the asset asked for, so it is not a success
  if (state.steps.some((s) => s.phase.phase === "delivered-as-came")) return "delivered-as-came";
  if (state.steps.length > 0 && state.steps.every((s) => isSuccess(s.phase))) return "succeeded";
  return "in-flight";
}
