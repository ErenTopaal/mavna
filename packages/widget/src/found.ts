import type { ComposeFinish, Remedy, StepPhase } from "@mavna/core";
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
export type FoundTone = "ok" | "wait" | "bad" | "info";

export interface FoundState {
  readonly tone: FoundTone;
  readonly note: string;
  /** True only when nothing more will happen without the user, so Finish shows. */
  readonly canFinish: boolean;
  /**
   * Present when what Finish does is run an overdue conversion on arrival,
   * rather than Circle's mint: the exact message waiting on Stellar.
   */
  readonly compose?: ComposeFinish;
  /** Somewhere the user can check for themselves, such as the Stellar transaction. */
  readonly link?: { readonly href: string; readonly label: string };
}

/**
 * How long after delivery a conversion on arrival counts as overdue. LayerZero's
 * executor normally runs it within a ledger or two of the delivery.
 */
export const COMPOSE_OVERDUE_SECONDS = 120;

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
  nowUnix: number = Math.floor(Date.now() / 1000),
): FoundState {
  const circle = rails.includes("cctp");
  switch (phase.phase) {
    case "delivered-and-converted":
      return {
        tone: "ok",
        note: `Delivered and converted on arrival. ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived.`,
        canFinish: false,
      };
    case "delivered-as-came":
      return {
        tone: "bad",
        note: `Delivered as it came, not converted. ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived. ${phase.because}`,
        canFinish: false,
      };
    case "delivered-conversion-pending": {
      const overdue = nowUnix - phase.deliveredAtUnix > COMPOSE_OVERDUE_SECONDS;
      if (!overdue) {
        return {
          tone: "wait",
          note: "Delivered on Stellar. The conversion on arrival is running now.",
          canFinish: false,
        };
      }
      if (phase.finish === undefined) {
        return {
          tone: "wait",
          note:
            "Delivered on Stellar, and the conversion on arrival is overdue. Its message could " +
            "not be read back exactly, so it cannot be finished from here; it is still waiting " +
            "and nothing is lost.",
          canFinish: false,
        };
      }
      return {
        tone: "wait",
        note:
          "Delivered on Stellar, and the conversion on arrival is overdue. Finishing it is " +
          "safe to try: it can only ever run once.",
        canFinish: true,
        compose: phase.finish,
      };
    }
    case "delivered-unverified":
      return {
        tone: "info",
        note:
          `The rail records this as delivered on Stellar in transaction ${short(phase.ref.txHash)}, ` +
          `but what arrived could not be read back, so it is not confirmed here. ${phase.because}`,
        canFinish: false,
        link: { href: phase.ref.explorerUrl, label: "See the Stellar transaction" },
      };
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
      // no rail lists the hash, which is how every indexer answers one it has never
      // seen; a transfer this browser sent is kept as on its way before this is reached
      return {
        tone: "wait",
        note:
          "No rail has a record of this transaction. One sent in the last minute may not be " +
          "listed yet, so check again shortly; otherwise check it is the hash from the chain " +
          "you sent from.",
        canFinish: false,
      };
    }
  }
}
