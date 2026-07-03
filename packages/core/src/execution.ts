import type { Amount } from "./money.js";

/**
 * What a transfer is doing right now.
 *
 * The payload is narrowed by phase, so a step that has no transaction cannot
 * carry a transaction link. Rendering one becomes a compile error rather than a
 * runtime check that somebody forgets. This is the single highest-leverage
 * structural choice in the model and it is free.
 *
 * The most mature product in this category does the opposite: it keeps optional
 * fields on a flat object and discovers at render time whether they are set. Its
 * failure-message map is literally empty and its stalled state is a countdown
 * that reaches zero and vanishes. Both are avoided here on purpose.
 */

/** Why a transfer is waiting for the user rather than for the network. */
export type Blocked =
  | { readonly kind: "needs-signature"; readonly signaturesRemaining: number }
  | { readonly kind: "needs-wallet"; readonly requiredChainId: string }
  | {
      readonly kind: "needs-network-switch";
      readonly currentChainId: string;
      readonly requiredChainId: string;
    }
  | { readonly kind: "quote-expired"; readonly refreshable: true };

/** What a user can do about a failure. Never a message with no action beside it. */
export type Remedy =
  | { readonly kind: "wait"; readonly untilUnix: number; readonly because: string }
  | { readonly kind: "retry"; readonly because: string }
  | { readonly kind: "add-gas"; readonly chainId: string; readonly because: string }
  | { readonly kind: "claim"; readonly at: string; readonly because: string }
  | { readonly kind: "contact"; readonly reference: string; readonly because: string }
  /** Said plainly, so nobody retries forever hoping. */
  | { readonly kind: "unrecoverable"; readonly because: string };

export interface OnChainRef {
  readonly chainId: string;
  readonly txHash: string;
  readonly explorerUrl: string;
}

export type StepPhase =
  /** Nothing has happened yet. */
  | { readonly phase: "idle" }
  /** Waiting on the user. Carries exactly what the prompt needs to render itself. */
  | { readonly phase: "blocked"; readonly blocked: Blocked }
  /** Submitted and progressing normally. */
  | { readonly phase: "pending"; readonly ref: OnChainRef; readonly expectedByUnix: number }
  /**
   * Past its expected duration. Distinct from pending because the design rules
   * require a user to tell "slow but proceeding" from "stalled and needs you"
   * without reading, and a state that does not exist cannot be shown.
   */
  | {
      readonly phase: "stalled";
      readonly ref: OnChainRef;
      readonly overdueSeconds: number;
      readonly remedy: Remedy;
    }
  | { readonly phase: "done"; readonly ref: OnChainRef; readonly received: Amount }
  /**
   * Terminal states of their own, not sub-states of success. The prior art buries
   * these under "done" and has to scan nested actions to find them, which means a
   * refunded transfer reads as a plain success in its own history view.
   */
  | {
      readonly phase: "refunded";
      readonly ref: OnChainRef;
      readonly to: string;
      readonly returned: Amount;
    }
  | {
      readonly phase: "partial";
      readonly ref: OnChainRef;
      readonly received: Amount;
      readonly expected: Amount;
      readonly remedy: Remedy;
    }
  | {
      readonly phase: "failed";
      readonly cause: string;
      readonly remedy: Remedy;
      readonly ref: OnChainRef | undefined;
    };

export const TERMINAL_PHASES = ["done", "refunded", "partial", "failed"] as const;
export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

export function isTerminal(phase: StepPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase.phase);
}

/**
 * Whether a status update may be applied.
 *
 * A late poll must never un-complete a finished transfer. Without this a slow
 * response arriving after success walks the interface backwards, which is both a
 * visible bug and a real one: a user who sees "pending" after "done" will retry.
 */
export function canAdvance(current: StepPhase, next: StepPhase): boolean {
  if (isTerminal(current)) return false;
  if (current.phase === next.phase) return true;
  return true;
}

/** Ranks used only to describe progress; not an ordering the state machine enforces. */
export const PHASE_ORDER: Readonly<Record<StepPhase["phase"], number>> = {
  idle: 0,
  blocked: 1,
  pending: 2,
  stalled: 3,
  done: 4,
  refunded: 4,
  partial: 4,
  failed: 4,
};
