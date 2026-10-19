import { MavnaError } from "@mavna/core";
import type { SwapProvider } from "./provider.js";
import { type SwapVenueOptions, swapVenuesFor } from "./venues.js";

/**
 * Pick the single exchange for a network, from the same ordered venue list the
 * widget's chain walks (see `swapVenuesFor`): the first that is usable for any
 * pair. Venues limited to some pairs, like SushiSwap for USDT0, are skipped,
 * because a caller asking for one provider for everything cannot respect that.
 *
 * Selection is configuration, not a code path: what differs by network is which
 * provider can actually serve, and that is a fact about the providers rather
 * than a branch in our logic.
 */
export async function selectSwapProvider(selection: SwapVenueOptions): Promise<SwapProvider> {
  for (const venue of swapVenuesFor(selection)) {
    if (venue.serves !== undefined) continue;
    if (await venue.provider.isUsable()) return venue.provider;
  }

  throw new MavnaError(
    `No exchange can serve ${selection.network} right now. Swaps are unavailable; ` +
      "transfers that need no conversion are unaffected.",
    { retryable: true },
  );
}
