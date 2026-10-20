import { MavnaError, type NetworkId } from "@mavna/core";
import type { Transaction } from "@stellar/stellar-sdk";
import { AquariusProvider } from "./aquarius.js";
import {
  detailOf,
  type SwapBuildRequest,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
  SwapRefusal,
  type Usability,
} from "./provider.js";
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
 * venue shaves a few stroops, and the order is a product decision. The venues
 * are asked at the same time for speed, but their answers are read in this
 * order.
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
  private readonly usable = new Map<string, { value: Usability; at: number }>();

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
      if ((await this.isVenueUsable(venue.provider)).usable) return true;
    }
    return false;
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const reasons: string[] = [];
    let retryable = false;
    const serving: Venue[] = [];
    for (const venue of this.venues) {
      // a pair this venue cannot even read is its reason, not the chain's end
      try {
        if (venue.serves?.(request.assetIn, request.assetOut) ?? true) serving.push(venue);
      } catch (cause) {
        reasons.push(`${venue.provider.id}: ${detailOf(cause)}`);
        retryable ||= cause instanceof MavnaError && cause.retryable;
      }
    }

    // Every serving venue is asked at once and the answers are then read in
    // order. Asked one after another, a venue that is slow to answer spends the
    // next one's time: measured cold, the chain alone took 1.7 to 2.3 s of the
    // route race's 3 s, and an unreachable Soroswap in front of it cost the route.
    type Outcome = { quote: SwapQuote } | { reason: string; retryable: boolean };
    const outcomes: (Outcome | undefined)[] = serving.map(() => undefined);
    const asked = serving.map(async (venue, i): Promise<Outcome> => {
      let outcome: Outcome;
      try {
        const usability = await this.isVenueUsable(venue.provider);
        if (!usability.usable) {
          const why = usability.because === undefined ? "" : ` (${usability.because})`;
          outcome = { reason: `${venue.provider.id} is unavailable${why}`, retryable: true };
        } else {
          outcome = { quote: await venue.provider.quote(request) };
        }
      } catch (cause) {
        const why = detailOf(cause);
        outcome = {
          reason: `${venue.provider.id}: ${why}`,
          retryable: !(cause instanceof MavnaError) || cause.retryable,
        };
      }
      outcomes[i] = outcome;
      return outcome;
    });

    const signal = request.signal;
    const deadline =
      signal === undefined
        ? undefined
        : new Promise<"late">((resolve) => {
            if (signal.aborted) resolve("late");
            else signal.addEventListener("abort", () => resolve("late"), { once: true });
          });

    for (let i = 0; i < serving.length; i++) {
      const outcome = await (deadline === undefined
        ? (asked[i] as Promise<Outcome>)
        : Promise.race([asked[i] as Promise<Outcome>, deadline]));
      if (outcome === "late") {
        // the preferred venues are out of time; a later one that has already
        // answered is still a quote, in the same order of preference
        const ready = outcomes.slice(i).find((o) => o !== undefined && "quote" in o);
        if (ready !== undefined && "quote" in ready) return ready.quote;
        const waiting = serving
          .filter((_, j) => j >= i && outcomes[j] === undefined)
          .map((v) => v.provider.id);
        for (const o of outcomes.slice(i))
          if (o !== undefined && "reason" in o) reasons.push(o.reason);
        reasons.push(`${waiting.join(", ")} did not answer in time`);
        throw new SwapRefusal("No swap venue could convert this in time.", reasons.join("; "), {
          retryable: true,
        });
      }
      if ("quote" in outcome) return outcome.quote;
      reasons.push(outcome.reason);
      retryable ||= outcome.retryable;
    }
    throw new SwapRefusal(
      reasons.length === 0
        ? "No swap venue serves this pair on this network."
        : "No swap venue could convert this.",
      reasons.join("; "),
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

  private async isVenueUsable(provider: SwapProvider): Promise<Usability> {
    const known = this.usable.get(provider.id);
    if (known !== undefined && Date.now() - known.at < USABLE_FOR_MS) return known.value;
    const value: Usability =
      provider.usability === undefined
        ? { usable: await provider.isUsable() }
        : await provider.usability();
    this.usable.set(provider.id, { value, at: Date.now() });
    return value;
  }
}

/** The ordered venue chain for a network, ready to quote and build. */
export function createSwapVenues(options: SwapVenueOptions): SwapVenues {
  return new SwapVenues(options.network, swapVenuesFor(options));
}
