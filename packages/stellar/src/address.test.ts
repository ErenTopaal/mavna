import { MavnaError } from "@mavna/core";
import { Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assertCanReceive,
  classifyAddress,
  memoIsEncodedInAddress,
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
