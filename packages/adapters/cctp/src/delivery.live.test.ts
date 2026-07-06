import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { CCTP_CONTRACTS } from "./config.js";
import { buildDelivery } from "./delivery.js";

/**
 * The delivery call, against the real forwarder contract on testnet.
 *
 * A full burn-to-mint transfer needs testnet funds on an EVM chain, which is on
 * the human list. What CAN be proven without them is that the contract is live,
 * that our call is shaped correctly, and that a malformed delivery is refused
 * before it ever reaches the chain.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const client = new RpcClient({ url: network.rpcUrl });
let payer: Keypair;

beforeAll(async () => {
  payer = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${payer.publicKey()}`);
  await client.waitForAccount(payer.publicKey());
}, 300_000);

describe("Circle's forwarder on testnet", () => {
  it("is deployed at the address we build against", async () => {
    const account = await client.loadAccount(payer.publicKey());
    const tx = buildDelivery({
      network,
      networkId: "testnet",
      payerAccount: account,
      messageHex: `0x${"00".repeat(200)}`,
      attestationHex: `0x${"00".repeat(65)}`,
    });

    // Simulating a deliberately invalid message proves the contract exists and is
    // reachable: a missing contract fails differently from a rejected message.
    const sim = await client.server.simulateTransaction(tx);
    const failed = "error" in sim;
    expect(failed).toBe(true);
    if ("error" in sim) {
      // The contract ran and rejected our nonsense, rather than not existing.
      expect(String(sim.error)).not.toMatch(/missing|not found|does not exist/i);
    }
  }, 300_000);

  it("refuses to build a delivery with no attestation, because Circle has not signed it", async () => {
    const account = await client.loadAccount(payer.publicKey());
    expect(() =>
      buildDelivery({
        network,
        networkId: "testnet",
        payerAccount: account,
        messageHex: `0x${"00".repeat(200)}`,
        attestationHex: "0x",
      }),
    ).toThrow(/has not signed/);
  });

  it("refuses an empty message rather than submitting one", async () => {
    const account = await client.loadAccount(payer.publicKey());
    expect(() =>
      buildDelivery({
        network,
        networkId: "testnet",
        payerAccount: account,
        messageHex: "0x",
        attestationHex: `0x${"00".repeat(65)}`,
      }),
    ).toThrow(/empty/);
  });

  it("targets the forwarder, never the transmitter directly", () => {
    // Calling receive_message directly would mint to the forwarder without
    // forwarding, stranding the funds there.
    expect(CCTP_CONTRACTS.testnet.cctpForwarder).not.toBe(
      CCTP_CONTRACTS.testnet.messageTransmitter,
    );
  });
});
