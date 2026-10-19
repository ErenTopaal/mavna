import { type ComposeHop, MavnaError, type NetworkId } from "@mavna/core";
import { Address, xdr } from "@stellar/stellar-sdk";
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

  /**
   * The same quote with the route as hops, for a contract that calls the router
   * itself (the Arrival Contract). The hops are checked to start from what is
   * sold and end in what is bought, so a chain for some other pair is refused.
   */
  async quotePath(request: Omit<SwapQuoteRequest, "destinationKind">): Promise<PathQuote> {
    const quote = await this.quote({ ...request, destinationKind: "contract" });
    const path = decodeSwapChain((quote.raw as FindPathResponse).swap_chain_xdr);
    let holding = request.assetIn;
    for (const hop of path) {
      if (!hop.tokens.includes(holding) || !hop.tokens.includes(hop.tokenOut)) {
        throw new MavnaError("Aquarius returned a swap chain that does not connect.", {
          retryable: false,
        });
      }
      holding = hop.tokenOut;
    }
    if (holding !== request.assetOut) {
      throw new MavnaError("Aquarius returned a swap chain that ends in another asset.", {
        retryable: false,
      });
    }
    return {
      provider: quote.provider,
      amountOut: quote.amountOut,
      amountOutMinimum: quote.amountOutMinimum,
      path,
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

/** A venue quote that a contract can execute itself, hop by hop. */
export interface PathQuote {
  readonly provider: string;
  readonly amountOut: string;
  readonly amountOutMinimum: string;
  readonly path: readonly ComposeHop[];
}

/**
 * Decode Aquarius's swap chain into the hops its router takes.
 *
 * The chain is the router's own `swap_chained` argument,
 * `Vec<(Vec<Address>, BytesN<32>, Address)>`, so a contract that calls the
 * router with these hops runs exactly the route that was priced. Anything not
 * in that shape is refused rather than guessed at.
 */
export function decodeSwapChain(swapChainXdr: string): readonly ComposeHop[] {
  let chain: xdr.ScVal;
  try {
    chain = xdr.ScVal.fromXDR(swapChainXdr, "base64");
  } catch (cause) {
    throw new MavnaError("Aquarius returned a swap chain that is not readable.", {
      retryable: false,
      cause,
    });
  }
  const bad = (): never => {
    throw new MavnaError("Aquarius returned a swap chain in a shape its router does not take.", {
      retryable: false,
    });
  };
  const vec = (v: xdr.ScVal): xdr.ScVal[] =>
    v.switch().name === "scvVec" ? (v.vec() ?? []) : bad();
  const address = (v: xdr.ScVal): string =>
    v.switch().name === "scvAddress" ? Address.fromScVal(v).toString() : bad();

  const hops = vec(chain).map((hop): ComposeHop => {
    const [tokens, index, out] = vec(hop);
    if (tokens === undefined || index === undefined || out === undefined || vec(hop).length !== 3) {
      return bad();
    }
    const indexBytes = index.switch().name === "scvBytes" ? index.bytes() : bad();
    if (indexBytes.length !== 32) bad();
    return {
      tokens: vec(tokens).map(address),
      poolIndex: Buffer.from(indexBytes).toString("hex"),
      tokenOut: address(out),
    };
  });
  if (hops.length === 0) bad();
  return hops;
}
