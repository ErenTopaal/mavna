import {
  Asset,
  Keypair,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL } from "./network.js";
import { RpcClient } from "./rpc.js";
import { buildPreparation, buildSettlement } from "./sponsorship.js";

/**
 * The failure paths, exercised rather than assumed.
 *
 * Every one of these costs Mavna and never the user. That asymmetry is deliberate
 * and these tests are what stop it silently regressing.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const client = new RpcClient({ url: network.rpcUrl });
const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

const sponsor = Keypair.random();
const channel = Keypair.random();

async function friendbot(kp: Keypair): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!response.ok && response.status !== 400) throw new Error(`friendbot ${response.status}`);
  await client.waitForAccount(kp.publicKey());
}

async function horizon(address: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  if (!response.ok) throw new Error(`horizon ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Send a transaction expected to fail and say how the protocol refused it: the
 * transaction result code and each operation's own code. Anything else, a
 * network error or a transaction that landed, fails the test instead of passing
 * as a refusal.
 */
async function refusal(tx: Transaction): Promise<{ tx: string; ops: string[] }> {
  const codes = (result: xdr.TransactionResult) => ({
    tx: result.result().switch().name,
    ops: (result.result().results() ?? []).map((op) => op.tr().value().switch().name),
  });
  const sent = await client.server.sendTransaction(tx);
  if (sent.status === "ERROR" && sent.errorResult !== undefined) return codes(sent.errorResult);
  if (sent.status !== "PENDING") throw new Error(`send answered ${sent.status}`);
  const found = await client.waitForTransaction(sent.hash, Number(tx.timeBounds?.maxTime));
  if (found.status !== rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`expected a refusal, got ${found.status}`);
  }
  return codes(found.resultXdr);
}

async function prepare(user: Keypair): Promise<void> {
  await client.submit("preparation", async () => {
    const sponsorAccount = await client.loadAccount(sponsor.publicKey());
    const built = buildPreparation({
      network,
      sponsorAccount,
      userAddress: user.publicKey(),
      createAccount: true,
      assets: [usdc],
    });
    built.sign(sponsor, user);
    return built;
  });
}

beforeAll(async () => {
  await Promise.all([friendbot(sponsor), friendbot(channel)]);
}, 600_000);

describe("failure paths", () => {
  it("a stranded account cannot be reclaimed by any route, and the loss is permanent", async () => {
    // The bridge failed after we committed capital. The user holds nothing and has
    // no reason to cooperate. This is the one permanent loss in the design and it
    // is accepted as a cost of doing business, so the code must not pretend
    // otherwise by silently retrying forever.
    const stranded = Keypair.random();
    await prepare(stranded);

    const before = await horizon(sponsor.publicKey());
    expect(Number(before.num_sponsoring)).toBeGreaterThanOrEqual(3);

    const revoke = async (op: xdr.Operation): Promise<Transaction> => {
      const source = await client.loadAccount(sponsor.publicKey());
      const built = new TransactionBuilder(source, {
        fee: "1000000",
        networkPassphrase: network.passphrase,
      })
        .addOperation(op)
        .setTimeout(300)
        .build();
      built.sign(sponsor);
      return built;
    };

    // Route 1: hand back the trustline. Needs the user to absorb the reserve,
    // and they hold nothing to absorb it with.
    expect(
      await refusal(
        await revoke(
          Operation.revokeTrustlineSponsorship({ account: stranded.publicKey(), asset: usdc }),
        ),
      ),
    ).toEqual({ tx: "txFailed", ops: ["revokeSponsorshipLowReserve"] });

    // Route 2: hand back the account itself. Same obstacle.
    expect(
      await refusal(
        await revoke(Operation.revokeAccountSponsorship({ account: stranded.publicKey() })),
      ),
    ).toEqual({ tx: "txFailed", ops: ["revokeSponsorshipLowReserve"] });

    // The capital is still carried, and always will be.
    const after = await horizon(sponsor.publicKey());
    expect(Number(after.num_sponsoring)).toBeGreaterThanOrEqual(3);
  }, 900_000);

  it("a settlement against a swept balance fails harmlessly, leaving the user's funds alone", async () => {
    // The front-run: the user takes the arriving value before our settlement lands.
    // We lose the reserve. They keep their money. Nothing is half-done.
    const user = Keypair.random();
    await prepare(user);

    const channelAccount = await client.loadAccount(channel.publicKey());
    const settlement = buildSettlement({
      network,
      channelAccount,
      sponsorAddress: sponsor.publicKey(),
      userAddress: user.publicKey(),
      payingAsset: usdc,
      xlmNeeded: "1.6",
      maxSpend: "50",
      assets: [usdc],
      createdAccount: true,
    });
    settlement.sign(channel, user, sponsor);

    // The user never received anything, which is the same position as having swept
    // it: there is nothing to convert.
    const refused = await refusal(settlement);
    expect(refused.tx).toBe("txFailed");
    // the user has no USDC to pay with, so the payment is what refuses, and the
    // revokes after it never apply
    expect(refused.ops[0]).toBe("pathPaymentStrictReceiveUnderfunded");

    // The user's account is untouched and still usable.
    const account = await horizon(user.publicKey());
    expect(account.account_id).toBe(user.publicKey());
  }, 900_000);

  it("refuses to prepare a contract address, which needs no sponsorship at all", async () => {
    const sponsorAccount = await client.loadAccount(sponsor.publicKey());
    expect(() =>
      buildPreparation({
        network,
        sponsorAccount,
        userAddress: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
        createAccount: true,
        assets: [usdc],
      }),
    ).toThrow(/needs no preparation/);
  });
});
