import { Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectDestination } from "./destination.js";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL } from "./network.js";
import { quoteReserve, stroopsToXlm } from "./reserve.js";
import { RpcClient } from "./rpc.js";
import { buildPreparation, buildSettlement } from "./sponsorship.js";

/**
 * Proves the whole sponsorship mechanism against live testnet: a user who has
 * never touched Stellar signs a settlement BEFORE any capital is committed, gets
 * an account and a trustline paid for by the sponsor, receives value, and then
 * settles, ending up owning their account outright with the sponsor released.
 *
 * The paying asset is issued by the test rather than borrowed, because the
 * settlement needs real orderbook liquidity between that asset and XLM, and no
 * such market exists for an asset we do not control.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const client = new RpcClient({ url: network.rpcUrl });

const sponsor = Keypair.random();
const channel = Keypair.random();
const issuer = Keypair.random();
const maker = Keypair.random();
const user = Keypair.random();

let token: Asset;

async function friendbot(kp: Keypair): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!response.ok && response.status !== 400) throw new Error(`friendbot ${response.status}`);
  await client.loadAccount(kp.publicKey());
}

/** numSponsoring on an account: how many reserve slots it is carrying for others. */
async function sponsorshipsCarried(address: string): Promise<number> {
  const account = await horizonAccount(address);
  return Number(account.num_sponsoring ?? 0);
}

/** numSponsored: how many of this account's slots someone else is carrying. */
async function sponsorshipsOwed(address: string): Promise<number> {
  const account = await horizonAccount(address);
  return Number(account.num_sponsored ?? 0);
}

/**
 * Read through Horizon because sponsorship counts are what we are asserting and
 * Horizon exposes them directly. This is the reconciliation path, not the
 * operational one.
 */
async function horizonAccount(address: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  if (!response.ok) throw new Error(`horizon ${response.status} for ${address}`);
  return (await response.json()) as Record<string, unknown>;
}

function tx(source: Awaited<ReturnType<RpcClient["loadAccount"]>>) {
  return new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: network.passphrase,
  });
}

beforeAll(async () => {
  await Promise.all([friendbot(sponsor), friendbot(channel), friendbot(issuer), friendbot(maker)]);
  token = new Asset("MVNT", issuer.publicKey());

  // A market so the settlement's path payment has somewhere to execute: the maker
  // holds the token and offers XLM for it.
  await client.submit("market maker setup", async () => {
    const source = await client.loadAccount(maker.publicKey());
    const built = tx(source)
      .addOperation(Operation.changeTrust({ asset: token }))
      .setTimeout(300)
      .build();
    built.sign(maker);
    return built;
  });

  await client.submit("fund the maker with token", async () => {
    const source = await client.loadAccount(issuer.publicKey());
    const built = tx(source)
      .addOperation(
        Operation.payment({ destination: maker.publicKey(), asset: token, amount: "10000" }),
      )
      .setTimeout(300)
      .build();
    built.sign(issuer);
    return built;
  });

  await client.submit("post the offer", async () => {
    const source = await client.loadAccount(maker.publicKey());
    const built = tx(source)
      .addOperation(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: token,
          amount: "5000",
          price: "1",
        }),
      )
      .setTimeout(300)
      .build();
    built.sign(maker);
    return built;
  });
}, 600_000);

describe("sponsorship against live testnet", () => {
  it("takes a user from nothing to owning their own account, with the sponsor released", async () => {
    // 1. The user has never touched Stellar.
    const before = await inspectDestination(client, user.publicKey(), token);
    expect(before.lane.kind).toBe("needs-account");

    const quote = quoteReserve({
      lane: before.lane,
      destinationAssetDiffers: false,
      baseReserveStroops: network.baseReserveStroops,
    });
    expect(quote.slots).toBe(3);
    expect(quote.xlm).toBe("1.5");

    // 2. The settlement is signed BEFORE any capital is committed. The user's
    //    account does not exist yet; a channel carries the sequence number.
    const channelAccount = await client.loadAccount(channel.publicKey());
    const settlement = buildSettlement({
      network,
      channelAccount,
      sponsorAddress: sponsor.publicKey(),
      userAddress: user.publicKey(),
      payingAsset: token,
      // A little above the bare reserve so the account clears its own minimum.
      xlmNeeded: "1.6",
      maxSpend: "50",
      assets: [token],
      createdAccount: true,
    });
    settlement.sign(channel, user, sponsor);
    expect(settlement.signatures).toHaveLength(3);

    // 3. Only now does the sponsor commit capital.
    await client.submit("preparation", async () => {
      const sponsorAccount = await client.loadAccount(sponsor.publicKey());
      const built = buildPreparation({
        network,
        sponsorAccount,
        userAddress: user.publicKey(),
        createAccount: true,
        assets: [token],
      });
      built.sign(sponsor, user);
      return built;
    });

    const prepared = await inspectDestination(client, user.publicKey(), token);
    expect(prepared.lane.kind).toBe("ready");
    expect(prepared.account?.balanceStroops).toBe("0");

    // 4. Value arrives, standing in for a bridge delivery.
    await client.submit("arrival", async () => {
      const source = await client.loadAccount(issuer.publicKey());
      const built = tx(source)
        .addOperation(
          Operation.payment({ destination: user.publicKey(), asset: token, amount: "100" }),
        )
        .setTimeout(300)
        .build();
      built.sign(issuer);
      return built;
    });

    // 5. Submit the settlement collected in step 2, untouched.
    const result = await client.submit("settlement", async () => settlement);
    expect(result.status).toBe("SUCCESS");

    // 6. The user owns their account outright and the sponsor carries nothing.
    const after = await client.loadAccount(user.publicKey());
    expect(after).toBeDefined();

    const settled = await inspectDestination(client, user.publicKey(), token);
    expect(settled.lane.kind).toBe("ready");
    expect(BigInt(settled.account?.balanceStroops ?? "0")).toBeGreaterThan(0n);

    // The whole point: the sponsor is carrying nothing and its capital is free
    // to onboard the next person.
    expect(await sponsorshipsCarried(sponsor.publicKey())).toBe(0);
    expect(await sponsorshipsOwed(user.publicKey())).toBe(0);
  }, 900_000);

  it("refuses to sponsor more trustlines than the invariant allows", async () => {
    const sponsorAccount = await client.loadAccount(sponsor.publicKey());
    const three = [token, Asset.native(), token];
    expect(() =>
      buildPreparation({
        network,
        sponsorAccount,
        userAddress: user.publicKey(),
        createAccount: false,
        assets: three,
      }),
    ).toThrow(/limit is 2/);
  });

  it("reports the expensive lane as costing more", () => {
    const quote = quoteReserve({
      lane: { kind: "needs-account", slotsNeeded: 3 },
      destinationAssetDiffers: true,
      baseReserveStroops: network.baseReserveStroops,
    });
    expect(quote.slots).toBe(4);
    expect(quote.xlm).toBe("2");
    expect(stroopsToXlm(quote.floorStroops)).toBe("8");
  });
});
