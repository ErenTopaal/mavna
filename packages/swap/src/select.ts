import { MavnaError, type NetworkId } from "@mavna/core";
import { AquariusProvider } from "./aquarius.js";
import type { SwapProvider } from "./provider.js";
import { SoroswapProvider } from "./soroswap.js";

export interface SwapSelection {
  readonly network: NetworkId;
  /** Server-side only. Absent means Soroswap cannot be used. */
  readonly soroswapApiKey?: string;
  readonly soroswapBaseUrl?: string;
  readonly aquariusBaseUrl?: string;
  readonly feeBps?: number;
}

/**
 * Pick the exchange for a network.
 *
 * Selection is configuration, not a code path: no component in this codebase is
 * meaningful on only one network, and there is no "testnet mode" concept anywhere.
 * What differs is which provider can actually serve, and that is a fact about the
 * providers rather than a branch in our logic.
 *
 * Soroswap is preferred where it works, because it is the only one of the two
 * that can collect an integrator fee without deploying a contract. It simply
 * cannot serve testnet, so Aquarius does.
 */
export async function selectSwapProvider(selection: SwapSelection): Promise<SwapProvider> {
  const candidates: SwapProvider[] = [];

  if (selection.soroswapApiKey !== undefined && selection.soroswapApiKey.length > 0) {
    candidates.push(
      new SoroswapProvider({
        network: selection.network,
        apiKey: selection.soroswapApiKey,
        ...(selection.soroswapBaseUrl === undefined ? {} : { baseUrl: selection.soroswapBaseUrl }),
        ...(selection.feeBps === undefined ? {} : { feeBps: selection.feeBps }),
      }),
    );
  }

  candidates.push(new AquariusProvider(selection.network, selection.aquariusBaseUrl));

  for (const candidate of candidates) {
    if (await candidate.isUsable()) return candidate;
  }

  throw new MavnaError(
    `No exchange can serve ${selection.network} right now. Swaps are unavailable; ` +
      "transfers that need no conversion are unaffected.",
    { retryable: true },
  );
}
