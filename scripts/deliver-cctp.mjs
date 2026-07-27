/**
 * Deliver an attested CCTP burn onto Stellar.
 *
 * Circle's own forwarding service does this step on every other chain and cannot
 * serve Stellar, so it is ours to perform and ours to pay for. This is the
 * operator's tool for doing it by hand: the same `Deliverer` the service uses,
 * driven from a transaction hash.
 *
 * Run:
 *   node scripts/deliver-cctp.mjs --tx=0x<burn hash> --domain=<source domain>
 *
 * The paying key comes from SPONSOR_SECRET_KEY in `.env`, which is gitignored.
 * It is never printed and never written anywhere by this script.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Imported from each package's build output rather than by name.
 *
 * Node resolves a bare import from the importing file's location, and no
 * workspace package is a dependency of the repository root. Pointing at the
 * built entry keeps this script out of the root manifest and makes it obvious
 * that it runs against what actually ships, not against the TypeScript source.
 *
 * Run `pnpm build` first if these do not exist.
 */
const { Deliverer } = await import("../services/sponsor/dist/index.mjs");
const { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } = await import(
  "../packages/stellar/dist/index.mjs"
);
const { buildDelivery } = await import("../packages/adapters/cctp/dist/index.mjs");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const txHash = arg("tx");
const domain = arg("domain") ?? "0";
const networkId = arg("network") ?? "testnet";

if (txHash === undefined) {
  console.error(
    "Usage: node scripts/deliver-cctp.mjs --tx=0x<hash> [--domain=0] [--network=testnet]",
  );
  process.exit(2);
}

const ENV_PATH = new URL("../.env", import.meta.url).pathname;
const env = new Map();
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env.set(match[1], match[2]);
  }
}

const payerSecret = env.get("SPONSOR_SECRET_KEY") ?? process.env.SPONSOR_SECRET_KEY;
if (payerSecret === undefined || payerSecret === "") {
  console.error("SPONSOR_SECRET_KEY is not set. It pays the delivery fee and signs it.");
  process.exit(2);
}

const IRIS =
  networkId === "mainnet" ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";

const response = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${txHash}`, {
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json();
const message = body?.messages?.[0];

if (message === undefined) {
  console.error(`Circle has no record of ${txHash} on domain ${domain}.`);
  process.exit(1);
}

console.log(`status: ${message.status}`);
if (message.attestation === "PENDING" || message.status !== "complete") {
  // Not an error. The standard path waits for source-chain finality, which on
  // Ethereum is measured in minutes, and there is nothing to do but wait.
  console.log("Not attested yet. Circle is still waiting for the burn to finalise.");
  process.exit(3);
}

const config = createNetworkConfig({
  id: networkId,
  rpcUrl: env.get("STELLAR_RPC_URL") ?? PUBLIC_TESTNET_RPC_URL,
});

const deliverer = new Deliverer({
  rpc: new RpcClient({ url: config.rpcUrl }),
  network: config,
  networkId,
  payerSecret,
  buildDelivery,
});

console.log(`paying from ${deliverer.payerAddress}`);

const outcome = await deliverer.deliver({
  messageHex: message.message,
  attestationHex: message.attestation,
});

console.log(`outcome: ${outcome.kind}`);
if (outcome.kind === "delivered") {
  console.log(`  tx ${outcome.txHash} in ledger ${outcome.ledger}`);
}
if (outcome.kind === "recipient-not-ready") {
  console.log(`  ${outcome.detail}`);
}

process.exit(outcome.kind === "delivered" || outcome.kind === "already-delivered" ? 0 : 1);
