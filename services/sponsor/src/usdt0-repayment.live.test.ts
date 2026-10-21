import type { AddressInfo } from "node:net";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import {
  Asset,
  AuthClawbackEnabledFlag,
  AuthRevocableFlag,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelPool } from "./channels.js";
import { createSponsorServer, type SponsorServer } from "./server.js";

/**
 * A new account fronted a trustline and repaid in a USDT0-shaped asset, on
 * Stellar testnet, through the sponsor's own endpoints.
 *
 * LayerZero carries no USDT0 to testnet, so the test issues its own asset in
 * USDT0's shape: a five-letter code (alphanum12), an issuer that can freeze
 * and claw back (auth_revocable and auth_clawback_enabled, as USDT0's mainnet
 * issuer has), and a direct market against XLM on the order book. It is
 * curated under the name USDT0. Everything after that is real: the order book
 * the ceiling is priced from, Horizon's direct-path quote, the sponsored
 * preparation, the issuer freezing and clawing back, and the settlement.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const rpc = new RpcClient({ url: network.rpcUrl });
const HORIZON = "https://horizon-testnet.stellar.org";

const sponsor = Keypair.random();
const channel = Keypair.random();
const issuer = Keypair.random();
const maker = Keypair.random();
const token = new Asset("MVNT0", issuer.publicKey());

let server: SponsorServer;
let base = "";

async function friendbot(kp: Keypair): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!response.ok && response.status !== 400) throw new Error(`friendbot ${response.status}`);
  await rpc.waitForAccount(kp.publicKey());
}

async function submitAs(label: string, signer: Keypair, ops: xdr.Operation[]): Promise<void> {
  await rpc.submit(label, async () => {
    const source = await rpc.loadAccount(signer.publicKey());
    const builder = new TransactionBuilder(source, {
      fee: "1000000",
      networkPassphrase: network.passphrase,
    });
    for (const op of ops) builder.addOperation(op);
    const built = builder.setTimeout(300).build();
    built.sign(signer);
    return built;
  });
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function horizonAccount(address: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${HORIZON}/accounts/${address}`);
  if (!response.ok) throw new Error(`horizon ${response.status} for ${address}`);
  return (await response.json()) as Record<string, unknown>;
}

function sign(xdrText: string, user: Keypair): string {
  const tx = TransactionBuilder.fromXdr(xdrText, network.passphrase) as Transaction;
  tx.sign(user);
  return tx.toXdr();
}

/** The honest flow up to a landed preparation, as the widget runs it. */
async function lentTo(user: Keypair): Promise<Transaction> {
  const built = await post("/settlement", {
    destination: user.publicKey(),
    sourceChainId: "42161",
    asset: "USDT0",
  });
  expect(built.status, JSON.stringify(built.body)).toBe(200);
  const settlement = TransactionBuilder.fromXdr(
    built.body.xdr as string,
    network.passphrase,
  ) as Transaction;
  const committed = await post("/settlement/commit", {
    destination: user.publicKey(),
    signedXdr: sign(settlement.toXdr(), user),
  });
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  const prepared = await post("/prepare", {
    destination: user.publicKey(),
    assets: ["USDT0"],
    sourceChainId: "42161",
  });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const submitted = await post("/submit", { signedXdr: sign(prepared.body.xdr as string, user) });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return settlement;
}

async function arrives(user: Keypair, amount: string): Promise<void> {
  await submitAs("arrival", issuer, [
    Operation.payment({ destination: user.publicKey(), asset: token, amount }),
  ]);
}

