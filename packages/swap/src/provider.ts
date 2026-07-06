import type { NetworkId } from "@mavna/core";

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

  quote(request: SwapQuoteRequest): Promise<SwapQuote>;

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
