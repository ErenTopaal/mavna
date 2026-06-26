import { Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectDestination } from "./destination.js";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL } from "./network.js";
import { RpcClient } from "./rpc.js";

/**
 * Hits live Stellar testnet. Never a required check on a pull request: a testnet
 * outage is not evidence that someone's change is wrong.
 *
 * Fixtures are bootstrapped per run rather than pre-funded, because the testnet
 * is wiped 2 to 4 times a year and nothing may depend on state surviving.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

// Any live contract serves; this one is Circle's CCTP forwarder on testnet.
const A_LIVE_CONTRACT = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";

const client = new RpcClient({ url: network.rpcUrl });

async function fundedAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!response.ok && response.status !== 400) {
    throw new Error(`friendbot refused: ${response.status}`);
  }
  // The endpoint lags, so go through the guarded loader rather than the raw SDK
  // call, which throws the moment one node has not caught up.
  await client.loadAccount(kp.publicKey());
  return kp;
}

let noTrustline: Keypair;
let withTrustline: Keypair;

beforeAll(async () => {
  noTrustline = await fundedAccount();
  withTrustline = await fundedAccount();

  // Rebuilt on each attempt: a stale sequence number must be rebuilt, not resent.
  await client.submit("fixture trustline", async () => {
    const source = await client.loadAccount(withTrustline.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: "1000000",
      networkPassphrase: network.passphrase,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(300)
      .build();
    tx.sign(withTrustline);
    return tx;
  });
}, 300_000);

describe("inspectDestination against live testnet", () => {
  it("a contract needs nothing at all", async () => {
    const state = await inspectDestination(client, A_LIVE_CONTRACT, usdc);
    expect(state.lane.kind).toBe("contract-ready");
    expect(state.lane.slotsNeeded).toBe(0);
  });

  it("an address that has never existed needs an account and a trustline", async () => {
    const state = await inspectDestination(client, Keypair.random().publicKey(), usdc);
    expect(state.lane.kind).toBe("needs-account");
    expect(state.lane.slotsNeeded).toBe(3);
    expect(state.account).toBeUndefined();
  });

  it("a funded account with no trustline needs only the trustline", async () => {
    const state = await inspectDestination(client, noTrustline.publicKey(), usdc);
    expect(state.lane.kind).toBe("needs-trustline");
    expect(state.lane.slotsNeeded).toBe(1);
    expect(state.account).toBeDefined();
    expect(state.trustline).toBeUndefined();
  });

  it("an account holding the asset is ready", async () => {
    const state = await inspectDestination(client, withTrustline.publicKey(), usdc);
    expect(state.lane.kind).toBe("ready");
    expect(state.lane.slotsNeeded).toBe(0);
    expect(state.trustline).toBeDefined();
    // Testnet USDC does not set AUTH_REQUIRED, so a self-opened trustline is
    // usable immediately with no authorisation step from the issuer.
    expect(state.trustline?.authorized).toBe(true);
  });

  it("refuses an address that cannot receive", async () => {
    const state = await inspectDestination(client, Keypair.random().publicKey(), usdc);
    expect(state.lane.kind).not.toBe("unusable");
  });
});
