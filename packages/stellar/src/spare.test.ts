import { Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { spareStroops } from "./spare.js";

const BASE = 5_000_000;

function entry(options: {
  balance: bigint;
  subEntries: number;
  sellingLiabilities?: bigint;
  sponsoring?: number;
  sponsored?: number;
}): xdr.AccountEntry {
  const v2 =
    options.sponsoring === undefined && options.sponsored === undefined
      ? xdr.AccountEntryExtensionV1Ext.v0()
      : xdr.AccountEntryExtensionV1Ext.v2(
          new xdr.AccountEntryExtensionV2({
            numSponsored: options.sponsored ?? 0,
            numSponsoring: options.sponsoring ?? 0,
            signerSponsoringIDs: [],
            ext: xdr.AccountEntryExtensionV2Ext.v0(),
          }),
        );
  const ext =
    options.sellingLiabilities === undefined && v2.type === "v0"
      ? xdr.AccountEntryExt.v0()
      : xdr.AccountEntryExt.v1(
          new xdr.AccountEntryExtensionV1({
            liabilities: new xdr.Liabilities({
              buying: xdr.Int64.fromString("0"),
              selling: xdr.Int64.fromString((options.sellingLiabilities ?? 0n).toString()),
            }),
            ext: v2,
          }),
        );
  return new xdr.AccountEntry({
    accountId: Keypair.random().xdrAccountId(),
    balance: xdr.Int64.fromString(options.balance.toString()),
    seqNum: xdr.Int64.fromString("1"),
    numSubEntries: options.subEntries,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext,
  });
}

describe("how much XLM an account can spare for a new reserve", () => {
  it("is the balance above two base reserves plus one per subentry", () => {
    expect(spareStroops(entry({ balance: 20_000_000n, subEntries: 1 }), BASE)).toBe(5_000_000n);
  });

  it("holds back what open offers are selling", () => {
    expect(
      spareStroops(entry({ balance: 20_000_000n, subEntries: 1, sellingLiabilities: 1n }), BASE),
    ).toBe(4_999_999n);
  });

  it("counts reserves it sponsors for others, and not those others sponsor for it", () => {
    expect(spareStroops(entry({ balance: 20_000_000n, subEntries: 1, sponsoring: 1 }), BASE)).toBe(
      0n,
    );
    expect(spareStroops(entry({ balance: 20_000_000n, subEntries: 1, sponsored: 1 }), BASE)).toBe(
      10_000_000n,
    );
  });

  it("can be negative, which is still a number the caller can compare", () => {
    expect(spareStroops(entry({ balance: 10_000_000n, subEntries: 1 }), BASE)).toBe(-5_000_000n);
  });
});
