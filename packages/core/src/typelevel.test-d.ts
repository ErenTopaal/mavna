/**
 * Type-level proofs. These assert that invalid states do not COMPILE, which is a
 * stronger guarantee than a runtime test can give.
 *
 * Compiled by `tsc --noEmit` as part of typecheck; the @ts-expect-error lines fail
 * the build if the error they expect ever stops happening.
 */
import type { StepPhase } from "./execution.js";

// A step with no transaction cannot carry a transaction reference.
// @ts-expect-error idle has no ref, so reading one must not compile
const _noRefOnIdle: string = ({ phase: "idle" } as StepPhase & { phase: "idle" }).ref.txHash;

// A failure must carry a remedy. Omitting it must not compile.
// @ts-expect-error remedy is required on a failure
const _failureWithoutRemedy: StepPhase = { phase: "failed", cause: "x", ref: undefined };

// A stalled step must say how overdue it is and what to do about it.
// @ts-expect-error overdueSeconds and remedy are both required
const _stalledWithoutRemedy: StepPhase = {
  phase: "stalled",
  ref: { chainId: "c", txHash: "h", explorerUrl: "u" },
};

// A phase that does not exist must be rejected rather than tolerated.
// @ts-expect-error "cancelled" is not a phase this product has
const _unknownPhase: StepPhase = { phase: "cancelled" };

export type Proofs = [
  typeof _noRefOnIdle,
  typeof _failureWithoutRemedy,
  typeof _stalledWithoutRemedy,
  typeof _unknownPhase,
];
