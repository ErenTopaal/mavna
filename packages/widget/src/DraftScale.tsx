import type { Remedy, StepPhase } from "@mavna/core";
import type { ReactElement } from "react";
import { formatAmount, shortenAddress } from "./format.js";

/**
 * The draft scale.
 *
 * A vessel's draft marks tell you how deep it sits, and therefore how much it is
 * carrying, from the quay and without asking anyone. That is the job here: how
 * far a transfer has got, and whether it is waiting on the network or on you,
 * legible before a single word is read.
 *
 * The design rules name the wait as the largest quality gap in this category,
 * and the prior-art review bore it out: the market leader renders a countdown
 * that reaches zero and disappears, leaving "slow but proceeding" and "stalled
 * and needs you" looking identical. Those are different rows here, in different
 * colours, with different motion, and only one of them carries an action.
 */

export interface ScaleStep {
  readonly id: string;
  readonly label: string;
  readonly phase: StepPhase;
}

export interface DraftScaleProps {
  readonly steps: readonly ScaleStep[];
  /** How the whole transfer ended, which decides whether the keel is drawn. */
  readonly outcome: "succeeded" | "refunded" | "partial" | "failed" | "in-flight";
  readonly onRemedy: ((stepId: string, remedy: Remedy) => void) | undefined;
}

export function DraftScale({ steps, outcome, onRemedy }: DraftScaleProps): ReactElement {
  const current = steps.find((step) => !isSettled(step.phase));

  return (
    <ol className="mv-scale" data-mv-outcome={outcome}>
      {steps.map((step) => {
        const remedy = remedyFor(step.phase);
        const note = noteFor(step);
        const ref = refOf(step.phase);

        return (
          <li
            key={step.id}
            className="mv-step"
            data-mv-phase={step.phase.phase}
            data-mv-needs-user={needsUser(step.phase) ? "true" : undefined}
            aria-current={step.id === current?.id ? "step" : undefined}
          >
            <div className="mv-gauge">
              <span className="mv-tick" aria-hidden="true" />
              {hasWaterline(step.phase) ? <span className="mv-water" aria-hidden="true" /> : null}
            </div>
            <div className="mv-body">
              <p className="mv-label">
                {step.label}
                <span className="mv-sr">{` (${phaseWord(step.phase)})`}</span>
              </p>
              {note === undefined ? null : <p className="mv-note">{note}</p>}
              {ref === undefined ? null : (
                <a className="mv-ref" href={ref.url} target="_blank" rel="noreferrer noopener">
                  {`View on ${ref.chainId}`}
                </a>
              )}
              {remedy === undefined || onRemedy === undefined ? null : (
                <button
                  type="button"
                  className="mv-action"
                  onClick={() => {
                    onRemedy(step.id, remedy);
                  }}
                >
                  {actionLabel(remedy)}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Whether nothing more will happen on this step without the user. */
export function needsUser(phase: StepPhase): boolean {
  return (
    phase.phase === "blocked" ||
    phase.phase === "stalled" ||
    phase.phase === "failed" ||
    phase.phase === "partial"
  );
}

function isSettled(phase: StepPhase): boolean {
  return phase.phase === "done" || phase.phase === "refunded";
}

/** The waterline is drawn where the transfer currently sits, and nowhere else. */
function hasWaterline(phase: StepPhase): boolean {
  return phase.phase !== "idle" && phase.phase !== "done" && phase.phase !== "refunded";
}

function phaseWord(phase: StepPhase): string {
  switch (phase.phase) {
    case "idle":
      return "not started";
    case "blocked":
      return "waiting for you";
    case "pending":
      return "in progress";
    case "stalled":
      return "overdue";
    case "done":
      return "done";
    case "refunded":
      return "returned";
    case "partial":
      return "partly delivered";
    case "failed":
      return "failed";
  }
}

/**
 * What to say about a step.
 *
 * Every line names what happened and, where there is one, what to do. None of
 * them apologise and none of them are vague: a message a user cannot act on is
 * the thing this product exists to not ship.
 */
export function noteFor(step: ScaleStep): string | undefined {
  const phase = step.phase;
  switch (phase.phase) {
    case "idle":
      return undefined;
    case "blocked":
      return blockedNote(phase.blocked);
    case "pending":
      return "In progress.";
    case "stalled":
      return `Still waiting after ${humanDuration(phase.overdueSeconds)} longer than expected. ${phase.remedy.because}`;
    case "done":
      // Preparing an account and settling it are real steps that receive
      // nothing, and "0 XLM arrived" is worse than saying nothing at all. The
      // filled hull already reports that the step is behind us.
      return BigInt(phase.received.baseUnits) === 0n
        ? undefined
        : `${formatAmount(phase.received)} ${phase.received.asset.symbol} arrived.`;
    case "refunded":
      return `Returned to ${shortenAddress(phase.to)}. ${formatAmount(phase.returned)} ${phase.returned.asset.symbol} came back.`;
    case "partial":
      return `Part of this arrived. The rest did not. ${formatAmount(phase.received)} of ${formatAmount(phase.expected)} ${phase.expected.asset.symbol}.`;
    case "failed":
      return `${phase.cause} ${phase.remedy.because}`;
  }
}

export function blockedNote(blocked: Extract<StepPhase, { phase: "blocked" }>["blocked"]): string {
  switch (blocked.kind) {
    case "needs-signature":
      return blocked.signaturesRemaining > 1
        ? `Approve this in your wallet. ${blocked.signaturesRemaining} approvals left.`
        : "Approve this in your wallet.";
    case "needs-wallet":
      return `Connect a wallet on ${blocked.requiredChainId}.`;
    case "needs-network-switch":
      return `Switch your wallet from ${blocked.currentChainId} to ${blocked.requiredChainId}.`;
    case "quote-expired":
      return "This quote expired before it was signed. Get a fresh one to continue.";
  }
}

export function remedyFor(phase: StepPhase): Remedy | undefined {
  if (phase.phase === "stalled" || phase.phase === "failed" || phase.phase === "partial") {
    return phase.remedy;
  }
  return undefined;
}

/**
 * The label on the one button attached to a problem.
 *
 * "Add gas" is the phrasing every bridge uses and it is wrong for this audience:
 * it names an internal mechanism, not the thing the user gets. They are paying
 * so the transfer finishes, so that is what the button says.
 */
export function actionLabel(remedy: Remedy): string {
  switch (remedy.kind) {
    case "wait":
      return "Check again";
    case "retry":
      return "Try again";
    case "add-gas":
      return "Pay to finish delivery";
    case "claim":
      return "Claim";
    case "contact":
      return "Get help";
    case "unrecoverable":
      return "See what happened";
  }
}

function refOf(phase: StepPhase): { url: string; chainId: string } | undefined {
  if (phase.phase === "idle" || phase.phase === "blocked") return undefined;
  // Only `failed` can lack a reference: a transaction that was never accepted has
  // no hash to look at, and inventing a link to nothing is worse than no link.
  const ref = phase.ref;
  if (ref === undefined) return undefined;
  return { url: ref.explorerUrl, chainId: ref.chainId };
}

/** Rounded to the unit a person would use out loud, never "3720 seconds". */
export function humanDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 90) return `${whole} seconds`;
  const minutes = Math.round(whole / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}
