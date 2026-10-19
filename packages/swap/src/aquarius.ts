import { MavnaError, type NetworkId } from "@mavna/core";
import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { Address, nativeToScVal, type Transaction, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  applySlippage,
  type SwapBuildRequest,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
} from "./provider.js";
import { buildContractCall } from "./soroban.js";
import { fetchOrThrow, readValidated, toContractId, validated } from "./wire.js";

/**
 * Aquarius. The fallback venue, on both networks.
 *
 * Needs no key, has real liquidity on testnet (including Circle's testnet USDC
 * now), and routes across its own pools. Its swaps run through its router
 * contract, so they can deliver to a contract address, which is what makes it a
 * venue the Arrival Contract can call.
 *
 * It earns us nothing, and that is a deliberate accepted trade rather than an
 * oversight. Its `provider_fee` parameter is quote ARITHMETIC ONLY: it changes
 * the displayed net figure and moves no money, and there is no recipient field
 * anywhere in its request. Verified against the live service: passing a fee
 * changed only the reported `amount_with_fee` and left the actual `amount`
 * identical.
 */

const BASE_URL: Readonly<Record<NetworkId, string>> = {
  testnet: "https://amm-api-testnet.aqua.network",
  mainnet: "https://amm-api.aqua.network",
};

/**
 * The router every pool trusts, read from the `Router` key of a live pool's
 * instance storage on each network. Mainnet's also matches Aquarius's docs.
 */
const ROUTER: Readonly<Record<NetworkId, string>> = {
  mainnet: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  testnet: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
};

const DEFAULT_RPC: Readonly<Record<NetworkId, string>> = {
  mainnet: PUBLIC_MAINNET_RPC_URLS[0] ?? "",
  testnet: PUBLIC_TESTNET_RPC_URL,
};

/** Without a bound, a hung exchange holds the whole route race open. */
const DEFAULT_TIMEOUT_MS = 10_000;

const findPath = z.object({
  success: z.boolean(),
  swap_chain_xdr: z.string(),
  pools: z.array(z.string()),
  tokens_addresses: z.array(z.string()),
  // The service reports amounts as JSON numbers. Anything above what a double
  // holds exactly was already mangled before it reached us, so it is refused.
  amount: z.number().refine(Number.isSafeInteger, "not an exact integer amount"),
});

/** What build needs from a quote, kept as the quote's raw payload. */
const aquariusRaw = z.object({
  tokenIn: z.string().regex(/^C[A-Z2-7]{55}$/),
  swapChainXdr: z.string(),
});

const poolsPage = z.object({ count: z.number().int() });

export interface AquariusOptions {
  readonly timeoutMs?: number;
  /** Stellar RPC used to simulate the swap at build time. */
  readonly rpcUrl?: string;
}

export class AquariusProvider implements SwapProvider {
  readonly id = "aquarius";
  readonly network: NetworkId;
  /** No contract-free mechanism exists. See the note at the top of this file. */
  readonly canCollectIntegratorFee = false;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rpcUrl: string;

  constructor(network: NetworkId, baseUrl?: string, options: AquariusOptions = {}) {
    this.network = network;
    this.baseUrl = baseUrl ?? BASE_URL[network];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rpcUrl = options.rpcUrl ?? DEFAULT_RPC[network];
  }

  async isUsable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/external/v1/pools/?size=1`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const parsed = poolsPage.safeParse(await response.json());
      return parsed.success && parsed.data.count > 0;
    } catch {
      // isUsable answers a question; an unreachable service is the answer "no".
      return false;
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const tokenIn = toContractId(request.assetIn, this.network);
    const tokenOut = toContractId(request.assetOut, this.network);
    const response = await fetchOrThrow("Aquarius", `${this.baseUrl}/api/external/v1/find-path/`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenIn,
        token_out_address: tokenOut,
        amount: request.amountIn,
      }),
    });

    if (!response.ok) {
      throw new MavnaError(`Aquarius could not price this swap (HTTP ${response.status}).`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const body = await readValidated("Aquarius", response, findPath);

    if (!body.success || body.pools.length === 0) {
      throw new MavnaError("Aquarius has no route between these assets.", { retryable: false });
    }
    // The chain is what gets executed, so it has to start and end where we asked.
    if (body.tokens_addresses[0] !== tokenIn || body.tokens_addresses.at(-1) !== tokenOut) {
      throw new MavnaError("Aquarius answered a different question than the one asked.", {
        retryable: false,
      });
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
      raw: { tokenIn, swapChainXdr: body.swap_chain_xdr },
    };
  }

  /**
   * `swap_chained(user, swaps_chain, token_in, in_amount, out_min)` on the
   * router, the call Aquarius documents for a strict-send swap along a found
   * path. The owner is both payer and recipient.
   */
  async build(request: SwapBuildRequest): Promise<Transaction> {
    if (request.quote.provider !== this.id) {
      throw new MavnaError("This quote came from another venue; build it there.", {
        retryable: false,
      });
    }
    const raw = validated("Aquarius", aquariusRaw, request.quote.raw);
    let chain: xdr.ScVal;
    try {
      chain = xdr.ScVal.fromXDR(raw.swapChainXdr, "base64");
    } catch (cause) {
      throw new MavnaError("Aquarius returned a swap path that does not decode.", {
        retryable: false,
        cause,
      });
    }
    return buildContractCall(
      this.rpcUrl,
      this.network,
      request.account,
      ROUTER[this.network],
      "swap_chained",
      [
        new Address(request.account.accountId()).toScVal(),
        chain,
        new Address(raw.tokenIn).toScVal(),
        nativeToScVal(BigInt(request.quote.amountIn), { type: "u128" }),
        nativeToScVal(BigInt(request.quote.amountOutMinimum), { type: "u128" }),
      ],
      this.timeoutMs,
      "Aquarius",
    );
  }
}
