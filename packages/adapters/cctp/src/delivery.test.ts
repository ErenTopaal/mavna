import { fileURLToPath } from "node:url";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { Account } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { hideBufferFrom } from "./__fixtures__/no-buffer.js";
import {
  buildDelivery,
  canonicalToLocal,
  deliveryFailureOf,
  localToCanonical,
} from "./delivery.js";

const PAYER = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";

/**
 * The decimal boundary.
 *
 * CCTP message amounts are always six decimals; Stellar's USDC is seven. This is
 * the exact place where someone reaches for a float and loses a user's money in
 * the seventh decimal.
 */

describe("canonical to local", () => {
  it("scales six decimals up to seven", () => {
    // 1 USDC: 1_000_000 canonical becomes 10_000_000 local.
    expect(canonicalToLocal("1000000")).toBe("10000000");
    expect(canonicalToLocal("0")).toBe("0");
  });

  it("stays exact far beyond what a double can represent", () => {
    const huge = "9007199254740993";
    // A float would round this. Integer arithmetic does not.
    expect(canonicalToLocal(huge)).toBe("90071992547409930");
  });

  it("refuses anything that is not integer base units", () => {
    for (const bad of ["1.5", "-1", "1e6", "", "0x10"]) {
      expect(() => canonicalToLocal(bad)).toThrow();
    }
  });
});

describe("local to canonical", () => {
  it("scales seven decimals down and reports the dust", () => {
    expect(localToCanonical("10000000")).toEqual({ canonical: "1000000", dust: "0" });
  });

  it("does not silently discard the seventh decimal", () => {
    // The dust stays with the sender. Reporting it is what stops it becoming a
    // rounding error nobody can account for.
    expect(localToCanonical("10000007")).toEqual({ canonical: "1000000", dust: "7" });
    expect(localToCanonical("9")).toEqual({ canonical: "0", dust: "9" });
  });

  it("round trips exactly when there is no dust", () => {
    for (const canonical of ["1", "1000000", "123456789"]) {
      expect(localToCanonical(canonicalToLocal(canonical)).canonical).toBe(canonical);
      expect(localToCanonical(canonicalToLocal(canonical)).dust).toBe("0");
    }
  });

  it("never loses value: canonical times ten plus dust equals the original", () => {
    for (const local of ["1", "7", "10000007", "99999999999"]) {
      const { canonical, dust } = localToCanonical(local);
      expect(BigInt(canonical) * 10n + BigInt(dust)).toBe(BigInt(local));
    }
  });
});

describe("what a failed delivery means", () => {
  it("reads a recipient with no USDC trustline as not ready, not failed", () => {
    expect(deliveryFailureOf("HostError: Error(Contract, #13)")).toBe("recipient-not-ready");
    expect(deliveryFailureOf("trustline entry is missing for account")).toBe("recipient-not-ready");
  });

  it("reads a used nonce as a delivery that already landed", () => {
    expect(deliveryFailureOf("HostError: Error(Contract, #6908)")).toBe("already-delivered");
    expect(deliveryFailureOf("nonce already used")).toBe("already-delivered");
  });

  it("names nothing else", () => {
    expect(deliveryFailureOf("txInsufficientBalance")).toBeUndefined();
    expect(deliveryFailureOf("Error(Contract, #69080)")).toBeUndefined();
  });
});

describe("the delivery without Node's Buffer, as in a browser", () => {
  it("builds the same mint_and_forward call", () => {
    const inputs = () => ({
      network: createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL }),
      networkId: "testnet" as const,
      payerAccount: new Account(PAYER, "41"),
      messageHex: "0x00000001deadbeef",
      attestationHex: "0xcafe01",
    });
    // the operation, not the envelope: the envelope's time bounds follow the clock
    const call = (tx: ReturnType<typeof buildDelivery>) =>
      tx.toEnvelope().v1().tx().operations()[0]?.toXDR("base64");
    const withNode = call(buildDelivery(inputs()));
    const restore = hideBufferFrom(fileURLToPath(new URL(".", import.meta.url)));
    try {
      expect(call(buildDelivery(inputs()))).toBe(withNode);
    } finally {
      restore();
    }
  });
});
