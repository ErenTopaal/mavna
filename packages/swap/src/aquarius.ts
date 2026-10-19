import { MavnaError, type NetworkId } from "@mavna/core";
import {
  applySlippage,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
} from "./provider.js";

/**
 * Aquarius. The provider that makes testnet possible.
 *
 * Needs no key, has real liquidity on testnet, and routes across its own pools.
 * It is used on testnet for exactly that reason, and is a credible fallback on
 * mainnet if Soroswap is degraded.
 *
 * It earns us nothing, and that is a deliberate accepted trade rather than an
 * oversight. Its `provider_fee` parameter is quote ARITHMETIC ONLY: it changes
 * the displayed net figure and moves no money, and there is no recipient field
 * anywhere in its request. Collecting a real fee requires deploying your own
 * fee-collector contract, which this project is forbidden from doing. Verified
 * against the live service: passing a fee changed only the reported
 * `amount_with_fee` and left the actual `amount` identical.
 */

const BASE_URL: Readonly<Record<NetworkId, string>> = {
  testnet: "https://amm-api-testnet.aqua.network",
  mainnet: "https://amm-api.aqua.network",
};

/** Without a bound, a hung exchange holds the whole route race open. */
const DEFAULT_TIMEOUT_MS = 10_000;

interface FindPathResponse {
  readonly success: boolean;
  readonly swap_chain_xdr: string;
  readonly pools: readonly string[];
  readonly tokens: readonly string[];
  readonly tokens_addresses: readonly string[];
  readonly amount: number;
  readonly amount_with_fee: number;
}

export class AquariusProvider implements SwapProvider {
  readonly id = "aquarius";
  readonly network: NetworkId;
  /** No contract-free mechanism exists. See the note at the top of this file. */
  readonly canCollectIntegratorFee = false;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(network: NetworkId, baseUrl?: string, options: { readonly timeoutMs?: number } = {}) {
    this.network = network;
    this.baseUrl = baseUrl ?? BASE_URL[network];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async isUsable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/external/v1/pools/?size=1`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { count?: number };
      return typeof body.count === "number" && body.count > 0;
    } catch {
      return false;
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const response = await fetchOrThrow(`${this.baseUrl}/api/external/v1/find-path/`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: request.assetIn,
        token_out_address: request.assetOut,
        amount: request.amountIn,
      }),
    });

    if (!response.ok) {
      throw new MavnaError(`Aquarius could not price this swap (HTTP ${response.status}).`, {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as FindPathResponse;

    if (!body.success || body.pools.length === 0) {
      throw new MavnaError("Aquarius has no route between these assets.", { retryable: false });
    }

    // The service reports amounts as JSON numbers. Anything above what a double
    // holds exactly would already have been mangled before it reached us, so this
    // is checked rather than trusted, and converted to a string immediately.
    if (!Number.isSafeInteger(body.amount)) {
      throw new MavnaError(
        "Aquarius returned an amount too large to be exact as a number. Refusing to use it.",
        { retryable: false },
      );
    }

    const amountOut = BigInt(body.amount).toString();

    return {
      provider: this.id,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: request.amountIn,
      amountOut,
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      venues: [...body.pools],
      // Aquarius routes through Soroban pools, so this is never a classic path
      // payment and can therefore deliver to a contract address.
      isClassicPathPayment: false,
      raw: body,
    };
  }
}

/** A network failure or timeout is the service being briefly unreachable, so it is retryable. */
async function fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new MavnaError("Aquarius did not answer.", { retryable: true, cause });
  }
}
