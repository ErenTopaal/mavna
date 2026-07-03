import type { StepPhase } from "./execution.js";
import type { Amount, Asset } from "./money.js";
import type { Route, RouteRejection, TrustModel } from "./route.js";

/**
 * What a rail must provide.
 *
 * Adding a rail must require zero changes outside its own package. That is the
 * whole point of this interface, and it is why nothing here mentions a specific
 * bridge, a specific chain, or a specific SDK.
 */

export interface QuoteRequest {
  readonly from: Asset;
  readonly to: Asset;
  readonly sends: Amount;
  /** Where the value ends up. Validated by the adapter for its own rules. */
  readonly destination: string;
  /**
   * The user's tolerance, in basis points. Their exposure is bounded by a number
   * they chose; unbounded slippage is not acceptable on any path.
   */
  readonly maxSlippageBps: number;
}

/** A transaction the caller must sign. The SDK never signs and never submits. */
export interface UnsignedTransaction {
  readonly chainId: string;
  /** Opaque to the SDK. The caller's wallet knows how to read it. */
  readonly payload: string;
  readonly format: "stellar-xdr" | "evm-tx" | "solana-message";
  /** Said in terms that mean something, so consent can be informed. */
  readonly describes: string;
}

/**
 * Where a transfer can be found again.
 *
 * All three are first-class lookup keys, which is the largest single
 * differentiator available. The prior art can only resume from a transaction hash
 * or an internal task id, and its own type refuses a deposit address as a key. On
 * Stellar a deposit address plus memo is the natural shape, and a user who closed
 * the tab has their destination address if they have nothing else.
 */
export interface TransferHandle {
  readonly sourceTxHash: string | undefined;
  readonly depositAddress: string | undefined;
  readonly destinationAddress: string | undefined;
}

export interface BridgeAdapter {
  readonly id: string;
  readonly trustModel: TrustModel;

  /** Chains this rail can move value from, resolved rather than hardcoded. */
  supportedChains(): Promise<readonly string[]>;

  /**
   * Quote, or explain why not.
   *
   * Must resolve within the racing timeout or the routing engine drops it: one
   * slow rail must never hold up the others. Returning a rejection is a normal
   * outcome and is preferred to throwing, because the reason is shown to a user.
   */
  quote(request: QuoteRequest): Promise<Route | RouteRejection>;

  /** Build, never sign, never submit. */
  buildTransactions(route: Route): Promise<readonly UnsignedTransaction[]>;

  /** Where this transfer stands now. */
  status(handle: TransferHandle): Promise<StepPhase>;

  /**
   * Recover a stalled transfer from inside the product.
   *
   * A recoverable failure must be recoverable here, without the user needing a
   * third-party explorer, documentation or support.
   */
  recover?(handle: TransferHandle): Promise<readonly UnsignedTransaction[]>;
}

/** How long a single adapter gets before the race moves on without it. */
export const ADAPTER_QUOTE_TIMEOUT_MS = 3000;

export function isRejection(result: Route | RouteRejection): result is RouteRejection {
  return "reason" in result;
}
