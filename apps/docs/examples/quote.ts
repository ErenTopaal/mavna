/**
 * The SDK quickstart, as a file you can run.
 *
 * Node 24 executes TypeScript directly, so there is no build step between reading
 * this and seeing a real quote:
 *
 *   node examples/quote.ts GDESTINATION... 25 ethereum-sepolia
 *
 * Everything here talks to the live network. The fee comes from Circle and the
 * state of the destination is read off Stellar, so a wrong address produces a
 * real refusal rather than a placeholder.
 */
import { AxelarAdapter } from "@mavna/adapter-axelar";
import { CCTP_CONTRACTS, CctpAdapter, EVM_DEPLOYMENTS } from "@mavna/adapter-cctp";
import { LayerZeroAdapter } from "@mavna/adapter-layerzero";
import type { Asset, NetworkId, Route } from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import {
  createNetworkConfig,
  PUBLIC_MAINNET_RPC_URLS,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
} from "@mavna/stellar";

const NETWORK = "testnet" as NetworkId;

// Which network, said out loud rather than defaulted. Nothing in this codebase is
// meaningful on only one, and a default would eventually be wrong in the worst
// possible direction.
// The endpoint follows the network. Pinning the testnet URL here regardless of
// NETWORK was a real bug the app also had: mainnet contract addresses against a
// node that has never heard of them reads as a chain that lost your account.
const config = createNetworkConfig({
  id: NETWORK,
  rpcUrl: NETWORK === "mainnet" ? (PUBLIC_MAINNET_RPC_URLS[0] ?? "") : PUBLIC_TESTNET_RPC_URL,
});

// The Stellar reader. It refuses answers from a node behind the highest ledger it
// has already seen, because the public endpoint is load balanced across nodes at
// different heights and will otherwise tell you an account exists, then does not.
const rpc = new RpcClient({ url: config.rpcUrl });

const cctp = new CctpAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

const axelar = new AxelarAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

const layerzero = new LayerZeroAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

const destination = process.argv[2];
const amount = process.argv[3] ?? "25";
const sourceChainId = process.argv[4] ?? "ethereum-sepolia";

if (destination === undefined) {
  console.error("Pass a Stellar address: node examples/quote.ts G... [amount] [chain]");
  process.exit(1);
}

const deployment = EVM_DEPLOYMENTS[NETWORK][sourceChainId];
if (deployment === undefined) {
  console.error(`No CCTP deployment for ${sourceChainId} on ${NETWORK}.`);
  process.exit(1);
}

// An asset is chain plus the chain's own notion of the asset, never a bare
// symbol. Anyone can issue a token called USDC.
const from: Asset = {
  chainId: sourceChainId,
  id: deployment.usdc,
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};

const to: Asset = {
  chainId: "stellar-testnet",
  id: `USDC:${CCTP_CONTRACTS[NETWORK].usdcIssuer}`,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

// Integer base units as a string, all the way through. Floating point on money is
// a defect, not a shortcut.
const baseUnits = toBaseUnits(amount, from.decimals);

// All three rails at once. A slow one costs its own route and nothing else, and
// onUpdate lets an interface render each answer as it lands instead of waiting
// for the last of them.
const routes = await raceAdapters([cctp, axelar, layerzero], {
  from,
  to,
  sends: { asset: from, baseUnits },
  destination,
  maxSlippageBps: 50,
});

// A rail that cannot carry this transfer says so, and says why. On testnet two
// of these three will decline, which is the honest picture rather than a fault.
for (const rejection of routes.rejected) {
  console.error(`${rejection.source} declined (${rejection.reason}): ${rejection.explanation}`);
}

const route = routes.routes[0];
if (route === undefined) process.exit(1);

describe(route);

// Building is separate from quoting, and it neither signs nor submits. What comes
// back is what to send; the wallet is the only thing that holds a key.
const transactions = await cctp.buildTransactions(route);
console.log(`\n${transactions.length} transactions to sign, in this order:`);
for (const tx of transactions) {
  const conditional = tx.unnecessaryWhen === undefined ? "" : "  (skippable, see unnecessaryWhen)";
  console.log(`  ${tx.format} on ${tx.chainId}: ${tx.describes}${conditional}`);
}

function describe(route: Route): void {
  console.log(`Route ${route.id} via ${route.source}`);
  console.log(`  sends     ${format(route.sends.baseUnits, route.sends.asset.decimals)} USDC`);
  // What arrives is the number a user is deciding on. It is the primary one here
  // for the same reason it is the primary one in the interface.
  console.log(
    `  receives  ${format(route.receives.baseUnits, route.receives.asset.decimals)} USDC`,
  );
  console.log(
    `  at least  ${format(route.receivesAtLeast.baseUnits, route.receivesAtLeast.asset.decimals)} USDC`,
  );
  console.log(`  takes     about ${Math.round(route.estimatedSeconds / 60)} minutes`);
  console.log(`  signatures ${route.signaturesRequired}`);
  for (const fee of route.fees) {
    console.log(
      `  fee ${fee.kind}: ${format(fee.total.baseUnits, fee.total.asset.decimals)} ${fee.total.asset.symbol}`,
    );
  }
  for (const step of route.steps) {
    console.log(`  step ${step.kind}`);
  }
}

/** Decimal string to integer base units, without going through a float. */
function toBaseUnits(value: string, decimals: number): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`.replace(/^0+(?=\d)/, "");
}

/** Integer base units back to something readable, same rule in reverse. */
function format(baseUnits: string, decimals: number): string {
  const padded = baseUnits.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  return `${padded.slice(0, cut)}.${padded.slice(cut).replace(/0+$/, "") || "0"}`;
}
