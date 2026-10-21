import { RpcClient, recipientRefusal } from "@mavna/stellar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AxelarAdapter } from "./adapter.js";

/**
 * An address the person has not typed yet, or one that is not an address at all,
 * gets the same words on every rail, and before any network is asked: nothing
 * about the money changes the answer, so nothing should delay it or vary it.
 */
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a Axelar quote for a recipient that is not one", () => {
  afterEach(() => vi.unstubAllGlobals());
  const adapter = () =>
    new AxelarAdapter({ network: "testnet", rpc: nowhere(), baseReserveStroops: 5_000_000 });
  const from = {
    chainId: "base-sepolia",
    id: "0xa813265d59c9bc06e439e61fa133b5f23134b2ce",
    symbol: "USDC",
    decimals: 6,
    curatedBy: undefined,
  };
  const request = (destination: string) => ({
    from,
    to: {
      chainId: "stellar-testnet",
      id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      symbol: "USDC",
      decimals: 7,
      curatedBy: undefined,
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
