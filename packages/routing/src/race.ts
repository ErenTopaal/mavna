import {
  ADAPTER_QUOTE_TIMEOUT_MS,
  type BridgeAdapter,
  isRejection,
  type QuoteRequest,
  type Route,
  type RouteRejection,
  type RouteSet,
} from "@mavna/core";

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
   * Called each time a source answers, so an interface can show routes as they
   * land rather than all at once at the end. This is what makes the wait feel
   * like progress instead of a spinner.
   */
  readonly onUpdate?: (partial: RouteSet) => void;
}

export async function raceAdapters(
  adapters: readonly BridgeAdapter[],
  request: QuoteRequest,
  options: RaceOptions = {},
): Promise<RouteSet> {
  const timeoutMs = options.timeoutMs ?? ADAPTER_QUOTE_TIMEOUT_MS;
  const routes: Route[] = [];
  const rejected: RouteRejection[] = [];
  let settled = 0;

  const publish = (): void => {
    options.onUpdate?.({
      routes: [...routes],
      rejected: [...rejected],
      complete: settled === adapters.length,
    });
  };

  await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const result = await withTimeout(adapter.quote(request), timeoutMs, adapter.id);
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

  return { routes, rejected, complete: true };
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
    };
  }
  return {
    source,
    reason: "errored",
    explanation: "This route source could not be reached.",
  };
}
