import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { Deliverer } from "./deliver.js";

/**
 * The delivery worker's judgement, not its plumbing.
 *
 * The thing worth testing here is which failures it treats as "wait" and which
 * as "this went wrong", because collapsing those two is how a user who needs a
 * trustline gets told their transfer failed, and a user told that retries.
 */

const network = {
  passphrase: "Test SDF Network ; September 2015",
} as unknown as NetworkConfig;

const payer = Keypair.random().secret();

function delivererThatFailsWith(message: string): Deliverer {
  return new Deliverer({
    network,
    networkId: "testnet",
    payerSecret: payer,
    rpc: {
      loadAccount: () => Promise.resolve({} as never),
      prepare: () => Promise.reject(new Error(message)),
    } as unknown as RpcClient,
    buildDelivery: () => ({}) as never,
  });
}

describe("what a failed delivery actually means", () => {
  it("reads a missing trustline as not ready, never as failed", async () => {
    // Circle's contract reverts the whole invocation and rolls back its own
    // replay record with it, so the message is still deliverable. Reporting this
    // as a failure would send someone chasing money that is not lost.
    const outcome = await delivererThatFailsWith(
      "HostError: Error(Contract, #13) trustline entry is missing for account",
    ).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" });

    expect(outcome.kind).toBe("recipient-not-ready");
  });

  it("reads a spent nonce as already delivered, which is a success", async () => {
    // The number Circle's transmitter actually raises, from its own source.
    const outcome = await delivererThatFailsWith("HostError: Error(Contract, #6908)").deliver({
      messageHex: "0xabcd",
      attestationHex: "0x1234",
    });

    expect(outcome.kind).toBe("already-delivered");
  });

  it("refuses to raise an unrecognised failure as an outcome", async () => {
    // Anything not understood has to surface, because a delivery that quietly
    // reports a tidy state it did not reach is worse than one that throws.
    await expect(
      delivererThatFailsWith("the node is on fire").deliver({
        messageHex: "0xabcd",
        attestationHex: "0x1234",
      }),
    ).rejects.toThrow(MavnaError);
  });
});

describe("before anything is signed", () => {
  it("says an unattested burn is not ready rather than building a transaction", async () => {
    // Circle writes the literal string PENDING until it has signed. Passing that
    // through as an attestation would produce a transaction that cannot succeed.
    const deliverer = new Deliverer({
      network,
      networkId: "testnet",
      payerSecret: payer,
      rpc: {
        loadAccount: () => Promise.reject(new Error("should not have been reached")),
      } as unknown as RpcClient,
      buildDelivery: () => {
        throw new Error("should not have been reached");
      },
    });

    expect(
      (await deliverer.deliver({ messageHex: "0xabcd", attestationHex: "PENDING" })).kind,
    ).toBe("not-attested-yet");
  });

  it("rejects a key that is not a key, at construction rather than mid-transfer", () => {
    // Discovering this when someone's funds are already burned and waiting is
    // the worst possible moment for a configuration mistake to surface.
    expect(
      () =>
        new Deliverer({
          network,
          networkId: "testnet",
          payerSecret: "not-a-secret-key",
          rpc: {} as unknown as RpcClient,
          buildDelivery: () => ({}) as never,
        }),
    ).toThrow();
  });

  it("exposes the paying address and never the secret", () => {
    const deliverer = new Deliverer({
      network,
      networkId: "testnet",
      payerSecret: payer,
      rpc: {} as unknown as RpcClient,
      buildDelivery: () => ({}) as never,
    });

    expect(deliverer.payerAddress).toBe(Keypair.fromSecret(payer).publicKey());
    expect(JSON.stringify(deliverer)).not.toContain(payer);
  });
});
