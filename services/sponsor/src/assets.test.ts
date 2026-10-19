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

  it("curates nothing else, since the settlement repays only a USDC trustline", () => {
    expect(Object.keys(curatedAssetsFor("mainnet"))).toEqual(["USDC"]);
    expect(Object.keys(curatedAssetsFor("testnet"))).toEqual(["USDC"]);
  });
});
