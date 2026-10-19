import { buildDelivery } from "@mavna/adapter-cctp";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { Asset } from "@stellar/stellar-sdk";
import { env } from "./env.js";
import { createSponsorServer } from "./server.js";

/**
 * The runnable sponsor, configured from the environment.
 *
 * Everything here is deliberately boring: read configuration, refuse to start
 * without the secret, listen. The judgement lives in `server.ts`; this file
 * exists so `node dist/main.mjs` is the whole deployment story, matching the
 * requirement that an integrator can run all of it themselves.
 */

const networkId = env("MAVNA_NETWORK") === "mainnet" ? "mainnet" : "testnet";
const sponsorSecret = env("SPONSOR_SECRET_KEY");
if (sponsorSecret === undefined) {
  console.error("SPONSOR_SECRET_KEY is not set. The sponsor cannot pay without it.");
  process.exit(2);
}

const network = createNetworkConfig({
  id: networkId,
  rpcUrl: env("STELLAR_RPC_URL") ?? (networkId === "mainnet" ? "" : PUBLIC_TESTNET_RPC_URL),
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

// Checked here so a typo stops the process at start-up with its own message,
// rather than a sweep that silently never runs.
const sweepSetting = env("MAVNA_SETTLE_SWEEP_SECONDS");
const settleSweepSeconds = sweepSetting === undefined ? undefined : Number(sweepSetting);
if (
  settleSweepSeconds !== undefined &&
  (!/^\d+$/.test(sweepSetting ?? "") || !Number.isSafeInteger(settleSweepSeconds))
) {
  console.error(
    `MAVNA_SETTLE_SWEEP_SECONDS must be a whole number of seconds, 0 to turn the sweep off; got "${sweepSetting}".`,
  );
  process.exit(2);
}

const server = createSponsorServer({
  rpc: new RpcClient({ url: network.rpcUrl }),
  network,
  networkId,
  sponsorSecret,
  curatedAssets: CURATED,
  buildDelivery,
  irisUrl:
    env("MAVNA_IRIS_URL") ??
    (networkId === "mainnet"
      ? "https://iris-api.circle.com"
      : "https://iris-api-sandbox.circle.com"),
  allowedOrigins: (env("MAVNA_ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:4319")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
  ...(settleSweepSeconds === undefined ? {} : { settleSweepSeconds }),
  ...(env("MAVNA_ARRIVAL_CONTRACT") === undefined
    ? {}
    : { arrivalContract: env("MAVNA_ARRIVAL_CONTRACT") as string }),
});

const port = Number(env("PORT") ?? 8787);
server.listen(port, () => {
  // The one line an operator needs at start-up, on stderr with the rest of the
  // process's own reporting; stdout stays clean for anything piped through it.
  console.error(`[sponsor] listening on :${port}, network ${networkId}`);
  server.startSweep();
});
