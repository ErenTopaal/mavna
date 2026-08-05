import type { BridgeAdapter, RouteRejection } from "@mavna/core";

/**
 * Turning a route source off without shipping a release.
 *
 * The security rules require this outright: when a bridge, router or provider is
 * degraded or compromised, there must be a way to stop routing through it that
 * does not require a release. A dependency on a third party is a dependency on
 * their incidents, and the window between "we know" and "we can deploy" is
 * exactly when money is lost.
 *
 * So the list of disabled sources is configuration, read at quote time rather
 * than at start-up. An operator flips it, the next quote respects it, and no
 * in-flight transfer is touched: a source going dark stops new routing through
 * it and never breaks a transfer already moving, because breaking one halfway is
 * worse than the incident it was reacting to.
 */

export interface CircuitBreaker {
  /** Whether this source may be quoted right now. */
  allows(adapterId: string): boolean;
  /** Why it is off, said in a way a user can read. Undefined when it is on. */
  reasonFor(adapterId: string): string | undefined;
}

export interface DisabledSource {
  readonly adapterId: string;
  /**
   * Shown to a user, so it says what it means for them rather than what happened
   * operationally. "Circle is not available right now" is a sentence; "CCTP
   * circuit open due to elevated 5xx" is an incident channel message.
   */
  readonly userFacingReason: string;
}

/**
 * A breaker over a list that can change under it.
 *
 * The list is read through a function rather than captured once, so an operator
 * changing configuration takes effect on the next quote without a restart. A
 * snapshot taken at construction would need a redeploy to clear, which is the
 * thing this exists to avoid.
 */
export function createCircuitBreaker(disabled: () => readonly DisabledSource[]): CircuitBreaker {
  return {
    allows(adapterId) {
      return !disabled().some((entry) => entry.adapterId === adapterId);
    },
    reasonFor(adapterId) {
      return disabled().find((entry) => entry.adapterId === adapterId)?.userFacingReason;
    },
  };
}

/** Never turns anything off. The shape callers get when nobody configured one. */
export const ALWAYS_OPEN: CircuitBreaker = {
  allows: () => true,
  reasonFor: () => undefined,
};

/**
 * Read a disabled list from the environment.
 *
 * The format is `id:reason`, comma separated, because an operator disabling a
 * source under pressure should not have to write JSON correctly on the first
 * try. An entry with no reason still disables the source and says so plainly,
 * since a missing explanation is not a reason to keep routing money through
 * something somebody just switched off.
 */
export function parseDisabledSources(raw: string | undefined): readonly DisabledSource[] {
  if (raw === undefined || raw.trim() === "") return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) {
        return {
          adapterId: entry,
          userFacingReason: "This route is turned off right now.",
        };
      }
      const adapterId = entry.slice(0, separator).trim();
      const reason = entry.slice(separator + 1).trim();
      return {
        adapterId,
        userFacingReason: reason === "" ? "This route is turned off right now." : reason,
      };
    })
    .filter((entry) => entry.adapterId !== "");
}

/**
 * The rejection a disabled source produces.
 *
 * It is a rejection rather than an absence on purpose. A route that silently
 * stops appearing looks like a product that has quietly got worse; one that says
 * it is off looks like a product that knows what it is doing, and the functional
 * requirements ask for the reason either way.
 */
export function rejectionForDisabled(adapter: BridgeAdapter, reason: string): RouteRejection {
  return {
    source: adapter.id,
    reason: "temporarily-unavailable",
    explanation: reason,
    // An operator turned it off and an operator will turn it back on.
    retryable: true,
  };
}
