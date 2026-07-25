import { MavnaError } from "@mavna/core";

/**
 * Assembling a whole transfer from its parts.
 *
 * A user asks one question: get my money from there to here, as this asset. What
 * that actually requires depends on facts discovered at quote time, and this is
 * where those facts turn into a sequence of steps.
 */

/** What the destination needs before anything can be delivered to it. */
export type DestinationReadiness =
  | "ready" // an account that already holds the asset, or a contract
  | "needs-trustline" // the account exists but cannot hold this asset yet
  | "needs-account"; // nothing exists

export interface PlanInputs {
  readonly destination: DestinationReadiness;
  /** What the chosen rail actually delivers. Not always what the user asked for. */
  readonly bridgeDelivers: string;
  /** What the user asked to end up holding. */
  readonly userWants: string;
  /**
   * True when the rail delivers Stellar's own currency AND enough of it. Arriving
   * XLM creates the recipient's account by itself, so this whole problem
   * disappears and nothing needs sponsoring.
   */
  readonly arrivingXlmCoversReserve: boolean;
  /**
   * Whether the source chain makes the user approve the rail before it can move
   * their tokens, as a transaction of its own.
   *
   * True on EVM: the messenger pulls the funds with `transferFrom`, so an
   * allowance has to exist first and it cannot ride along in the same
   * transaction. False where a chain lets one signature carry both, which is
   * Starknet (several calls per invoke) and Solana (the burn's authority is the
   * owner, who is already signing).
   *
   * It matters here rather than only in the builder because the user is promised
   * a signature count upfront, and an approval they were not warned about is
   * exactly the surprise that promise exists to prevent.
   */
  readonly sourceNeedsApproval: boolean;
}

export type PlannedStepKind =
  | "approve-source"
  | "prepare-account"
  | "bridge"
  | "settle-account"
  | "swap";

export interface PlannedStep {
  readonly kind: PlannedStepKind;
  readonly label: string;
  /** Whether the user must sign this one. Used to tell them the count upfront. */
  readonly needsUserSignature: boolean;
}

/**
 * Work out the steps.
 *
 * Ordering is not a preference here. Preparation MUST precede the bridge: value
 * arriving at an unprepared account is rejected as a whole unit, losing nothing
 * but landing nothing. Settlement MUST follow arrival, because it pays for itself
 * out of the funds that arrive.
 */
export function planTransfer(inputs: PlanInputs): readonly PlannedStep[] {
  const steps: PlannedStep[] = [];

  const needsSponsoring = inputs.destination !== "ready" && !inputs.arrivingXlmCoversReserve;

  if (needsSponsoring) {
    steps.push({
      kind: "prepare-account",
      label:
        inputs.destination === "needs-account"
          ? "Set up your Stellar account"
          : "Allow your account to hold this asset",
      // The user signs the operation that creates an obligation on their own
      // account, but pays nothing and needs no XLM to do it.
      needsUserSignature: true,
    });
  }

  if (inputs.sourceNeedsApproval) {
    steps.push({
      kind: "approve-source",
      // Named for what the user is doing, not for the ERC-20 call underneath it.
      label: "Allow the transfer to move your USDC",
      needsUserSignature: true,
    });
  }

  steps.push({ kind: "bridge", label: "Move your funds to Stellar", needsUserSignature: true });

  if (needsSponsoring) {
    steps.push({
      kind: "settle-account",
      label: "Finish setting up your account",
      // Signed in advance, before any capital is committed, and submitted for
      // them once their funds arrive. They are not asked again.
      needsUserSignature: false,
    });
  }

  if (inputs.bridgeDelivers !== inputs.userWants) {
    steps.push({
      kind: "swap",
      label: "Convert to what you asked for",
      needsUserSignature: true,
    });
  }

  return steps;
}

/**
 * How many signatures to warn the user about, upfront.
 *
 * The functional requirements are explicit: the number must be the minimum the
 * flow allows, and the user must be told how many to expect rather than being
 * surprised by them one at a time.
 */
export function signatureCount(steps: readonly PlannedStep[]): number {
  return steps.filter((s) => s.needsUserSignature).length;
}

/**
 * Sanity-check a plan before anyone acts on it.
 *
 * These orderings are load-bearing and getting one wrong does not fail loudly, it
 * fails as a transfer that bounces or a sponsorship that can never be recovered.
 */
export function assertPlanIsSound(steps: readonly PlannedStep[]): void {
  const kinds = steps.map((s) => s.kind);
  const bridge = kinds.indexOf("bridge");
  const prepare = kinds.indexOf("prepare-account");
  const settle = kinds.indexOf("settle-account");
  const approve = kinds.indexOf("approve-source");

  if (bridge === -1) {
    throw new MavnaError("A transfer plan with no bridge step moves nothing.", {
      retryable: false,
    });
  }
  if (approve !== -1 && approve > bridge) {
    throw new MavnaError(
      "The approval must come before the bridge, or the burn reverts for want of " +
        "an allowance and the user pays gas to be told so.",
      { retryable: false },
    );
  }
  if (prepare !== -1 && prepare > bridge) {
    throw new MavnaError(
      "Preparation must come before the bridge. Funds arriving at an unprepared " +
        "account are rejected as a whole unit.",
      { retryable: false },
    );
  }
  if (settle !== -1 && settle < bridge) {
    throw new MavnaError(
      "Settlement must come after the bridge; it is paid for out of the arriving funds.",
      { retryable: false },
    );
  }
  if (settle !== -1 && prepare === -1) {
    throw new MavnaError("Nothing was lent, so there is nothing to settle.", { retryable: false });
  }
}
