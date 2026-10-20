import { composeMessageHash } from "@mavna/adapter-layerzero";
import type { ComposeFinish } from "@mavna/core";
import { createNetworkConfig, RpcClient } from "@mavna/stellar";
import {
  Address,
  nativeToScVal,
  type Operation,
  SorobanDataBuilder,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import entries from "../../adapters/layerzero/src/__fixtures__/testnet-ledger-entries.json" with {
  type: "json",
};
import { finishCompose } from "./own-compose";

/**
 * Finishing an overdue conversion on arrival. The Arrival Contract's storage is
 * replayed from a testnet recording; the node's simulation and submission are
 * doubles, and so is the wallet at its signing boundary.
 */

const ARRIVAL = "CD5M6IBU25CVG42TVJ3MICJQL2R2VIUUXNVEGWRH7CDSNCS4XTQYP35A";
// the OFT the testnet contract accepts (a harness key) and a recipient wallet
const FROM = "GBNCXZUVSV4GCBTYKCUPK46XS5U3CEDP6F54NZIWQ4GN3SWD52D3N2NB";
const USER = "GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL";
const MESSAGE = `0x${"ab".repeat(40)}` as const;

const finish: ComposeFinish = {
  contract: ARRIVAL,
  from: FROM,
  guid: "cd".repeat(32),
  index: 0,
  message: MESSAGE,
};

let log: string[];
/** What the endpoint's compose_queue holds for the slot. */
let queued: xdr.ScVal;
/** The authorization the run asks for, as simulation records it. */
let recordedAuth: (args: xdr.ScVal[]) => xdr.SorobanAuthorizationEntry[];

afterEach(() => {
  vi.restoreAllMocks();
});

function composeAuth(args: xdr.ScVal[], nested = false): xdr.SorobanAuthorizationEntry {
  const fn = (contract: string, name: string, a: xdr.ScVal[]) =>
    xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: name,
        args: a,
      }),
    );
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: fn(ARRIVAL, "lz_compose", args),
      subInvocations: nested
        ? [
            new xdr.SorobanAuthorizedInvocation({
              // a token in the message trying to spend the wallet's XLM
              function: fn("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", "transfer", [
                new Address(USER).toScVal(),
                new Address(FROM).toScVal(),
                nativeToScVal(1_000_000n, { type: "i128" }),
              ]),
              subInvocations: [],
            }),
          ]
        : [],
    }),
  });
}

function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://rpc.invalid",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  const known = new Map<string, { readonly xdr: string; readonly lastModifiedLedgerSeq: number }>();
  for (const recorded of Object.values(entries)) {
    for (const e of recorded.entries) known.set(e.key, e);
  }
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => ({
    latestLedger: entries.arrival.latestLedger,
    entries: keys.flatMap((k) => {
      const e = known.get(k.toXDR("base64"));
      return e === undefined
        ? []
        : [
            {
              key: k,
              val: xdr.LedgerEntryData.fromXDR(e.xdr, "base64"),
              lastModifiedLedgerSeq: e.lastModifiedLedgerSeq,
            },
          ];
    }),
  }));
  vi.spyOn(client.server, "getLatestLedger").mockResolvedValue({
    sequence: entries.arrival.latestLedger,
  } as never);
  vi.spyOn(client.server, "simulateTransaction").mockImplementation(async (tx) => {
    const op = (tx as { operations: Operation.InvokeHostFunction[] }).operations[0];
    const call = op?.func.invokeContract();
    const name = call?.functionName().toString();
    log.push(`simulate ${name}`);
    if (name === "compose_queue") {
      return {
        latestLedger: entries.arrival.latestLedger,
        result: { retval: queued, auth: [] },
      } as never;
    }
    // priced so the prepared transaction costs 500000 stroops in all
    const resourceFee = 500_000n - BigInt((tx as Transaction).fee);
    return {
      _parsed: true,
      id: "1",
      events: [],
      latestLedger: entries.arrival.latestLedger,
      minResourceFee: resourceFee.toString(),
      transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
      result: { retval: xdr.ScVal.scvVoid(), auth: recordedAuth(call?.args() ?? []) },
    } as never;
  });
  vi.spyOn(client.server, "sendTransaction").mockImplementation(async (tx) => {
    const sent = tx as { source: string; operations: Operation.InvokeHostFunction[] };
    log.push(`send from ${sent.source}`);
    return { status: "PENDING", hash: "c0de" } as never;
  });
  vi.spyOn(client.server, "getTransaction").mockResolvedValue({
    status: "SUCCESS",
    txHash: "c0de",
    ledger: 7,
    latestLedger: 7,
  } as never);
  return client;
}

