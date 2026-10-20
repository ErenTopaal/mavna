import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * This package runs in the browser through the widget, where there is no
 * `Buffer` global. Deleting the global outright cannot test that under Node: the
 * SDK's dependency base32.js decodes every address through `new Buffer` in its
 * Node entry (its browser entry, which bundlers pick, has no such wrapper). So
 * the global is swapped for one that records every use whose caller is this
 * package's own runtime code, and the modules are loaded only after the swap so
 * a use at load time counts too.
 */

const saved = globalThis.Buffer;
const uses: string[] = [];

/** The first frame outside this file, when it is in this package's runtime code. */
function ourCaller(stack: string): string | undefined {
  const caller = stack
    .split("\n")
    .slice(1)
    .find((line) => line.includes(" at ") && !line.includes("no-buffer.test.ts"));
  if (caller === undefined) return undefined;
  return /packages\/stellar\/src\/(?![^:]*\.test\.ts)[^:]*\.ts/.test(caller)
    ? caller.trim()
    : undefined;
}

function callerIsOurs(): void {
  const caller = ourCaller(new Error().stack ?? "");
  if (caller !== undefined) uses.push(caller);
}

beforeAll(() => {
  globalThis.Buffer = new Proxy(saved, {
    get(target, property, receiver) {
      callerIsOurs();
      return Reflect.get(target, property, receiver);
    },
    apply(target, self, args) {
      callerIsOurs();
      return Reflect.apply(target as never, self, args);
    },
    construct(target, args) {
      callerIsOurs();
      return Reflect.construct(target as never, args);
    },
  });
  vi.resetModules();
});

afterAll(() => {
  globalThis.Buffer = saved;
  expect(uses).toEqual([]);
});

describe("this package's runtime code never touches the Buffer global", () => {
  it("classifies addresses, builds the sponsorship pair and formats amounts", async () => {
    const sdk = await import("@stellar/stellar-sdk");
    const stellar = await import("./index.js");
    const user = sdk.Keypair.random().publicKey();
    const sponsor = sdk.Keypair.random().publicKey();
    const usdc = new sdk.Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    const network = stellar.createNetworkConfig({ id: "testnet", rpcUrl: "https://rpc.invalid" });

    expect(stellar.classifyAddress(user).kind).toBe("account");
    const preparation = stellar.buildPreparation({
      network,
      sponsorAccount: new sdk.Account(sponsor, "1"),
      userAddress: user,
      createAccount: true,
      assets: [usdc],
    });
    expect(preparation.toXDR().length).toBeGreaterThan(0);
    const ladder = stellar.buildSettlementLadder(
      {
        network,
        channelAccount: new sdk.Account(sdk.Keypair.random().publicKey(), "1"),
        sponsorAddress: sponsor,
        userAddress: user,
        payingAsset: usdc,
        xlmNeeded: "1",
        maxSpend: "2",
        assets: [usdc],
        createdAccount: true,
      },
      2,
    );
    expect(ladder).toHaveLength(2);
    expect(stellar.stroopsToXlm(-12_345_678n)).toBe("-1.2345678");
    expect(uses).toEqual([]);
  });

  it("inspects destinations and submits through the guarded client", async () => {
    const sdk = await import("@stellar/stellar-sdk");
    const stellar = await import("./index.js");
    const client = new stellar.RpcClient({
      url: "https://rpc.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    client.server.getLedgerEntries = async () => ({ latestLedger: 10, entries: [] });

    const contract = sdk.StrKey.encodeContract(sdk.Keypair.random().rawPublicKey());
    const usdc = new sdk.Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect((await stellar.inspectDestination(client, contract, usdc)).lane.kind).toBe("unusable");
    const fresh = sdk.Keypair.random().publicKey();
    expect((await stellar.inspectDestination(client, fresh, usdc)).lane.kind).toBe("needs-account");

    const source = sdk.Keypair.random();
    const tx = new sdk.TransactionBuilder(new sdk.Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(sdk.Operation.bumpSequence({ bumpTo: "5" }))
      .setTimeout(60)
      .build();
    tx.sign(source);
    // a send that times out is looked for by its hash, which is the one place
    // this package turns bytes into hex
    client.server.sendTransaction = async () => {
      throw Object.assign(new Error("timeout of 15000 ms exceeded"), { code: "ECONNABORTED" });
    };
    client.server.getTransaction = async (hash) =>
      ({
        status: sdk.rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: 11,
        latestLedger: 11,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }) as never;
    const landed = await client.submit("bump", async () => tx);
    expect(landed.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(uses).toEqual([]);
  });

  it("would notice if it did", () => {
    // the control: which frames count as this package's runtime code
    const from = (file: string) =>
      `Error\n    at get (/w/packages/stellar/src/no-buffer.test.ts:30:7)\n    at touch (${file}:12:3)`;
    expect(ourCaller(from("/w/packages/stellar/src/rpc.ts"))).toMatch(/rpc\.ts/);
    expect(ourCaller(from("/w/packages/stellar/src/rpc.test.ts"))).toBeUndefined();
    expect(ourCaller(from("/w/node_modules/base32.js/index.js"))).toBeUndefined();
  });
});
