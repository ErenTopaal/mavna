import { describe, expect, it } from "vitest";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { buildForwarderHookData, contractAddressToBytes32 } from "./hook.js";
import {
  buildStarknetBurn,
  byteArrayCalldata,
  STARKNET_DEPLOYMENTS,
  starknetSelector,
} from "./starknet.js";

/**
 * MERGE PREREQUISITE, same standing as the EVM and Solana burns.
 *
 * `scripts/verify-cctp-starknet.mjs` covers the half that only the chain can
 * answer: that the selector is one of the class's entry points and that the
 * argument list still matches. These cover the encoding.
 */

const RECIPIENT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";

const base = {
  amount: 25_000_000n,
  stellarRecipient: RECIPIENT,
  network: "testnet" as const,
  maxFee: 0n,
  finality: undefined,
};

const toBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

describe("the Starknet burn", () => {
  it("approves the messenger before burning, since Starknet has no allowance-free transfer", () => {
    const { calls } = buildStarknetBurn(base);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.entrypoint).toBe("approve");
    expect(calls[0]?.contractAddress).toBe(STARKNET_DEPLOYMENTS.testnet.usdc);
    expect(calls[0]?.calldata[0]).toBe(STARKNET_DEPLOYMENTS.testnet.tokenMessengerMinterV2);
    expect(calls[1]?.entrypoint).toBe("deposit_for_burn_with_hook");
  });

  it("points mint_recipient at Circle's forwarder, NOT at the user", () => {
    const { calls } = buildStarknetBurn(base);
    const forwarder = toBigInt(contractAddressToBytes32(CCTP_CONTRACTS.testnet.cctpForwarder));
    // amount is two felts, then the domain, then the recipient as two more.
    const [low, high] = [calls[1]?.calldata[3], calls[1]?.calldata[4]];
    expect((BigInt(high ?? "0") << 128n) | BigInt(low ?? "0")).toBe(forwarder);
  });

  it("sets destination_caller to the same forwarder, never zero", () => {
    const data = buildStarknetBurn(base).calls[1]?.calldata ?? [];
    // recipient at 3..4, burn token at 5, caller at 6..7.
    expect(data[6]).toBe(data[3]);
    expect(data[7]).toBe(data[4]);
    expect(BigInt(data[6] ?? "0")).not.toBe(0n);
  });

  it("burns the chain's own USDC, not another chain's", () => {
    const testnet = buildStarknetBurn(base).calls[1]?.calldata[5];
    const mainnet = buildStarknetBurn({ ...base, network: "mainnet" }).calls[1]?.calldata[5];
    expect(testnet).toBe(STARKNET_DEPLOYMENTS.testnet.usdc);
    expect(mainnet).toBe(STARKNET_DEPLOYMENTS.mainnet.usdc);
    expect(testnet).not.toBe(mainnet);
  });

  it("sends to Stellar's domain, which is not a chain id", () => {
    expect(buildStarknetBurn(base).calls[1]?.calldata[2]).toBe(String(STELLAR_DOMAIN));
  });

  it("splits a u256 low word first, as Cairo expects", () => {
    const big = { ...base, amount: (1n << 130n) + 7n, maxFee: 0n };
    const data = buildStarknetBurn(big).calls[1]?.calldata ?? [];
    expect(BigInt(data[0] ?? "0")).toBe(7n);
    expect(BigInt(data[1] ?? "0")).toBe(1n << 2n);
  });

  it("computes a selector inside Starknet's 250-bit field", () => {
    const selector = BigInt(starknetSelector("deposit_for_burn_with_hook"));
    expect(selector).toBeLessThan(1n << 250n);
    // Verified against the class's own external entry points by the script.
    expect(starknetSelector("deposit_for_burn_with_hook")).toBe(
      "0x2efef47f51f24e0b8300b04b9e37c435a2a16ba9cba8b4e04b16d21b77e0395",
    );
  });
});

/**
 * Cairo's ByteArray is full 31-byte words, then one partial word with its own
 * length. Getting the split wrong does not fail to encode: it produces hook data
 * that decodes to something else on the far side, which is where the recipient is.
 */
describe("byteArrayCalldata", () => {
  it("encodes an empty array as no words and nothing pending", () => {
    expect(byteArrayCalldata(new Uint8Array())).toEqual(["0", "0x0", "0"]);
  });

  it("keeps a short run entirely in the pending word", () => {
    const [count, , pendingLength] = byteArrayCalldata(Uint8Array.from([1, 2, 3]));
    expect(count).toBe("0");
    expect(pendingLength).toBe("3");
  });

  it("splits at exactly thirty-one bytes", () => {
    const [count, , pending, pendingLength] = byteArrayCalldata(new Uint8Array(31).fill(0xab));
    expect(count).toBe("1");
    expect(pending).toBe("0x0");
    expect(pendingLength).toBe("0");
  });

  it("carries the real hook data, recipient and all", () => {
    const hook = buildForwarderHookData(RECIPIENT);
    const encoded = byteArrayCalldata(hook);
    const words = Number(encoded[0]);
    const pendingLength = Number(encoded[encoded.length - 1]);
    // Every byte accounted for: nothing silently truncated.
    expect(words * 31 + pendingLength).toBe(hook.length);
    expect(encoded).toHaveLength(1 + words + 2);
  });
});
