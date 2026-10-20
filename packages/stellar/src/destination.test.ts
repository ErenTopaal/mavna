import { Address, Asset, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { inspectDestination } from "./destination.js";
import { RpcClient } from "./rpc.js";

const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

/**
 * A ledger behind the RPC boundary: answers getLedgerEntries with whichever of
 * the requested keys it holds, the way the real endpoint does.
 */
function ledger(entries: readonly xdr.LedgerEntryData[]): RpcClient {
  const held = new Map<string, xdr.LedgerEntryData>();
  for (const data of entries) held.set(keyOf(data).toXDR("base64"), data);
  const client = new RpcClient({ url: "https://example.invalid", baseDelayMs: 0 });
  client.server.getLedgerEntries = async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: 100,
    entries: keys.flatMap((key) => {
      const val = held.get(key.toXDR("base64"));
      return val === undefined ? [] : [{ key, val, lastModifiedLedgerSeq: 90 }];
    }),
  });
  return client;
}

function keyOf(data: xdr.LedgerEntryData): xdr.LedgerKey {
  switch (data.switch().name) {
    case "account":
      return xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: data.account().accountId() }),
      );
    case "trustline":
      return xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: data.trustLine().accountId(),
          asset: data.trustLine().asset(),
        }),
      );
    case "contractData":
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: data.contractData().contract(),
          key: data.contractData().key(),
          durability: data.contractData().durability(),
        }),
      );
    default:
      throw new Error(`no key for ${data.switch().name}`);
  }
}

const accountIdOf = (address: string): xdr.AccountId =>
  Address.fromString(address).toScAddress().accountId();

function accountEntry(address: string, balance = 100_000_000n): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: accountIdOf(address),
      balance: xdr.Int64.fromString(balance.toString()),
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: new Uint8Array([1, 0, 0, 0]) as never,
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );
}

function trustlineEntry(
  address: string,
  asset: Asset,
  fields: { balance?: bigint; limit?: bigint; flags?: number; buying?: bigint } = {},
): xdr.LedgerEntryData {
  const ext =
    fields.buying === undefined
      ? new xdr.TrustLineEntryExt(0)
      : new xdr.TrustLineEntryExt(
          1,
          new xdr.TrustLineEntryV1({
            liabilities: new xdr.Liabilities({
              buying: xdr.Int64.fromString(fields.buying.toString()),
              selling: xdr.Int64.fromString("0"),
            }),
            ext: new xdr.TrustLineEntryV1Ext(0),
          }),
        );
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: accountIdOf(address),
      asset: asset.toTrustLineXDRObject(),
      balance: xdr.Int64.fromString((fields.balance ?? 0n).toString()),
      limit: xdr.Int64.fromString((fields.limit ?? 9_223_372_036_854_775_807n).toString()),
      flags: fields.flags ?? 1,
      ext,
    }),
  );
}

function contractInstance(contractId: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          storage: null,
        }),
      ),
    }),
  );
}

const randomContract = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());

describe("a contract destination", () => {
  it("is ready when a contract instance exists at the address", async () => {
    const contract = randomContract();
    const state = await inspectDestination(ledger([contractInstance(contract)]), contract, usdc);
    expect(state.lane).toEqual({ kind: "contract-ready", slotsNeeded: 0 });
  });

  it("is unusable when nothing is deployed there, because funds sent to it can never move", async () => {
    const state = await inspectDestination(ledger([]), randomContract(), usdc);
    expect(state.lane.kind).toBe("unusable");
    expect(state.lane.kind === "unusable" && state.lane.reason).toBe(
      "No contract exists at that address on this network.",
    );
  });

  it("does not believe absence from a node behind the high-water mark", async () => {
    const contract = randomContract();
    const client = ledger([contractInstance(contract)]);
    const real = client.server.getLedgerEntries.bind(client.server);
    let calls = 0;
    client.server.getLedgerEntries = async (...keys: xdr.LedgerKey[]) => {
      calls += 1;
      if (calls === 1) return { latestLedger: 50, entries: [] };
      return real(...keys);
    };
    client.observeWrite(80);
    const state = await inspectDestination(client, contract, usdc);
    expect(state.lane.kind).toBe("contract-ready");
    expect(calls).toBe(2);
  });
});

describe("XLM", () => {
  it("is ready for any existing account, which holds XLM without a trustline", async () => {
    const holder = Keypair.random().publicKey();
    const state = await inspectDestination(ledger([accountEntry(holder)]), holder, Asset.native());
    expect(state.lane).toEqual({ kind: "ready", slotsNeeded: 0 });
    expect(state.account?.balanceStroops).toBe("100000000");
    expect(state.trustline).toBeUndefined();
  });

  it("needs only the account, two slots, for an address that does not exist", async () => {
    const state = await inspectDestination(
      ledger([]),
      Keypair.random().publicKey(),
      Asset.native(),
    );
    expect(state.lane).toEqual({ kind: "needs-account", slotsNeeded: 2 });
  });
});

describe("a trustline that exists", () => {
  it("is ready when authorised with room to spare", async () => {
    const holder = Keypair.random().publicKey();
    const state = await inspectDestination(
      ledger([accountEntry(holder), trustlineEntry(holder, usdc, { balance: 5n, limit: 100n })]),
      holder,
      usdc,
      { amountStroops: 95n },
    );
    expect(state.lane).toEqual({ kind: "ready", slotsNeeded: 0 });
    expect(state.trustline?.headroomStroops).toBe("95");
  });

  it("is unusable while the issuer has not authorised it", async () => {
    const holder = Keypair.random().publicKey();
    const state = await inspectDestination(
      ledger([accountEntry(holder), trustlineEntry(holder, usdc, { flags: 0 })]),
      holder,
      usdc,
    );
    expect(state.lane.kind).toBe("unusable");
    expect(state.lane.kind === "unusable" && state.lane.reason).toMatch(
      /issuer of USDC has not authorised/,
    );
    expect(state.trustline?.authorized).toBe(false);
  });

  it("is unusable when its limit has no room left at all", async () => {
    const holder = Keypair.random().publicKey();
    const state = await inspectDestination(
      ledger([accountEntry(holder), trustlineEntry(holder, usdc, { balance: 100n, limit: 100n })]),
      holder,
      usdc,
    );
    expect(state.lane.kind).toBe("unusable");
    expect(state.lane.kind === "unusable" && state.lane.reason).toMatch(/limit/);
  });

  it("is unusable when the limit, less pending buy offers, cannot take the amount", async () => {
    const holder = Keypair.random().publicKey();
    const state = await inspectDestination(
      ledger([
        accountEntry(holder),
        trustlineEntry(holder, usdc, { balance: 10n, limit: 100n, buying: 30n }),
      ]),
      holder,
      usdc,
      { amountStroops: 61n },
    );
    expect(state.trustline?.headroomStroops).toBe("60");
    expect(state.lane.kind).toBe("unusable");
    expect(state.lane.kind === "unusable" && state.lane.reason).toMatch(
      /room for only 0\.000006 USDC more/,
    );
  });
});
