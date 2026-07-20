import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildBurn, FINALITY } from "./burn.js";
import { CCTP_CONTRACTS } from "./config.js";
import { contractAddressToBytes32, toHex } from "./hook.js";

/**
 * MERGE PREREQUISITE, same standing as the hook encoder.
 *
 * These assert the two fields Circle warns about twice, in red, on separate pages.
 */

const recipient = Keypair.random().publicKey();
const base = {
  amount: 1_000_000n,
  stellarRecipient: recipient,
  network: "testnet" as const,
  sourceChainId: "ethereum-sepolia",
  maxFee: 0n,
};

describe("the two fields that strand funds if wrong", () => {
  it("points mintRecipient at Circle's forwarder, NOT at the user", () => {
    const call = buildBurn(base);
    const expected = toHex(contractAddressToBytes32(CCTP_CONTRACTS.testnet.cctpForwarder));
    // Naming the user here means the funds arrive somewhere nothing can move them
    // from. Circle: "funds become permanently stuck and cannot be recovered."
    expect(call.args[2]).toBe(expected);
  });

  it("sets destinationCaller to the same forwarder, never zero", () => {
    const call = buildBurn(base);
    // Leaving it zero lets anyone call receive_message directly, minting to the
    // forwarder without forwarding, stranding the funds inside the contract.
    expect(call.args[4]).toBe(call.args[2]);
    expect(call.args[4]).not.toBe(`0x${"00".repeat(32)}`);
  });

  it("carries the real recipient in the hook data instead", () => {
    const call = buildBurn(base);
    const hook = call.args[7];
    // The recipient travels as UTF-8 text of the strkey, at offset 32.
    const hex = hook.slice(2);
    const carried = Buffer.from(hex.slice(64), "hex").toString("utf8");
    expect(carried).toBe(recipient);
  });

  it("sends to Stellar's domain, which is not a chain id", () => {
    expect(buildBurn(base).args[1]).toBe(27);
  });

  it("burns on the chain it was told to, using that chain's own USDC", () => {
    const sepolia = buildBurn(base);
    const base_ = buildBurn({ ...base, sourceChainId: "base-sepolia" });
    // Same messenger address across EVM chains, different token. Reusing one
    // chain's USDC address on another burns a token that is not USDC there.
    expect(base_.contract).toBe(sepolia.contract);
    expect(base_.args[3]).not.toBe(sepolia.args[3]);
  });

  it("refuses a chain with no verified deployment rather than guessing one", () => {
    // Every address in the registry was derived from the chain itself. Inventing
    // one for a chain that was never verified is precisely how funds become
    // permanently unrecoverable, so this is a hard stop.
    expect(() => buildBurn({ ...base, sourceChainId: "solana-devnet" })).toThrow(
      /No verified CCTP deployment/,
    );
  });
});

describe("refusals", () => {
  it("refuses a recipient that is not a Stellar address", () => {
    expect(() => buildBurn({ ...base, stellarRecipient: "0xdeadbeef" })).toThrow();
  });

  it("refuses a non-positive amount", () => {
    expect(() => buildBurn({ ...base, amount: 0n })).toThrow(/non-positive/);
  });

  it("refuses a fee ceiling that would swallow the transfer", () => {
    expect(() => buildBurn({ ...base, maxFee: 1_000_000n })).toThrow(/smaller than the amount/);
  });

  it("refuses a finality value Circle would silently coerce", () => {
    // Circle treats anything below 1000 as 1000 and anything above as 2000.
    // Accepting 1500 and pretending it means something would mislead the caller.
    expect(() => buildBurn({ ...base, finality: 1500 })).toThrow(/coerced/);
  });
});

describe("defaults", () => {
  it("defaults to the standard path, which is free from every chain into Stellar", () => {
    expect(buildBurn(base).args[6]).toBe(FINALITY.standard);
  });

  it("describes what it will do in terms a person could consent to", () => {
    expect(buildBurn(base).describes).toContain(recipient);
    expect(buildBurn(base).describes).toContain("Stellar");
  });
});
