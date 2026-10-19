import { describe, expect, it } from "vitest";
import { curatedAssetsFor } from "./assets.js";

describe("the assets this sponsor opens trustlines for", () => {
  it("names Circle's mainnet USDC issuer, as Circle publishes it", () => {
    // Checked 2026-10-19 against developers.circle.com/stablecoins/usdc-contract-addresses,
    // centre.io/.well-known/stellar.toml, and the issuer account's home domain, circle.com.
    const usdc = curatedAssetsFor("mainnet").USDC;
    expect(usdc?.getCode()).toBe("USDC");
    expect(usdc?.getIssuer()).toBe("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  });

  it("names Circle's testnet USDC issuer on testnet", () => {
    expect(curatedAssetsFor("testnet").USDC?.getIssuer()).toBe(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
  });

  it("names the USDT0 asset the LayerZero Stellar OFT mints, on mainnet only", () => {
    // Read 2026-10-19 from the USDT0 OFT CBOWOLFS...MMF6: its Token is the asset contract
    // CBSJZEIO...26YF, whose AssetInfo is USDT0 issued by GATISXX6...HN6Q (matches
    // docs.usdt0.to and developers.stellar.org/launch/usdt0). There is no USDT0 on testnet.
    const usdt0 = curatedAssetsFor("mainnet").USDT0;
    expect(usdt0?.getCode()).toBe("USDT0");
    expect(usdt0?.getIssuer()).toBe("GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q");
  });

  it("curates nothing else", () => {
    expect(Object.keys(curatedAssetsFor("mainnet"))).toEqual(["USDC", "USDT0"]);
    expect(Object.keys(curatedAssetsFor("testnet"))).toEqual(["USDC"]);
  });
});
