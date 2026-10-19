import { MavnaError, type NetworkId } from "@mavna/core";
import {
  applySlippage,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
} from "./provider.js";

/**
 * Soroswap. The mainnet provider.
 *
 * Three things about it shape this code, and none are in the project
 * specification:
 *
 * 1. It has NO testnet data. Its own health endpoint reports an empty list of
 *    indexed markets for testnet, and every price query there returns no route.
 *    The parameter exists; there is nothing behind it.
 * 2. Its key is a SERVER-SIDE SECRET. Anything shipped to a browser is public, so
 *    this provider can never be constructed in client code. That is why the SDK
 *    reaches it through a caller-supplied endpoint rather than embedding a key.
 * 3. Its integrator fee is contract-free, which is the decisive advantage over
 *    Aquarius, but it is currently BROKEN on Soroban routes and works only on
 *    classic orderbook routes. And the integrator keeps 60 percent of it, not all.
 */

export interface SoroswapOptions {
  readonly network: NetworkId;
  /**
   * Where to reach the API.
   *
   * Defaults to Soroswap's own host, but an integrator must be able to point this
   * at infrastructure they control, so our rate limits and our exposure never
   * silently become theirs.
   */
  readonly baseUrl?: string;
  /**
   * Server-side only. If this is ever set in code that ships to a browser, the
   * key is disclosed the moment it ships, whatever the documentation says.
   */
  readonly apiKey: string;
  /** Basis points. The integrator keeps roughly 60 percent of whatever is set. */
  readonly feeBps?: number;
  /** How long a request gets before it is abandoned. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/** Venues Soroswap can route through. */
export type SoroswapProtocol = "soroswap" | "phoenix" | "aqua" | "sdex";

interface QuoteResponse {
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly otherAmountThreshold: string;
  readonly priceImpactPct: string;
  readonly platform: string;
  readonly routePlan?: readonly { swapInfo?: { protocol?: string } }[];
}

export class SoroswapProvider implements SwapProvider {
  readonly id = "soroswap";
  readonly network: NetworkId;
  /** One request parameter, no contract. The decisive advantage over Aquarius. */
  readonly canCollectIntegratorFee = true;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly feeBps: number | undefined;
  private readonly timeoutMs: number;

  constructor(options: SoroswapOptions) {
    this.network = options.network;
    this.baseUrl = options.baseUrl ?? "https://api.soroswap.finance";
    this.apiKey = options.apiKey;
    this.feeBps = options.feeBps;
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (this.apiKey.length === 0) {
      throw new MavnaError("Soroswap needs an API key, and it is server-side only.", {
        retryable: false,
      });
    }
  }

  /**
   * Asks the service which networks it has actually indexed.
   *
   * On testnet this returns false, which is the whole reason a second provider
   * exists. Better to be told here than to discover it when a user is waiting.
   */
  async isUsable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as {
        status?: { indexer?: Record<string, string[]> };
      };
      const indexed = body.status?.indexer?.[this.network] ?? [];
      return indexed.length > 0;
    } catch {
      return false;
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const protocols = protocolsFor(request.destinationKind);

    const response = await fetchOrThrow(`${this.baseUrl}/quote?network=${this.network}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        assetIn: request.assetIn,
        assetOut: request.assetOut,
        amount: request.amountIn,
        tradeType: "EXACT_IN",
        protocols,
        slippageBps: request.maxSlippageBps,
        ...(this.feeBps === undefined ? {} : { feeBps: this.feeBps }),
      }),
    });

    if (response.status === 429) {
      throw new MavnaError("Soroswap is rate limiting us; back off rather than retrying hard.", {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new MavnaError(`Soroswap could not price this swap (HTTP ${response.status}).`, {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as QuoteResponse;
    const isClassic = body.platform === "sdex";

    // Belt and braces. The protocol set above should already prevent this, but a
    // classic route to a contract address fails at build time with an opaque
    // error, and catching it here says something useful instead.
    if (isClassic && request.destinationKind === "contract") {
      throw new MavnaError(
        "This route runs through Stellar's built-in orderbook, which cannot deliver " +
          "to a contract address. Route through the aggregator instead.",
        { retryable: false },
      );
    }

    return {
      provider: this.id,
      assetIn: body.assetIn,
      assetOut: body.assetOut,
      amountIn: body.amountIn,
      amountOut: body.amountOut,
      // Soroswap computes its own threshold from the slippage we sent; ours is
      // recomputed rather than trusted, because it is what bounds the user.
      amountOutMinimum: applySlippage(body.amountOut, request.maxSlippageBps),
      venues: (body.routePlan ?? [])
        .map((leg) => leg.swapInfo?.protocol)
        .filter((p): p is string => typeof p === "string"),
      isClassicPathPayment: isClassic,
      raw: body,
    };
  }
}

/**
 * Which venues may be used, decided by where the money is going.
 *
 * Stellar's built-in orderbook is excluded for contract destinations. Soroswap's
 * own guidance is blunt about it: "Exclude 'sdex' for smart wallets". Their
 * on-chain aggregator only handles Soroban protocols, so orderbook routes execute
 * as classic path payments, and a classic path payment cannot pay a contract.
 *
 * The sharp edge is that the orderbook OFTEN WINS ON PRICE, so including it and
 * discovering the problem at build time is a real trap. Decide first.
 */
export function protocolsFor(destinationKind: "account" | "contract"): SoroswapProtocol[] {
  return destinationKind === "contract"
    ? ["soroswap", "phoenix", "aqua"]
    : ["soroswap", "phoenix", "aqua", "sdex"];
}

/** A network failure or timeout is the service being briefly unreachable, so it is retryable. */
async function fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new MavnaError("Soroswap did not answer.", { retryable: true, cause });
  }
}