function engineFor(funding: "self" | "sponsor") {
  log = [];
  return {
    network: "testnet" as const,
    rpc: stellarNode(),
    stellarNetwork: createNetworkConfig({ id: "testnet", rpcUrl: "https://rpc.invalid" }),
    arrivalContract: ARRIVAL,
    sponsorTerms: async () => ({
      network: "testnet",
      reserveFunding: funding,
      minDeliveryBaseUnits: 0n,
    }),
    sponsor: {
      requestCompose: async () => {
        log.push("sponsor /compose");
        return { kind: "composed" as const, txHash: "5e5e", ledger: 3 };
      },
    },
    stellar: {
      connect: async () => {
        log.push("stellar connect");
        return USER;
      },
      sign: async (signedXdr: string) => {
        log.push("stellar sign compose");
        return signedXdr;
      },
      disconnect: async () => {},
    },
  };
}

describe("finishing a conversion on arrival from Activity", () => {
  it("has the account's own wallet run lz_compose as executor when accounts fund themselves", async () => {
    const engine = engineFor("self");
    queued = xdr.ScVal.scvBytes(Buffer.from(composeMessageHash(MESSAGE).slice(2), "hex"));
    recordedAuth = (args) => [composeAuth(args)];
    const priced = await finishCompose(engine, finish);
    // priced first, from the prepared run, and nothing signed until agreed
    expect(priced).toMatchObject({ kind: "priced", feeStroops: 500_000n });
    expect(log).toEqual([
      "stellar connect",
      "simulate compose_queue",
      "simulate lz_compose",
      "simulate lz_compose",
    ]);
    if (priced.kind !== "priced") return;
    expect(await priced.finish()).toEqual({ kind: "composed", txHash: "c0de", ledger: 7 });
    expect(log.slice(4)).toEqual(["stellar sign compose", `send from ${USER}`]);
  });

  it("asks the sponsor when it pays for finishing", async () => {
    const engine = engineFor("sponsor");
    const outcome = await finishCompose(engine, finish);
    expect(outcome).toEqual({ kind: "composed", txHash: "5e5e", ledger: 3 });
    expect(log).toEqual(["sponsor /compose"]);
  });

  it("refuses to sign a run that would authorize anything beyond the compose itself", async () => {
    const engine = engineFor("self");
    queued = xdr.ScVal.scvBytes(Buffer.from(composeMessageHash(MESSAGE).slice(2), "hex"));
    recordedAuth = (args) => [composeAuth(args, true)];
    await expect(finishCompose(engine, finish)).rejects.toThrow(/more than the conversion/);
    expect(log).not.toContain("stellar sign compose");
  });

  it("says when there is nothing to run, or it already ran, without signing", async () => {
    const engine = engineFor("self");
    queued = xdr.ScVal.scvVoid();
    expect(await finishCompose(engine, finish)).toEqual({ kind: "not-queued" });
    queued = xdr.ScVal.scvBytes(Buffer.from(`${"00".repeat(31)}01`, "hex"));
    expect(await finishCompose(engine, finish)).toEqual({ kind: "already-composed" });
    expect(log).not.toContain("stellar sign compose");
  });

  it("will not run a message other than the one the endpoint holds, or for another contract", async () => {
    const engine = engineFor("self");
    queued = xdr.ScVal.scvBytes(Buffer.alloc(32, 9));
    recordedAuth = (args) => [composeAuth(args)];
    await expect(finishCompose(engine, finish)).rejects.toThrow(/not the message waiting/);
    await expect(
      finishCompose(engine, {
        ...finish,
        contract: "CC52SIPHNMTBMHSBYTUI3R53PPMBGTEOJ566GFMSREBFA3KVJ4MY7OBT",
      }),
    ).rejects.toThrow(/not the Arrival Contract/);
    expect(log).not.toContain("stellar sign compose");
  });
});
