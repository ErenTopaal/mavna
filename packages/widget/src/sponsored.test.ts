import { buildPreparation, buildSettlement, createNetworkConfig } from "@mavna/stellar";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { DESTINATION, routeFor, USDC_ISSUER } from "./__fixtures__/scripted";
import { preparationProblem, readSettlement } from "./sponsored";

const network = createNetworkConfig({ id: "testnet", rpcUrl: "https://example.invalid" });
const SPONSOR = Keypair.random().publicKey();
const CHANNEL = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();
const USDC = new Asset("USDC", USDC_ISSUER);
// the fixture route delivers 5 USDC (50000000 at seven decimals) and quotes 1.5 XLM of reserve
const route = routeFor("cctp", { newAccount: true });

function preparation(createAccount: boolean): string {
  return buildPreparation({
    network,
    sponsorAccount: new Account(SPONSOR, "1"),
    userAddress: DESTINATION,
    createAccount,
    assets: [USDC],
  }).toXDR();
}

function settlement(overrides: { maxSpend?: string; xlmNeeded?: string } = {}): string {
  return buildSettlement({
    network,
    channelAccount: new Account(CHANNEL, "1"),
    sponsorAddress: SPONSOR,
    userAddress: DESTINATION,
    payingAsset: USDC,
    xlmNeeded: overrides.xlmNeeded ?? "1.5",
    maxSpend: overrides.maxSpend ?? "0.6",
    assets: [USDC],
    createdAccount: true,
  }).toXDR();
}

/** A transaction sourced by `source` carrying `ops`, bounded like the sponsor's. */
function built(
  source: string,
  ops: ReturnType<typeof Operation.setOptions>[],
  seconds = 300,
): string {
  const builder = new TransactionBuilder(new Account(source, "1"), {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  return builder.setTimeout(seconds).build().toXDR();
}

describe("preparationProblem", () => {
  it("accepts what the sponsor builds, with and without creating the account", () => {
    expect(preparationProblem(preparation(true), network.passphrase, route)).toBeUndefined();
    expect(preparationProblem(preparation(false), network.passphrase, route)).toBeUndefined();
  });

  it("refuses one that also hands the account to someone else", () => {
    const hostile = built(SPONSOR, [
      Operation.beginSponsoringFutureReserves({ sponsoredId: DESTINATION }),
      Operation.createAccount({ destination: DESTINATION, startingBalance: "0" }),
      Operation.changeTrust({ asset: USDC, source: DESTINATION }),
      Operation.endSponsoringFutureReserves({ source: DESTINATION }),
      Operation.setOptions({
        source: DESTINATION,
        signer: { ed25519PublicKey: ATTACKER, weight: 1 },
        masterWeight: 0,
      }),
    ]);
    expect(preparationProblem(hostile, network.passphrase, route)).toBe(
      "it does more than open the account",
    );
  });

  it("refuses a trustline to another issuer's USDC", () => {
    const hostile = built(SPONSOR, [
      Operation.beginSponsoringFutureReserves({ sponsoredId: DESTINATION }),
      Operation.changeTrust({ asset: new Asset("USDC", ATTACKER), source: DESTINATION }),
      Operation.endSponsoringFutureReserves({ source: DESTINATION }),
    ]);
    expect(preparationProblem(hostile, network.passphrase, route)).toMatch(/USDC trustline/);
  });

  it("refuses one the receiving account would pay for", () => {
    const hostile = built(DESTINATION, [
      Operation.beginSponsoringFutureReserves({ sponsoredId: DESTINATION, source: SPONSOR }),
      Operation.changeTrust({ asset: USDC, source: DESTINATION }),
      Operation.endSponsoringFutureReserves({ source: DESTINATION }),
    ]);
    expect(preparationProblem(hostile, network.passphrase, route)).toMatch(/paid for/);
  });

  it("refuses something unreadable", () => {
    expect(preparationProblem("PREPARATION", network.passphrase, route)).toBe(
      "it could not be read",
    );
  });
});

describe("readSettlement", () => {
  it("reads what the sponsor builds and says what it may spend", () => {
    expect(readSettlement(settlement(), network.passphrase, route, CHANNEL)).toEqual({
      sendMax: 6_000_000n,
    });
  });

  it("refuses a repayment paid to someone other than the receiving account", () => {
    const hostile = built(
      CHANNEL,
      [
        Operation.pathPaymentStrictReceive({
          source: DESTINATION,
          sendAsset: USDC,
          sendMax: "0.6",
          destination: ATTACKER,
          destAsset: Asset.native(),
          destAmount: "1.5",
          path: [],
        }),
      ],
      86_400,
    );
    expect(readSettlement(hostile, network.passphrase, route, CHANNEL)).toEqual({
      problem: "its repayment is not the receiving account buying back its own reserve",
    });
  });

  it("refuses one that may spend the whole arrival", () => {
    expect(
      readSettlement(settlement({ maxSpend: "5" }), network.passphrase, route, CHANNEL),
    ).toEqual({ problem: "it may spend as much USDC as the whole transfer brings in" });
  });

  it("refuses one that buys back more than the quoted reserve", () => {
    expect(
      readSettlement(settlement({ xlmNeeded: "2" }), network.passphrase, route, CHANNEL),
    ).toEqual({ problem: "it buys back more XLM than the reserve this route quoted" });
  });

  it("refuses one with an extra payment out of the receiving account", () => {
    const hostile = built(
      CHANNEL,
      [
        Operation.pathPaymentStrictReceive({
          source: DESTINATION,
          sendAsset: USDC,
          sendMax: "0.6",
          destination: DESTINATION,
          destAsset: Asset.native(),
          destAmount: "1.5",
          path: [],
        }),
        Operation.payment({ source: DESTINATION, destination: ATTACKER, asset: USDC, amount: "4" }),
      ],
      86_400,
    );
    expect(readSettlement(hostile, network.passphrase, route, CHANNEL)).toEqual({
      problem: "it asks the receiving account for more than the repayment",
    });
  });

  it("refuses one not built on the channel the sponsor named", () => {
    expect(readSettlement(settlement(), network.passphrase, route, SPONSOR)).toEqual({
      problem: "it is not built on the sponsor's own channel",
    });
  });
});
