import type { Asset, Route, RouteRejection } from "@mavna/core";
import { PUBLIC_MAINNET_RPC_URLS, RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { NearIntentsAdapter } from "./adapter.js";
import { OneClickApi } from "./api.js";
import { stellarDeliveries } from "./assets.js";

/**
 * Against 1Click itself, read-only.
 *
 * Only `/v0/tokens` and dry quotes. A dry quote hands out no deposit address and
 * moves nothing, and nothing here signs or builds a deposit.
 *
 * On 19 October 2026 every quote into Stellar answered "Quoting for this pair is
 * not available", so the quote test accepts that one decline as well as a route:
 * what it proves is that the live answer is read and turned into something a
 * user can act on, either way.
 */

const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** A mainnet account that holds a USDC trustline, from Horizon on 19 October 2026. */
const HOLDER = "GA2226DVH7XAGTRL7LELZ35V5QEAJDVQZLZOEKEIMXBGHB3CB5FCYYPH";

const arbUsdc: Asset = {
  chainId: "arbitrum",
  id: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};
const stellarUsdc: Asset = {
  chainId: "stellar",
  id: `USDC:${CIRCLE}`,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

function adapter(): NearIntentsAdapter {
  return new NearIntentsAdapter({
    network: "mainnet",
    rpc: new RpcClient({ url: PUBLIC_MAINNET_RPC_URLS[0] ?? "" }),
    baseReserveStroops: 5_000_000,
  });
}

describe("1Click on mainnet", () => {
  it("lists Circle's USDC and XLM as what it delivers on Stellar", async () => {
    const delivered = stellarDeliveries(await new OneClickApi().tokens()).map((d) => d.id);
    expect(delivered).toContain(`USDC:${CIRCLE}`);
    expect(delivered).toContain("native");
  });

  it("offers Arbitrum and Ethereum as origin chains", async () => {
    const chains = await adapter().supportedChains();
    expect(chains).toContain("arbitrum");
    expect(chains).toContain("ethereum");
  });

  it("answers a dry quote for USDC from Arbitrum into Stellar with a route or a readable decline", async () => {
    const result: Route | RouteRejection = await adapter().quote({
      from: arbUsdc,
      to: stellarUsdc,
      sends: { asset: arbUsdc, baseUnits: "2000000000" },
      destination: HOLDER,
      maxSlippageBps: 100,
    });

    if ("reason" in result) {
      expect(result).toEqual({
        source: "near-intents",
        reason: "temporarily-unavailable",
        explanation:
          "NEAR Intents is not quoting transfers from Arbitrum One into Stellar right now. Nothing has been sent.",
        retryable: true,
      });
      return;
    }
    expect(result.trustModel).toBe("solver-network");
    expect(result.deliveredAtLeast.asset.id).toBe(`USDC:${CIRCLE}`);
    expect(BigInt(result.receivesAtLeast.baseUnits)).toBeLessThanOrEqual(
      BigInt(result.receives.baseUnits),
    );
  });

  it("refuses a contract address before asking, as 1Click itself does", async () => {
    const result = await adapter().quote({
      from: arbUsdc,
      to: stellarUsdc,
      sends: { asset: arbUsdc, baseUnits: "2000000000" },
      destination: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      maxSlippageBps: 100,
    });
    expect(result).toMatchObject({ reason: "destination-unsupported" });
  });
});
