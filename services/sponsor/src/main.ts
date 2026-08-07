import { buildDelivery } from "@mavna/adapter-cctp";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { Asset } from "@stellar/stellar-sdk";
import { createSponsorServer } from "./server.js";

/**
 * The runnable sponsor, configured from the environment.
 *
 * Everything here is deliberately boring: read configuration, refuse to start
 * without the secret, listen. The judgement lives in `server.ts`; this file
 * exists so `node dist/main.mjs` is the whole deployment story, matching the
 * requirement that an integrator can run all of it themselves.
 */

const networkId = process.env.MAVNA_NETWORK === "mainnet" ? "mainnet" : "testnet";
const sponsorSecret = process.env.SPONSOR_SECRET_KEY;
if (sponsorSecret === undefined || sponsorSecret === "") {
  console.error("SPONSOR_SECRET_KEY is not set. The sponsor cannot pay without it.");
  process.exit(2);
}

const network = createNetworkConfig({
  id: networkId,
  rpcUrl: process.env.STELLAR_RPC_URL ?? (networkId === "mainnet" ? "" : PUBLIC_TESTNET_RPC_URL),
});
if (network.rpcUrl === "") {
  console.error("STELLAR_RPC_URL is not set and mainnet has no public default worth trusting.");
  process.exit(2);
}

/**
 * The curator is this deployment's operator, and the list is written here rather
 * than accepted from anywhere, because asset identity is code PLUS issuer and a
 * sponsor that takes issuers from the wire pays to phish its own users.
 */
const CURATED: Record<string, Asset> = {
  USDC: new Asset(
    "USDC",
    networkId === "mainnet"
      ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  ),
};

const server = createSponsorServer({
  rpc: new RpcClient({ url: network.rpcUrl }),
  network,
  networkId,
  sponsorSecret,
  curatedAssets: CURATED,
  buildDelivery,
  irisUrl:
    process.env.MAVNA_IRIS_URL ??
    (networkId === "mainnet"
      ? "https://iris-api.circle.com"
      : "https://iris-api-sandbox.circle.com"),
  allowedOrigins: (
    process.env.MAVNA_ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:4319"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  // The one line an operator needs at start-up, on stderr with the rest of the
  // process's own reporting; stdout stays clean for anything piped through it.
  console.error(`[sponsor] listening on :${port}, network ${networkId}`);
});
