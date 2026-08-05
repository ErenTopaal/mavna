import type { StepPhase } from "./execution.js";
import type { Amount, Asset, ChainRef, Fee } from "./money.js";

/**
 * A route and its steps.
 *
 * Execution state is grafted on rather than mutating the quoted shape, so a fresh
 * quote and a transfer in flight are the same type. This is the one structural
 * idea worth taking wholesale from the prior art.
 */

/** How a rail is trusted, in terms a user can weigh without knowing the words. */
export type TrustModel =
  | "native-mint" // the issuer burns and mints; nobody holds your money in between
  | "validator-set" // a named set of validators attests to the transfer
  | "solver-network" // a competing market of solvers fronts the funds
  | "liquidity-pool" // a pool holds both sides and swaps between them
  // The application picks its own verifiers rather than inheriting a fixed set.
  // Kept apart from validator-set because the difference is the user's to weigh:
  // who is trusted is chosen by whoever deployed the token, not by the network,
  // so two routes on the same rail can have different answers.
  | "dvn-stack";

export interface StepQuote {
  readonly id: string;
  readonly kind: "approve-source" | "bridge" | "swap" | "prepare-account" | "settle-account";
  /** Which route source produced this. Errors must be attributable. */
  readonly source: string;
  readonly from: Amount;
  readonly to: Amount;
  /** Seconds, honest rather than optimistic. */
  readonly estimatedSeconds: number;
}

export interface StepExecution {
  readonly status: StepPhase;
  readonly startedAtUnix: number | undefined;
}

/** The quoted step plus, once it starts, what actually happened. */
export interface Step extends StepQuote {
  readonly execution: StepExecution | undefined;
}

export interface Route {
  readonly id: string;
  readonly source: string;
  readonly trustModel: TrustModel;
  readonly fromChain: ChainRef;
  readonly toChain: ChainRef;
  /**
   * Where the value ends up.
   *
   * On the route rather than passed alongside it, because a route without a
   * destination is not a route: an adapter cannot build its transaction without
   * one. Carrying it here also means a quote can never be signed against an
   * address other than the one it was quoted for, which on CCTP is the exact
   * mistake Circle warns about twice, in red, as unrecoverable.
   */
  readonly destination: string;
  readonly sends: Amount;
  /**
   * What actually lands after every fee. This is the primary number in the
   * interface, never the amount sent.
   */
  readonly receives: Amount;
  /** Worst case the user has agreed to, so exposure is bounded by their choice. */
  readonly receivesAtLeast: Amount;
  readonly fees: readonly Fee[];
  readonly estimatedSeconds: number;
  readonly steps: readonly Step[];
  /** How many times the user will be asked to sign, told upfront. */
  readonly signaturesRequired: number;
  /** When this quote stops being honoured. */
  readonly expiresAtUnix: number;
}

/**
 * Why a route source produced nothing.
 *
 * Structural, not a silent omission. The functional requirements say a user must
 * be able to see WHY a route is unavailable rather than watching it quietly not
 * appear, and that is impossible if the reason was never carried.
 */
export interface RouteRejection {
  readonly source: string;
  readonly reason:
    | "no-liquidity"
    | "amount-too-small"
    | "amount-too-large"
    | "asset-unsupported"
    | "chain-unsupported"
    | "destination-unsupported"
    | "temporarily-unavailable"
    | "timed-out"
    | "errored";
  /** Shown to the user. Says what happened and what to do; never apologises. */
  readonly explanation: string;
  /**
   * Whether asking again can change the answer. A rail that is briefly down and
   * a chain that is genuinely unsupported both produce a rejection, and a caller
   * that cannot tell them apart either retries forever or gives up too soon.
   */
  readonly retryable: boolean;
}

/**
 * The result of asking every source at once.
 *
 * Partial results are the NORMAL case, not a degraded one: sources are raced and
 * some answer before others. A caller must be able to render what arrived without
 * waiting for the slowest, which is why this carries both together.
 */
export interface RouteSet {
  readonly routes: readonly Route[];
  readonly rejected: readonly RouteRejection[];
  /** True once every source has answered or timed out. */
  readonly complete: boolean;
}

/**
 * Whether a rejection reason is worth asking about again.
 *
 * Derived from the reason in one place, because three adapters deciding it
 * independently is how the same outage gets three different answers. A reason
 * that describes the request (wrong chain, wrong asset, amount out of range) is
 * settled; one that describes the moment (an outage, a timeout, thin liquidity)
 * is not.
 */
export function rejectionIsRetryable(reason: RouteRejection["reason"]): boolean {
  switch (reason) {
    case "temporarily-unavailable":
    case "timed-out":
    case "no-liquidity":
    case "errored":
      return true;
    default:
      return false;
  }
}

/** How routes are ordered for the user. Default is the best net outcome. */
export type RouteRanking = "best-received" | "fastest" | "fewest-signatures";

export function rankRoutes(routes: readonly Route[], by: RouteRanking): readonly Route[] {
  const sorted = [...routes];
  switch (by) {
    case "best-received":
      return sorted.sort((a, b) => compareBaseUnits(b.receives, a.receives));
    case "fastest":
      return sorted.sort((a, b) => a.estimatedSeconds - b.estimatedSeconds);
    case "fewest-signatures":
      return sorted.sort((a, b) => a.signaturesRequired - b.signaturesRequired);
  }
}

/** Compares integer base units without going through a number. */
function compareBaseUnits(a: Amount, b: Amount): number {
  const left = BigInt(a.baseUnits);
  const right = BigInt(b.baseUnits);
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Identity of an asset pair, used to key quotes and caches. */
export function pairKey(from: Asset, to: Asset): string {
  return `${from.chainId}:${from.id}->${to.chainId}:${to.id}`;
}
