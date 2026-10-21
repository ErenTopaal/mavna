import { RpcClient, recipientRefusal } from "@mavna/stellar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NearIntentsAdapter } from "./adapter.js";

/**
 * An address the person has not typed yet, or one that is not an address at all,
 * gets the same words on every rail, and before any network is asked: nothing
 * about the money changes the answer, so nothing should delay it or vary it.
 */
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a NEAR Intents quote for a recipient that is not one", () => {
  afterEach(() => vi.unstubAllGlobals());
  const adapter = () =>
    new NearIntentsAdapter({ network: "mainnet", rpc: nowhere(), baseReserveStroops: 5_000_000 });
  const from = {
    chainId: "arbitrum",
    id: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    symbol: "USDC",
    decimals: 6,
    curatedBy: "Circle",
  };
  const request = (destination: string) => ({
    from,
    to: {
      chainId: "stellar",
      id: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      symbol: "USDC",
      decimals: 7,
      curatedBy: "Circle",
    },
    sends: { asset: from, baseUnits: "5000000" },
    destination,
    maxSlippageBps: 50,
  });

  for (const destination of ["", "GABC123NOTANADDRESS"]) {
    it(`is declined with the shared reason for ${JSON.stringify(destination)}, asking nothing`, async () => {
      const fetched = vi.fn(async () => {
        throw new Error("no network in this test");
      });
      vi.stubGlobal("fetch", fetched);
      const result = await adapter().quote(request(destination));
      expect(result).toMatchObject({
        reason: "destination-unsupported",
        retryable: false,
        explanation: recipientRefusal(destination),
      });
      expect(fetched).not.toHaveBeenCalled();
    });
  }
});
