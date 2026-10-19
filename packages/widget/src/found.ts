import type { StepPhase } from "@mavna/core";
import type { LookupKey } from "@mavna/status";
import { amountValue, fmt, short } from "./format";

/** How a looked-up transfer ended, in the design's found-panel language. */
export type FoundTone = "ok" | "wait" | "bad";

export interface FoundState {
  readonly tone: FoundTone;
  readonly note: string;
  /** True only when nothing more will happen without the user, so Finish shows. */
  readonly canFinish: boolean;
}

/**
 * Fold a real status phase into the found panel's three tones.
 *
 * The design's panel only knew delivered vs not. The status machine also
 * reports refunded and partial deliveries, which the backend produces and the
 * user needs to see: those use the same red signal the rest of the interface
 * reserves for something gone wrong, and partial names how much arrived.
 *
 * The key matters for idle. Looked up by address, idle means the address could
 * not name a transfer, not that nothing arrived: an address may well have had
 * deliveries, and saying otherwise would be false.
 */
export function foundFor(phase: StepPhase, keyKind: LookupKey["kind"]): FoundState {
  switch (phase.phase) {
    case "done":
      return {
        tone: "ok",
        note: `Delivered on Stellar. ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived.`,
        canFinish: false,
      };
    case "refunded":
      return {
        tone: "bad",
        note: `Returned to ${short(phase.to)}. ${fmt(amountValue(phase.returned))} ${phase.returned.asset.symbol} came back.`,
        canFinish: false,
      };
    case "partial":
      return {
        tone: "bad",
        note: `Part of this arrived. ${fmt(amountValue(phase.received))} of ${fmt(amountValue(phase.expected))} ${phase.expected.asset.symbol}. Finishing the delivery is safe to try.`,
        canFinish: true,
      };
    case "failed":
      return { tone: "bad", note: phase.cause, canFinish: true };
    case "stalled":
      return {
        tone: "wait",
        note: "Taking longer than usual. Finishing the delivery is safe to try.",
        canFinish: true,
      };
    case "pending":
      return { tone: "wait", note: "On its way to Stellar.", canFinish: true };
    case "blocked":
      return { tone: "wait", note: "Waiting on a signature to continue.", canFinish: true };
    default:
      if (keyKind !== "source-tx") {
        return {
          tone: "wait",
          note: "An address alone cannot identify a Circle transfer. Paste the source transaction hash to check one.",
          canFinish: false,
        };
      }
      return { tone: "wait", note: "Nothing has reached this address yet.", canFinish: true };
  }
}
