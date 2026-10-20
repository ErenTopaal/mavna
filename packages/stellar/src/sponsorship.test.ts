import { MavnaError } from "@mavna/core";
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createNetworkConfig } from "./network.js";
import { buildPreparation, buildSettlement, buildSettlementLadder } from "./sponsorship.js";

const network = createNetworkConfig({ id: "testnet", rpcUrl: "https://rpc.invalid" });
const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const eurc = new Asset("EURC", "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO");
const sponsor = Keypair.random().publicKey();
const user = Keypair.random().publicKey();

const shape = (ops: Transaction["operations"]) =>
  ops.map((op) => ({ type: op.type, source: op.source }));

describe("buildPreparation", () => {
  it("sponsors a new account and its trustline, with the user signing their own operations", () => {
    const tx = buildPreparation({
      network,
      sponsorAccount: new Account(sponsor, "10"),
      userAddress: user,
      createAccount: true,
      assets: [usdc],
    });
    expect(tx.source).toBe(sponsor);
    expect(tx.sequence).toBe("11");
    expect(shape(tx.operations)).toEqual([
      { type: "beginSponsoringFutureReserves", source: undefined },
      { type: "createAccount", source: undefined },
      { type: "changeTrust", source: user },
      { type: "endSponsoringFutureReserves", source: user },
    ]);
    const create = tx.operations[1] as Operation.CreateAccount;
    expect(create.destination).toBe(user);
    expect(create.startingBalance).toBe("0.0000000");
    const begin = tx.operations[0] as Operation.BeginSponsoringFutureReserves;
    expect(begin.sponsoredId).toBe(user);
  });

  it("opens two trustlines for an account that exists, without creating it", () => {
    const tx = buildPreparation({
      network,
      sponsorAccount: new Account(sponsor, "10"),
      userAddress: user,
      createAccount: false,
      assets: [usdc, eurc],
    });
    expect(tx.operations.map((op) => op.type)).toEqual([
      "beginSponsoringFutureReserves",
      "changeTrust",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
  });

  it("prepares the account under a muxed address", () => {
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ";
    const tx = buildPreparation({
      network,
      sponsorAccount: new Account(sponsor, "10"),
      userAddress: muxed,
      createAccount: false,
      assets: [usdc],
    });
    const underlying = MuxedAccount.fromAddress(muxed, "0").baseAccount().accountId();
    expect(tx.operations[1]?.source).toBe(underlying);
    expect((tx.operations[0] as Operation.BeginSponsoringFutureReserves).sponsoredId).toBe(
      underlying,
    );
  });

  it("refuses no asset, a third asset, and a contract", () => {
    const base = {
      network,
      sponsorAccount: new Account(sponsor, "10"),
      userAddress: user,
      createAccount: false,
    };
    expect(() => buildPreparation({ ...base, assets: [] })).toThrow(MavnaError);
    expect(() => buildPreparation({ ...base, assets: [usdc, eurc, Asset.native()] })).toThrow(
      /limit is 2/,
    );
    expect(() =>
      buildPreparation({
        ...base,
        userAddress: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
        assets: [usdc],
      }),
    ).toThrow(/needs no preparation/);
  });
});

describe("buildSettlement", () => {
  const inputs = {
    network,
    channelAccount: new Account(Keypair.random().publicKey(), "100"),
    sponsorAddress: sponsor,
    userAddress: user,
    payingAsset: usdc,
    xlmNeeded: "1.5",
    maxSpend: "2",
    assets: [usdc],
    createdAccount: true,
  };

  it("buys exactly the XLM needed from the user's own balance, then hands the reserves back", () => {
    const tx = buildSettlement(inputs);
    expect(shape(tx.operations)).toEqual([
      { type: "pathPaymentStrictReceive", source: user },
      { type: "revokeTrustlineSponsorship", source: sponsor },
      { type: "revokeAccountSponsorship", source: sponsor },
    ]);
    const pay = tx.operations[0] as Operation.PathPaymentStrictReceive;
    expect(pay.destination).toBe(user);
    expect(pay.destAsset.isNative()).toBe(true);
    expect(pay.destAmount).toBe("1.5000000");
    expect(pay.sendMax).toBe("2.0000000");
    expect(pay.sendAsset.equals(usdc)).toBe(true);
  });

  it("lives a day unless told otherwise", () => {
    const tx = buildSettlement(inputs);
    const bounds = tx.timeBounds;
    expect(Number(bounds?.maxTime) - Math.floor(Date.now() / 1000)).toBeGreaterThan(86_300);
    const short = buildSettlement({ ...inputs, validForSeconds: 600 });
    expect(Number(short.timeBounds?.maxTime) - Math.floor(Date.now() / 1000)).toBeLessThan(700);
  });

  it("leaves the account sponsored when it was not created here", () => {
    const tx = buildSettlement({ ...inputs, createdAccount: false });
    expect(tx.operations.map((op) => op.type)).toEqual([
      "pathPaymentStrictReceive",
      "revokeTrustlineSponsorship",
    ]);
  });

  it("refuses to settle nothing", () => {
    expect(() => buildSettlement({ ...inputs, assets: [] })).toThrow(MavnaError);
  });
});

describe("buildSettlementLadder", () => {
  it("targets consecutive sequences from the channel's next one", () => {
    const rungs = buildSettlementLadder(
      {
        network,
        channelAccount: new Account(Keypair.random().publicKey(), "100"),
        sponsorAddress: sponsor,
        userAddress: user,
        payingAsset: usdc,
        xlmNeeded: "1.5",
        maxSpend: "2",
        assets: [usdc],
        createdAccount: true,
      },
      3,
    );
    expect(rungs.map((tx) => tx.sequence)).toEqual(["101", "102", "103"]);
  });

  it("needs at least one rung", () => {
    expect(() =>
      buildSettlementLadder(
        {
          network,
          channelAccount: new Account(Keypair.random().publicKey(), "100"),
          sponsorAddress: sponsor,
          userAddress: user,
          payingAsset: usdc,
          xlmNeeded: "1",
          maxSpend: "1",
          assets: [usdc],
          createdAccount: false,
        },
        0,
      ),
    ).toThrow(MavnaError);
  });
});
