import { MavnaError, type NetworkId } from "@mavna/core";
import type { Account, Transaction } from "@stellar/stellar-sdk";

/**
 * The exchange layer, behind one interface with two implementations.
 *
 * This is not over-abstraction. Soroswap, the exchange the project specification
 * names as the sole swap dependency, has NO testnet data at all: its own health
 * endpoint reports an empty list of indexed markets there, and every price query
 * on testnet returns "no route found". Aquarius does have a working testnet with
 * real liquidity and needs no key.
 *
 * So a second provider is required for the project to be testable at all, and the
 * specification separately requires that network selection be configuration rather
 * than a code path, and that integrators be able to point every external service
 * at infrastructure they control. Building against exactly one exchange would have
 * violated both regardless.
 */

export interface SwapQuoteRequest {
  /** Stellar contract address of the asset being sold. */
  readonly assetIn: string;
  /** Stellar contract address of the asset being bought. */
  readonly assetOut: string;
  /** Integer base units of assetIn. */
  readonly amountIn: string;
  /**
   * The user's tolerance. Their exposure is bounded by a number they chose;
   * unbounded slippage is not acceptable on any path.
   */
  readonly maxSlippageBps: number;
  /**
   * Where the proceeds land. Matters more than it looks: a route through
   * Stellar's built-in orderbook executes as a classic path payment and CANNOT
   * deliver to a contract address, so the destination type has to be known
   * before choosing venues rather than after.
   */
  readonly destinationKind: "account" | "contract";
  /**
   * When the caller stops waiting. The route race hands down what is left of
   * its budget, so a venue that is still asking by then gives up rather than
   * answering a question nobody is listening to.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface Usability {
  readonly usable: boolean;
  readonly because?: string | undefined;
}

export interface SwapQuote {
  readonly provider: string;
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amountIn: string;
  /** What the quote says will arrive, in base units. */
  readonly amountOut: string;
  /** The worst the user has agreed to accept. */
  readonly amountOutMinimum: string;
  /** Venues this route passes through, for the interface to show. */
  readonly venues: readonly string[];
  /**
   * True when this route executes as a classic path payment rather than through a
   * contract. Classic routes cannot deliver to a contract address.
   */
  readonly isClassicPathPayment: boolean;
  /** Opaque provider payload the builder needs. Never interpreted by callers. */
  readonly raw: unknown;
}

export interface SwapBuildRequest {
  readonly quote: SwapQuote;
  /**
   * The account converting its own money, loaded for its sequence by the
   * caller, which is the one place that knows how fresh that read has to be.
   */
  readonly account: Account;
}

export interface SwapProvider {
  readonly id: string;
  readonly network: NetworkId;

  /**
   * Whether this provider can actually serve this network.
   *
   * Exists because one of them cannot, and discovering that at quote time in
   * production would be far worse than being told here.
   */
  isUsable(): Promise<boolean>;

  /**
   * The same answer with the reason when it is no, so whoever runs this can
   * tell a TLS failure from a wrong URL from a venue that is simply down.
   */
  usability?(): Promise<Usability>;

  quote(request: SwapQuoteRequest): Promise<SwapQuote>;

  /**
   * Turn one of this provider's own quotes into the unsigned transaction that
   * executes it, from and to the owner's account. The floor in the transaction
   * is the quote's `amountOutMinimum`, so the user's slippage choice is what
   * the network enforces, not what a venue promised.
   */
  build(request: SwapBuildRequest): Promise<Transaction>;

  /**
   * Whether an integrator fee can be collected without deploying a contract.
   *
   * This project is forbidden from deploying any custom Soroban contract, so a
   * provider whose fee mechanism needs one earns nothing here. Stated per
   * provider rather than assumed, because the two differ.
   */
  readonly canCollectIntegratorFee: boolean;
}

/**
 * Apply the user's slippage tolerance to a quoted output.
 *
 * Integer arithmetic throughout. Rounding is deliberately DOWN, so the floor we
 * promise is never higher than what the maths supports.
 */
export function applySlippage(amountOut: string, maxSlippageBps: number): string {
  if (!/^\d+$/.test(amountOut)) {
    throw new TypeError(`Quoted output must be integer base units: ${amountOut}`);
  }
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    throw new RangeError(`Slippage must be 0 to 10000 basis points, got ${maxSlippageBps}`);
  }
  const out = BigInt(amountOut);
  return ((out * BigInt(10_000 - maxSlippageBps)) / 10_000n).toString();
}

/**
 * A venue chain's "no", with what a person reads kept apart from what an
 * operator needs.
 *
 * `message` is ours and fixed, because callers show it to users. `detail`
 * carries the venues' own reasons: host error lines, node URLs, fetch causes.
 * Those help whoever runs the integration and can carry raw node errors, so
 * they never go in `message`.
 */
export class SwapRefusal extends MavnaError {
  readonly detail: string;

  constructor(message: string, detail: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options);
    this.name = "SwapRefusal";
    this.detail = detail;
  }
}

/** A cause's operator detail: a refusal's own detail, or its message. */
export function detailOf(cause: unknown): string {
  if (cause instanceof SwapRefusal) return `${cause.message} ${cause.detail}`.trim();
  return cause instanceof Error ? cause.message : String(cause);
}
