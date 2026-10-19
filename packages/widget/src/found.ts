import type { Remedy, StepPhase } from "@mavna/core";
import type { LookupKey } from "@mavna/status";
import { amountValue, fmt, short } from "./format";
import { railDisplay } from "./quote";

/** A remedy as a sentence a person can act on, with where to act when it has one. */
export function remedyNote(remedy: Remedy): string {
  switch (remedy.kind) {
    case "claim":
      return `${remedy.because} ${remedy.at}`;
    case "contact":
      return `${remedy.because} Reference: ${remedy.reference}.`;
    default:
      return remedy.because;
  }
}

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
 * deliveries, and saying otherwise would be false. A NEAR Intents deposit
 * address is the exception, because that rail is searched by it.
 *
 * `rails` are the adapters the answer speaks for. Finishing a delivery is the
 * sponsor's Circle mint, so it is offered only when Circle is among them; the
 * other rails deliver on their own and their remedies say what is left to do.
 */
export function foundFor(
  phase: StepPhase,
  keyKind: LookupKey["kind"],
  rails: readonly string[],
): FoundState {
  const circle = rails.includes("cctp");
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
        note: `Part of this arrived. ${fmt(amountValue(phase.received))} of ${fmt(amountValue(phase.expected))} ${phase.expected.asset.symbol}. ${circle ? "Finishing the delivery is safe to try." : remedyNote(phase.remedy)}`,
        canFinish: circle,
      };
    case "failed":
      return { tone: "bad", note: phase.cause, canFinish: circle };
    case "stalled":
      return {
        tone: "wait",
        note: `Taking longer than usual. ${circle ? "Finishing the delivery is safe to try." : remedyNote(phase.remedy)}`,
        canFinish: circle,
      };
    case "pending":
      return { tone: "wait", note: "On its way to Stellar.", canFinish: circle };
    case "blocked":
      return { tone: "wait", note: "Waiting on a signature to continue.", canFinish: circle };
    default: {
      // NEAR Intents knows a transfer by its deposit address, so for that rail
      // an idle answer means the address was looked up and nothing is there.
      if (keyKind === "deposit-address" && rails.includes("near-intents")) {
        return {
          tone: "wait",
          note: "Nothing has been found for this deposit address yet.",
          canFinish: false,
        };
      }
      if (keyKind !== "source-tx") {
        const name = rails.length === 1 ? railDisplay(rails[0] ?? "") : undefined;
        const which =
          name === undefined
            ? "a transfer"
            : `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} transfer`;
        return {
          tone: "wait",
          note: `An address alone cannot identify ${which}. Paste the source transaction hash to check one.`,
          canFinish: false,
        };
      }
      return {
        tone: "wait",
        note: "Nothing has been found for this transaction yet.",
        canFinish: circle,
      };
    }
  }
}
