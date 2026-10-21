import { MavnaError } from "@mavna/core";
import { Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assertCanReceive,
  classifyAddress,
  memoIsEncodedInAddress,
  recipientRefusal,
  underlyingAccountOfMuxed,
} from "./address.js";

const account = Keypair.random().publicKey();
const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
const muxed = new MuxedAccount(
  // MuxedAccount needs an Account-shaped object; only the id is read for the M-form.
  {
    accountId: () => account,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as never,
  "1234",
).accountId();

describe("classifyAddress", () => {
  it("identifies an ordinary account as needing a trustline", () => {
    const result = classifyAddress(account);
    expect(result.kind).toBe("account");
    expect(result.canReceive).toBe(true);
    expect(result.needsTrustline).toBe(true);
    expect(result.trustlineHolder).toBe(account);
  });

  it("identifies a contract as needing no trustline at all", () => {
    // Verified on-chain: a contract holds classic assets in contract storage, so
    // it needs neither an account entry nor a trustline nor any reserve.
    const result = classifyAddress(contract);
    expect(result.kind).toBe("contract");
    expect(result.canReceive).toBe(true);
    expect(result.needsTrustline).toBe(false);
    expect(result.trustlineHolder).toBeUndefined();
  });

  it("points a muxed address at the account underneath it", () => {
    const result = classifyAddress(muxed);
    expect(result.kind).toBe("muxed");
    expect(result.canReceive).toBe(true);
    expect(result.trustlineHolder).toBe(account);
  });

  it("refuses a secret key rather than classifying it", () => {
    const secret = Keypair.random().secret();
    expect(() => classifyAddress(secret)).toThrow(MavnaError);
    expect(() => classifyAddress(secret)).toThrow(/secret key/i);
  });

  it("rejects nonsense instead of guessing", () => {
    for (const bad of ["", "hello", "G", `${account}X`, account.toLowerCase()]) {
      expect(() => classifyAddress(bad)).toThrow(MavnaError);
    }
  });

  it("does not leak the full address into an error message", () => {
    try {
      classifyAddress("GNOTAREALADDRESSBUTLONGENOUGHTOTRUNCATE");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("...");
    }
  });
});

describe("assertCanReceive", () => {
  it("passes through addresses that can receive", () => {
    expect(assertCanReceive(account).kind).toBe("account");
    expect(assertCanReceive(contract).kind).toBe("contract");
  });
});

describe("underlyingAccountOfMuxed", () => {
  it("recovers the wrapped account", () => {
    expect(underlyingAccountOfMuxed(muxed)).toBe(account);
  });

  it("refuses a non-muxed address", () => {
    expect(() => underlyingAccountOfMuxed(account)).toThrow(MavnaError);
  });
});

describe("memoIsEncodedInAddress", () => {
  it("is true only for muxed addresses", () => {
    expect(memoIsEncodedInAddress(muxed)).toBe(true);
    expect(memoIsEncodedInAddress(account)).toBe(false);
    expect(memoIsEncodedInAddress(contract)).toBe(false);
  });
});

describe("recipientRefusal", () => {
  it("has nothing to say about an address value can be sent to", () => {
    for (const address of [account, contract, muxed]) {
      expect(recipientRefusal(address)).toBeUndefined();
    }
  });

  it("says no recipient was given, not that one is bad, when there is none", () => {
    for (const address of ["", "   "]) {
      expect(recipientRefusal(address)).toBe(
        "No recipient was given. Enter the Stellar address that should receive this.",
      );
    }
  });

  it("says what is wrong with an address that is not one, without echoing it", () => {
    const typed = "GABC123NOTANADDRESS";
    const said = recipientRefusal(typed);
    expect(said).toBe("That is not a Stellar address. Check that it was copied in full.");
    expect(said).not.toContain("GABC");
  });

  it("names a secret key for what it is, and never repeats it", () => {
    const secret = Keypair.random().secret();
    const said = recipientRefusal(secret);
    expect(said).toBe(
      "That is a secret key, not an address. Keep it private, and enter the address that " +
        "should receive this instead.",
    );
  });

  it("names the kind of an address that exists but cannot be paid", () => {
    expect(recipientRefusal(StrKey.encodeLiquidityPool(Buffer.alloc(32, 3)))).toBe(
      "A liquidity-pool address cannot receive a payment.",
    );
    expect(recipientRefusal(StrKey.encodeClaimableBalance(Buffer.alloc(33, 0)))).toBe(
      "A claimable-balance address cannot receive a payment.",
    );
  });
});
