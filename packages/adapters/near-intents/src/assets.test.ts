import { describe, expect, it } from "vitest";
import { stellarDeliveries } from "./assets.js";

const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// the row 1Click's /v0/tokens answered on 20 October 2026
const usdc = {
  assetId: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
  decimals: 7,
  blockchain: "stellar",
  symbol: "USDC",
  price: 1,
  priceUpdatedAt: "2026-10-20T10:36:00.821Z",
  contractAddress: CIRCLE,
};

describe("which Stellar assets the rail offers", () => {
  it("offers one paid out on Stellar by the HOT Bridge", () => {
    expect(stellarDeliveries([usdc]).map((d) => d.id)).toEqual([`USDC:${CIRCLE}`]);
  });

  it("offers none that would arrive over a bridge its trust text does not name", () => {
    // what a Stellar asset on another of NEAR Intents' bridges would look like
    const elsewhere = { ...usdc, assetId: "nep141:stellar-usdc.omft.near" };
    expect(stellarDeliveries([elsewhere])).toEqual([]);
  });
});
