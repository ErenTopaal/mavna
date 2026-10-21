import { RpcClient, recipientRefusal } from "@mavna/stellar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerZeroAdapter } from "./adapter.js";

/**
 * An address the person has not typed yet, or one that is not an address at all,
 * gets the same words on every rail, and before any network is asked: nothing
 * about the money changes the answer, so nothing should delay it or vary it.
 */
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a LayerZero quote for a recipient that is not one", () => {
  afterEach(() => vi.unstubAllGlobals());
  const adapter = () =>
    new LayerZeroAdapter({ network: "testnet", rpc: nowhere(), baseReserveStroops: 5_000_000 });
  const from = {
    chainId: "arbitrum-sepolia",
    id: "0x0000000000000000000000000000000000000001",
    symbol: "TOFT",
    decimals: 18,
    curatedBy: undefined,
  };
  const request = (destination: string) => ({
    from,
    to: {
      chainId: "stellar-testnet",
      id: "native",
      symbol: "XLM",
      decimals: 7,
      curatedBy: "Stellar",
    },
    sends: { asset: from, baseUnits: "1000" },
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
