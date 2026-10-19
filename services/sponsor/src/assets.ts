import { Asset } from "@stellar/stellar-sdk";

/**
 * The assets a sponsor opens trustlines for, by network, curated by the
 * operator and written here rather than accepted from anywhere: asset identity
 * is code plus issuer, and a sponsor that takes issuers from the wire pays to
 * phish its own users.
 *
 * USDC only, because the settlement repays one USDC trustline. The issuers are
 * Circle's own, as published at developers.circle.com (USDC contract
 * addresses) and in centre.io's stellar.toml; the mainnet issuer's home domain
 * is circle.com.
 */
const CIRCLE_USDC_ISSUER: Readonly<Record<"testnet" | "mainnet", string>> = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

export function curatedAssetsFor(networkId: "testnet" | "mainnet"): Record<string, Asset> {
  return { USDC: new Asset("USDC", CIRCLE_USDC_ISSUER[networkId]) };
}
