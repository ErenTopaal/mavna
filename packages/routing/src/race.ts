import {
  ADAPTER_QUOTE_TIMEOUT_MS,
  type BridgeAdapter,
  isRejection,
  type QuoteRequest,
  type Route,
  type RouteRanking,
  type RouteRejection,
  type RouteSet,
  rankRoutes,
} from "@mavna/core";
import { ALWAYS_OPEN, type CircuitBreaker, rejectionForDisabled } from "./circuit.js";
import {
  applyIntegratorFee,
  attachSwapLeg,
  type IntegratorFee,
  type SwapAttachment,
} from "./enrich.js";

/**
 * Asking every rail at once.
 *
 * Partial results are the NORMAL case here, not a degraded one. Sources are raced
 * and some answer before others, so a caller must be able to render what has
 * arrived without waiting for the slowest. The design rules are explicit that
 * this must look intentional rather than broken.
 *
 * A slow or failing source must never block the others. One rail timing out costs
 * that rail's route, nothing more.
 */

export interface RaceOptions {
  /** How long any single adapter gets before the race moves on without it. */
  readonly timeoutMs?: number;
  /**
   * Lets an operator take a source out of rotation without a release.
   *
   * Required by the security rules: a dependency on a third party is a
   * dependency on their incidents, and the window between knowing and being able
   * to deploy is exactly when money is lost. Defaults to letting everything
   * through, so nothing changes for a caller who has no incident to respond to.
   */
  readonly breaker?: CircuitBreaker;
  /**
   * Called each time a source answers, so an interface can show routes as they
   * land rather than all at once at the end. This is what makes the wait feel
   * like progress instead of a spinner.
   */
  readonly onUpdate?: (partial: RouteSet) => void;
  /**
   * Convert what the rails deliver into what the user asked for.
   *
   * When set, every adapter is asked for the delivered asset and the conversion
   * is attached to each route as it lands, priced by the exchange layer. Without
   * it, a request for anything the rails do not deliver natively has no route.
   */
  readonly swap?: SwapAttachment | undefined;
  /**
   * The integrator's cut, applied to every route and itemised on it.
   *
   * Runs even at zero basis points, so turning a fee on is a configuration
   * change rather than a code path nobody has ever exercised.
   */
  readonly integratorFee?: IntegratorFee | undefined;
  /** How routes are ordered. The default is the best net outcome. */
  readonly ranking?: RouteRanking | undefined;
}

export async function raceAdapters(
  adapters: readonly BridgeAdapter[],
  request: QuoteRequest,
  options: RaceOptions = {},
): Promise<RouteSet> {
  const timeoutMs = options.timeoutMs ?? ADAPTER_QUOTE_TIMEOUT_MS;
  const breaker = options.breaker ?? ALWAYS_OPEN;
  const routes: Route[] = [];
  const rejected: RouteRejection[] = [];
  let settled = 0;

  // The rails are asked for what they can actually deliver. The conversion into
  // what the user wants is attached afterwards, per route, so a rail never has
  // to know the exchange layer exists.
  const railRequest: QuoteRequest =
    options.swap === undefined ? request : { ...request, to: options.swap.delivered };

  const publish = (): void => {
    options.onUpdate?.({
      // Ranked every time, not only at the end: the first route on screen is the
      // default selection, and the default must be the best net outcome even
      // while slower rails are still answering.
      routes: rankRoutes(routes, options.ranking ?? "best-received"),
      rejected: [...rejected],
      complete: settled === adapters.length,
    });
  };

  const enrich = async (route: Route): Promise<Route | RouteRejection> => {
    let out: Route | RouteRejection = route;
    if (options.swap !== undefined) {
      out = await attachSwapLeg(out, options.swap, request.maxSlippageBps);
      if (isRejection(out)) return out;
    }
    if (options.integratorFee !== undefined) {
      out = applyIntegratorFee(out, options.integratorFee);
    }
    return out;
  };

  await Promise.all(
    adapters.map(async (adapter) => {
      // Checked here rather than by the caller filtering the list, so a disabled
      // source still reports itself and its reason instead of vanishing.
      const disabledBecause = breaker.reasonFor(adapter.id);
      if (disabledBecause !== undefined) {
        rejected.push(rejectionForDisabled(adapter, disabledBecause));
        settled += 1;
        publish();
        return;
      }

      try {
        // One bound over the quote and the swap leg together: a hung exchange
        // must cost this rail its route, not stall the whole race.
        const result = await withTimeout(
          adapter
            .quote(railRequest)
            .then((quoted) => (isRejection(quoted) ? quoted : enrich(quoted))),
          timeoutMs,
          adapter.id,
        );
        if (isRejection(result)) rejected.push(result);
        else routes.push(result);
      } catch (error) {
        // A source that throws is still a source that declined, and the user is
        // entitled to know which one and why. Swallowing this is how a route
        // silently goes missing.
        rejected.push(toRejection(adapter.id, error));
      } finally {
        settled++;
        publish();
      }
    }),
  );

  return {
    routes: rankRoutes(routes, options.ranking ?? "best-received"),
    rejected,
    complete: true,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimedOut(source, ms));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class TimedOut extends Error {
  readonly source: string;
  constructor(source: string, ms: number) {
    super(`${source} did not answer within ${ms}ms`);
    this.name = "TimedOut";
    this.source = source;
  }
}

/**
 * Turn a thrown error into a rejection a user can be shown.
 *
 * Never a raw error string, a stack trace or a protocol-level message: the
 * functional requirements forbid all three. What the user gets is what happened
 * and, where there is one, what to do.
 */
function toRejection(source: string, error: unknown): RouteRejection {
  if (error instanceof TimedOut) {
    return {
      source,
      reason: "timed-out",
      explanation: "This route source did not respond in time.",
      retryable: true,
    };
  }
  return {
    source,
    reason: "errored",
    explanation: "This route source could not be reached.",
    retryable: true,
  };
}
