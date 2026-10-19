import { MavnaError, type NetworkId } from "@mavna/core";
import type { Transaction } from "@stellar/stellar-sdk";
import { AquariusProvider } from "./aquarius.js";
import type { SwapBuildRequest, SwapProvider, SwapQuote, SwapQuoteRequest } from "./provider.js";
import { SoroswapProvider } from "./soroswap.js";
import { SushiSwapProvider } from "./sushiswap.js";
import { toContractId } from "./wire.js";

/**
 * The swap leg's venues, in the order the v2 design gives them.
 *
 * Soroswap first wherever it serves: it aggregates Soroswap, Phoenix, Aquarius,
 * SushiSwap and Comet pools and, for an account destination, Stellar's own
 * orderbook, and it is the venue that can carry an integrator fee. SushiSwap
 * next, for USDT0 pairs only: it was the first venue to list them and holds the
 * deepest USDT0/USDC pool. Aquarius last, on both networks, as the fallback.
 *
 * SDEX is deliberately not a venue of its own here. The v2 design lists four
 * venues and SDEX is not one of them; the orderbook is still reached through
 * Soroswap for account destinations, and Aquarius now serves the test network,
 * which was the only reason the widget ever used SDEX directly. Stellar Broker
 * is absent too: it executes only as a streaming session that signs many
 * transactions in the background, which is not one conversion the recipient
 * signs.
 *
 * The first venue that is usable and quotes wins. This is an order of
 * preference, not a price race: racing would hand the conversion to whichever
 * venue shaves a few stroops, and the order is a product decision.
 */

/** USDT0 on Stellar: the classic asset, whose contract is its Stellar Asset Contract. */
export const STELLAR_USDT0 = "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q";

/** How long a venue's "usable" answer is trusted before it is asked again. */
const USABLE_FOR_MS = 60_000;

export interface SwapVenueOptions {
  readonly network: NetworkId;
  /**
   * The sponsor service that proxies Soroswap. Absent means no Soroswap: the
   * key lives only on a server, and without one there is nothing to call.
   */
  readonly soroswapProxyUrl?: string;
  /** Integrator fee for Soroswap, in bps: 0, or 25 to 300. */
  readonly soroswapFeeBps?: number;
  /** Stellar RPC for the contract venues' simulations. */
  readonly rpcUrl?: string;
  readonly aquariusBaseUrl?: string;
}

/** One venue in the chain, and the pairs it is allowed to serve. */
export interface Venue {
  readonly provider: SwapProvider;
  /** Undefined serves every pair. */
  readonly serves?: (assetIn: string, assetOut: string) => boolean;
}

/** The venue list for a network, in order. */
export function swapVenuesFor(options: SwapVenueOptions): Venue[] {
  const { network } = options;
  const venues: Venue[] = [];
  if (options.soroswapProxyUrl !== undefined && options.soroswapProxyUrl !== "") {
    venues.push({
      provider: new SoroswapProvider({
        network,
        proxyUrl: options.soroswapProxyUrl,
        ...(options.soroswapFeeBps === undefined ? {} : { feeBps: options.soroswapFeeBps }),
      }),
    });
  }
  if (network === "mainnet") {
    const usdt0 = toContractId(STELLAR_USDT0, network);
    venues.push({
      provider: new SushiSwapProvider({
        network,
        ...(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl }),
      }),
      serves: (assetIn, assetOut) =>
        toContractId(assetIn, network) === usdt0 || toContractId(assetOut, network) === usdt0,
    });
  }
  venues.push({
    provider: new AquariusProvider(
      network,
      options.aquariusBaseUrl,
      options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl },
    ),
  });
  return venues;
}

/**
 * The venue chain as one provider, so the route race and the conversion step
 * can treat it like any single venue. A quote names the venue that gave it, and
 * building goes back to that venue.
 */
export class SwapVenues implements SwapProvider {
  readonly id = "venues";
  readonly network: NetworkId;
  /** True when any venue in the chain could carry a fee. Which one quotes decides. */
  readonly canCollectIntegratorFee: boolean;

  private readonly venues: readonly Venue[];
  private readonly usable = new Map<string, { value: boolean; at: number }>();

  constructor(network: NetworkId, venues: readonly Venue[]) {
    this.network = network;
    this.venues = venues;
    this.canCollectIntegratorFee = venues.some((v) => v.provider.canCollectIntegratorFee);
    for (const venue of venues) {
      if (venue.provider.network !== network) {
        throw new MavnaError(
          `The ${venue.provider.id} venue is configured for ${venue.provider.network}, not ${network}.`,
          { retryable: false },
        );
      }
    }
  }

  /** The ids, in order, for display and for tests. */
  get order(): readonly string[] {
    return this.venues.map((v) => v.provider.id);
  }

  async isUsable(): Promise<boolean> {
    for (const venue of this.venues) {
      if (await this.isVenueUsable(venue.provider)) return true;
    }
    return false;
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const reasons: string[] = [];
    let retryable = false;
    for (const venue of this.venues) {
      if (venue.serves !== undefined && !venue.serves(request.assetIn, request.assetOut)) continue;
      if (!(await this.isVenueUsable(venue.provider))) {
        reasons.push(`${venue.provider.id} is unavailable`);
        retryable = true;
        continue;
      }
      try {
        return await venue.provider.quote(request);
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        reasons.push(`${venue.provider.id}: ${why}`);
        retryable ||= !(cause instanceof MavnaError) || cause.retryable;
      }
    }
    throw new MavnaError(
      reasons.length === 0
        ? "No swap venue serves this pair on this network."
        : `No swap venue could convert this. ${reasons.join("; ")}`,
      { retryable },
    );
  }

  async build(request: SwapBuildRequest): Promise<Transaction> {
    const venue = this.venues.find((v) => v.provider.id === request.quote.provider);
    if (venue === undefined) {
      throw new MavnaError(
        `This quote came from ${request.quote.provider}, which is not one of these venues.`,
        { retryable: false },
      );
    }
    return venue.provider.build(request);
  }

  private async isVenueUsable(provider: SwapProvider): Promise<boolean> {
    const known = this.usable.get(provider.id);
    if (known !== undefined && Date.now() - known.at < USABLE_FOR_MS) return known.value;
    const value = await provider.isUsable();
    this.usable.set(provider.id, { value, at: Date.now() });
    return value;
  }
}

/** The ordered venue chain for a network, ready to quote and build. */
export function createSwapVenues(options: SwapVenueOptions): SwapVenues {
  return new SwapVenues(options.network, swapVenuesFor(options));
}
