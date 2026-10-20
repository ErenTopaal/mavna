import type { Route } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { NearIntentsAdapter } from "./adapter.js";

/**
 * The Arrival Contract only acts on what LayerZero hands it with instructions.
 * A plain transfer to it lands in a contract that has no way to send it on, so
 * every rail refuses it as a destination, before anything is asked of a network.
 */
const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a plain NEAR Intents transfer to the Arrival Contract", () => {
  const adapter = () =>
    new NearIntentsAdapter({
      network: "mainnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
      arrivalContract: ARRIVAL,
    });
  const from = {
    chainId: "arbitrum",
    id: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    symbol: "USDC",
    decimals: 6,
    curatedBy: "Circle",
  };
  const to = {
    chainId: "stellar",
    id: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    symbol: "USDC",
    decimals: 7,
    curatedBy: "Circle",
  };

  it("is declined with the reason", async () => {
    const result = await adapter().quote({
      from,
      to,
      sends: { asset: from, baseUnits: "25000000" },
      destination: ARRIVAL,
      maxSlippageBps: 50,
    });
    expect(result).toMatchObject({ reason: "destination-unsupported", retryable: false });
    expect("explanation" in result && result.explanation).toMatch(/Arrival Contract/);
  });

  it("is refused again when a route naming it is built", async () => {
    await expect(
      adapter().buildTransactions({ destination: ARRIVAL } as unknown as Route, {
        sender: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      }),
    ).rejects.toThrow(/Arrival Contract/);
  });
});
