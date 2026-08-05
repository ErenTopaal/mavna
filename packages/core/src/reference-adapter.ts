import type {
  BridgeAdapter,
  QuoteRequest,
  TransferHandle,
  UnsignedTransaction,
} from "./adapter.js";
import type { StepPhase } from "./execution.js";
import { amountOf } from "./money.js";
import type { Route, RouteRejection } from "./route.js";

/**
 * A rail that does nothing, existing to prove the interface is implementable
 * without touching a network.
 *
 * This is NOT a mock standing in for a real adapter in tests of real behaviour.
 * It answers one question only: can something satisfy BridgeAdapter without
 * reaching outside its own package. Any test asserting that a transfer works must
 * use a real rail against a real network.
 */
export class ReferenceAdapter implements BridgeAdapter {
  readonly id = "reference";
  readonly trustModel = "native-mint" as const;

  async supportedChains(): Promise<readonly string[]> {
    return ["stellar"];
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    if (request.from.chainId === request.to.chainId) {
      return {
        source: this.id,
        reason: "chain-unsupported",
        explanation: "This rail moves value between chains, not within one.",
        retryable: false,
      };
    }
    return {
      source: this.id,
      reason: "temporarily-unavailable",
      explanation: "The reference rail never quotes; it exists to prove the interface.",
      retryable: true,
    };
  }

  async buildTransactions(): Promise<readonly UnsignedTransaction[]> {
    return [];
  }

  async status(_handle: TransferHandle): Promise<StepPhase> {
    return { phase: "idle" };
  }
}

/** Used by the interface test to build a request without inventing an asset shape. */
export const referenceRequest: QuoteRequest = {
  from: { chainId: "ethereum", id: "0x0", symbol: "USDC", decimals: 6, curatedBy: undefined },
  to: { chainId: "stellar", id: "native", symbol: "XLM", decimals: 7, curatedBy: undefined },
  sends: amountOf(
    { chainId: "ethereum", id: "0x0", symbol: "USDC", decimals: 6, curatedBy: undefined },
    "1000000",
  ),
  destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  maxSlippageBps: 50,
};