/** The sponsor asks again for one account only after a pause; this waits it out. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 31_000));

async function channelSequence(): Promise<string> {
  return (await rpc.loadAccount(channel.publicKey())).sequenceNumber();
}

beforeAll(async () => {
  await Promise.all([friendbot(sponsor), friendbot(channel), friendbot(issuer), friendbot(maker)]);
  // set before any trustline exists, so every line inherits clawback, as USDT0's do
  await submitAs("issuer flags", issuer, [
    Operation.setOptions({ setFlags: (AuthRevocableFlag | AuthClawbackEnabledFlag) as never }),
  ]);
  await submitAs("maker trustline", maker, [Operation.changeTrust({ asset: token })]);
  await submitAs("fund the maker", issuer, [
    Operation.payment({ destination: maker.publicKey(), asset: token, amount: "10000" }),
  ]);
  // both sides of the book past the 1000 XLM the price source averages over:
  // XLM sold at 0.2 of the token, and XLM bought at about 0.18
  await submitAs("make the market", maker, [
    Operation.manageSellOffer({
      selling: Asset.native(),
      buying: token,
      amount: "2000",
      price: "0.2",
    }),
    Operation.manageSellOffer({
      selling: token,
      buying: Asset.native(),
      amount: "400",
      price: "5.5",
    }),
  ]);

  server = createSponsorServer({
    rpc,
    network,
    networkId: "testnet",
    sponsorSecret: sponsor.secret(),
    curatedAssets: {
      USDC: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      USDT0: token,
    },
    buildDelivery: () => {
      throw new Error("no Circle delivery in this test");
    },
    irisUrl: "https://iris.invalid",
    channels: new ChannelPool({ channels: [channel] }),
    allowedOrigins: [],
    settleSweepSeconds: 0,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 600_000);

afterAll(() => {
  server?.close();
});

describe("a USDT0-shaped repayment on live testnet", () => {
  it("fronts a new account, opens a clawback-enabled line, and takes the reserve back from the arrival", async () => {
    const user = Keypair.random();
    const settlement = await lentTo(user);
    const pays = settlement.operations[0] as { sendMax: string; destAmount: string };
    expect(pays.destAmount).toBe("1.5000000");

    // the line the sponsor opened is one its issuer can claw back from
    const opened = await horizonAccount(user.publicKey());
    const line = (opened.balances as Array<Record<string, unknown>>).find(
      (b) => b.asset_code === "MVNT0",
    );
    expect(line?.is_clawback_enabled).toBe(true);
    expect(opened.num_sponsored).toBe(3);

    await arrives(user, "10");
    const settled = await post("/settle", { destination: user.publicKey() });
    expect(settled.body, JSON.stringify(settled.body)).toMatchObject({ settled: true });

    const after = await horizonAccount(user.publicKey());
    expect(after.num_sponsored).toBe(0);
    expect((await horizonAccount(sponsor.publicKey())).num_sponsoring).toBe(0);
    const native = (after.balances as Array<Record<string, unknown>>).find(
      (b) => b.asset_type === "native",
    );
    expect(native?.balance).toBe("1.5000000");
  }, 900_000);

  it("waits, spending nothing, while the issuer has the line frozen, and settles once it is not", async () => {
    const user = Keypair.random();
    await lentTo(user);
    await arrives(user, "10");
    await submitAs("freeze", issuer, [
      Operation.setTrustLineFlags({
        trustor: user.publicKey(),
        asset: token,
        flags: { authorized: false },
      }),
    ]);
    const before = await channelSequence();
    const frozen = await post("/settle", { destination: user.publicKey() });
    expect(frozen.body).toMatchObject({ settled: false, settlementRetryable: true });
    // nothing went out, so the settlement's sequence is still there to use
    expect(await channelSequence()).toBe(before);
    expect((await horizonAccount(user.publicKey())).num_sponsored).toBe(3);

    await submitAs("unfreeze", issuer, [
      Operation.setTrustLineFlags({
        trustor: user.publicKey(),
        asset: token,
        flags: { authorized: true },
      }),
    ]);
    await pause();
    const settled = await post("/settle", { destination: user.publicKey() });
    expect(settled.body, JSON.stringify(settled.body)).toMatchObject({ settled: true });
    expect((await horizonAccount(user.publicKey())).num_sponsored).toBe(0);
  }, 900_000);

  it("waits, spending nothing, when the issuer claws the arrival back, and settles from a new one", async () => {
    const user = Keypair.random();
    await lentTo(user);
    await arrives(user, "10");
    await submitAs("clawback", issuer, [
      Operation.clawback({ from: user.publicKey(), asset: token, amount: "10" }),
    ]);
    const before = await channelSequence();
    const short = await post("/settle", { destination: user.publicKey() });
    expect(short.body).toMatchObject({ settled: false, settlementRetryable: true });
    expect(await channelSequence()).toBe(before);

    await arrives(user, "10");
    await pause();
    const settled = await post("/settle", { destination: user.publicKey() });
    expect(settled.body, JSON.stringify(settled.body)).toMatchObject({ settled: true });
    expect((await horizonAccount(user.publicKey())).num_sponsored).toBe(0);
  }, 900_000);
});
