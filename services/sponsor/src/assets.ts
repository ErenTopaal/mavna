import { Asset } from "@stellar/stellar-sdk";

/**
 * The assets a sponsor opens trustlines for, by network, curated by the
 * operator and written here rather than accepted from anywhere: asset identity
 * is code plus issuer, and a sponsor that takes issuers from the wire pays to
 * phish its own users.
 *
 * The USDC issuers are Circle's own, as published at developers.circle.com
 * (USDC contract addresses) and in centre.io's stellar.toml; the mainnet
 * issuer's home domain is circle.com.
 *
 * The USDT0 issuer is the one the LayerZero Stellar USDT0 OFT mints through,
 * read from the OFT's token contract on mainnet (docs.usdt0.to lists the same).
 * There is no USDT0 on testnet.
 */
const CIRCLE_USDC_ISSUER: Readonly<Record<"testnet" | "mainnet", string>> = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const USDT0_ISSUER = "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q";

export function curatedAssetsFor(networkId: "testnet" | "mainnet"): Record<string, Asset> {
  const usdc = new Asset("USDC", CIRCLE_USDC_ISSUER[networkId]);
  if (networkId === "testnet") return { USDC: usdc };
  return { USDC: usdc, USDT0: new Asset("USDT0", USDT0_ISSUER) };
}

/**
 * The curated assets a sponsor-fronted preparation may open, each the asset its
 * settlement then repays the reserve in. A settlement buys the XLM back on the
 * asset's direct market with XLM, so only an asset with one is here: USDC and
 * USDT0 both trade directly against XLM on Stellar's exchange.
 */
export const LENT_ASSETS: readonly string[] = ["USDC", "USDT0"];
