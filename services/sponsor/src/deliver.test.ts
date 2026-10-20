import { MavnaError } from "@mavna/core";
import { type NetworkConfig, RpcClient } from "@mavna/stellar";
import {
  Account,
  Address,
  Keypair,
  Operation,
  rpc,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { Deliverer, DeliveryBudgetSpent } from "./deliver.js";
import { DeliveryBudget } from "./delivery-budget.js";
import { MemoryDocumentStore } from "./state.js";

/**
 * The delivery worker's judgement, not its plumbing.
 *
 * The thing worth testing here is which failures it treats as "wait" and which
 * as "this went wrong", because collapsing those two is how a user who needs a
 * trustline gets told their transfer failed, and a user told that retries.
 */

const network = {
  passphrase: "Test SDF Network ; September 2015",
} as unknown as NetworkConfig;

const payer = Keypair.random().secret();

function delivererThatFailsWith(message: string): Deliverer {
  return new Deliverer({
    network,
    networkId: "testnet",
    payerSecret: payer,
    rpc: {
      loadAccount: () => Promise.resolve({} as never),
      prepare: () => Promise.reject(new Error(message)),
    } as unknown as RpcClient,
    buildDelivery: () => ({}) as never,
  });
}

describe("what a failed delivery actually means", () => {
  it("reads a missing trustline as not ready, never as failed", async () => {
    // Circle's contract reverts the whole invocation and rolls back its own
    // replay record with it, so the message is still deliverable. Reporting this
    // as a failure would send someone chasing money that is not lost.
    const outcome = await delivererThatFailsWith(
      "HostError: Error(Contract, #13) trustline entry is missing for account",
    ).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" });

    expect(outcome.kind).toBe("recipient-not-ready");
  });

  it("reads a spent nonce as already delivered, which is a success", async () => {
    // The number Circle's transmitter actually raises, from its own source.
    const outcome = await delivererThatFailsWith("HostError: Error(Contract, #6908)").deliver({
      messageHex: "0xabcd",
      attestationHex: "0x1234",
    });

    expect(outcome.kind).toBe("already-delivered");
  });

  it("refuses to raise an unrecognised failure as an outcome", async () => {
    // Anything not understood has to surface, because a delivery that quietly
    // reports a tidy state it did not reach is worse than one that throws.
    await expect(
      delivererThatFailsWith("the node is on fire").deliver({
        messageHex: "0xabcd",
        attestationHex: "0x1234",
      }),
    ).rejects.toThrow(MavnaError);
  });
});

describe("before anything is signed", () => {
  it("says an unattested burn is not ready rather than building a transaction", async () => {
    // Circle writes the literal string PENDING until it has signed. Passing that
    // through as an attestation would produce a transaction that cannot succeed.
    const deliverer = new Deliverer({
      network,
      networkId: "testnet",
      payerSecret: payer,
      rpc: {
        loadAccount: () => Promise.reject(new Error("should not have been reached")),
      } as unknown as RpcClient,
      buildDelivery: () => {
        throw new Error("should not have been reached");
      },
    });

    expect(
      (await deliverer.deliver({ messageHex: "0xabcd", attestationHex: "PENDING" })).kind,
    ).toBe("not-attested-yet");
  });

  it("rejects a key that is not a key, at construction rather than mid-transfer", () => {
    // Discovering this when someone's funds are already burned and waiting is
    // the worst possible moment for a configuration mistake to surface.
    expect(
      () =>
        new Deliverer({
          network,
          networkId: "testnet",
          payerSecret: "not-a-secret-key",
          rpc: {} as unknown as RpcClient,
          buildDelivery: () => ({}) as never,
        }),
    ).toThrow();
  });

  it("exposes the paying address and never the secret", () => {
    const deliverer = new Deliverer({
      network,
      networkId: "testnet",
      payerSecret: payer,
      rpc: {} as unknown as RpcClient,
      buildDelivery: () => ({}) as never,
    });

    expect(deliverer.payerAddress).toBe(Keypair.fromSecret(payer).publicKey());
    expect(JSON.stringify(deliverer)).not.toContain(payer);
  });
});

/**
 * The network behind a real RpcClient, as far as delivery needs it: an account
 * whose sequence moves when anything lands, and a submission that is refused
 * with txBadSeq unless it carries the next one.
 */
class SequencedRpc extends RpcClient {
  sequence = 100n;
  readonly sent: bigint[] = [];
  /** Something else the payer signed lands before this many sends. */
  landsFirst = new Set<number>();
  /** A refusal every send gets, the way the network refuses a bad envelope. */
  refuseWith: "txBadAuth" | undefined = undefined;
  /** What simulation adds to the transaction, the way prepareTransaction does. */
  simulate: (tx: Transaction) => Transaction = (tx) => tx;
  private readonly landed = new Set<string>();

  constructor() {
    super({ url: "https://127.0.0.1:9", baseDelayMs: 0, sleep: () => Promise.resolve() });
    this.server.sendTransaction = async (tx) => {
      if (this.landsFirst.delete(this.sent.length)) this.sequence += 1n;
      const inner = tx as Transaction;
      this.sent.push(BigInt(inner.sequence));
      const hash = tx.hash().toString("hex");
      const base = { hash, latestLedger: 1, latestLedgerCloseTime: 0 };
      if (this.refuseWith !== undefined || BigInt(inner.sequence) !== this.sequence + 1n) {
        return {
          ...base,
          status: "ERROR",
          errorResult: new xdr.TransactionResult({
            feeCharged: xdr.Int64.fromString("100"),
            result:
              this.refuseWith === undefined
                ? xdr.TransactionResultResult.txBadSeq()
                : xdr.TransactionResultResult.txBadAuth(),
            ext: new xdr.TransactionResultExt(0),
          }),
        };
      }
      this.sequence += 1n;
      this.landed.add(hash);
      return { ...base, status: "PENDING" };
    };
    this.server.getTransaction = async (hash) =>
      (this.landed.has(hash)
        ? { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 2, latestLedger: 2 }
        : {
            status: rpc.Api.GetTransactionStatus.NOT_FOUND,
            txHash: hash,
            latestLedger: 2,
          }) as never;
  }

  override async loadAccount(address: string): Promise<Account> {
    return new Account(address, this.sequence.toString());
  }

  override async prepare(tx: Transaction): Promise<Transaction> {
    return this.simulate(tx);
  }
}

function deliveryOn(rpcClient: SequencedRpc, budget?: DeliveryBudget): Deliverer {
  return new Deliverer({
    ...(budget === undefined ? {} : { budget }),
    network,
    networkId: "testnet",
    payerSecret: payer,
    rpc: rpcClient,
    buildDelivery: ({ payerAccount }) =>
      // the inclusion bid the CCTP adapter's builder sets
      new TransactionBuilder(payerAccount, {
        fee: "10000000",
        networkPassphrase: network.passphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
            function: "receive_message",
            args: [],
          }),
        )
        .setTimeout(300)
        .build(),
  });
}

describe("a delivery whose sequence something else spent", () => {
  it("is rebuilt on the payer's fresh sequence rather than resent as it was", async () => {
    const network = new SequencedRpc();
    // another sponsor transaction lands between building and the first send
    network.landsFirst.add(0);
    const outcome = await deliveryOn(network).deliver({
      messageHex: "0xabcd",
      attestationHex: "0x1234",
    });
    expect(outcome.kind).toBe("delivered");
    expect(network.sent).toEqual([101n, 102n]);
  });
});

/** The delivery as simulation hands it back, with what simulation set. */
function simulated(
  tx: Transaction,
  { fee, auth = [] }: { fee: string; auth?: xdr.SorobanAuthorizationEntry[] },
): Transaction {
  return new TransactionBuilder(new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()), {
    fee,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
        function: "receive_message",
        args: [],
        auth,
      }),
    )
    .setTimeout(300)
    .build();
}

describe("what the sponsor will pay and authorize for a delivery", () => {
  it("does not sign a delivery whose simulated fee is past its ceiling", async () => {
    const rpc = new SequencedRpc();
    rpc.simulate = (tx) => simulated(tx, { fee: "20000001" });
    await expect(
      deliveryOn(rpc).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" }),
    ).rejects.toThrow(/more than the .* XLM this sponsor pays/);
    expect(rpc.sent).toEqual([]);
  });

  it("signs one within it", async () => {
    const rpc = new SequencedRpc();
    rpc.simulate = (tx) => simulated(tx, { fee: "10200000" });
    const outcome = await deliveryOn(rpc).deliver({
      messageHex: "0xabcd",
      attestationHex: "0x1234",
    });
    expect(outcome.kind).toBe("delivered");
  });

  it("does not sign a delivery that asks for any authorization", async () => {
    const rpc = new SequencedRpc();
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(
              StrKey.encodeContract(Buffer.alloc(32, 9)),
            ).toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    rpc.simulate = (tx) => simulated(tx, { fee: "10200000", auth: [entry] });
    await expect(
      deliveryOn(rpc).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" }),
    ).rejects.toThrow(/authorize/);
    expect(rpc.sent).toEqual([]);
  });
});

describe("a delivery against the day's budget", () => {
  it("is refused unsigned once the day's budget cannot cover its worst case", async () => {
    const rpcClient = new SequencedRpc();
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 15_000_000n, () => "2026-10-20");
    await expect(
      deliveryOn(rpcClient, budget).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" }),
    ).rejects.toBeInstanceOf(DeliveryBudgetSpent);
    expect(rpcClient.sent).toEqual([]);
  });

  it("gives its share back when the network refused it outright", async () => {
    const rpcClient = new SequencedRpc();
    rpcClient.refuseWith = "txBadAuth";
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 50_000_000n, () => "2026-10-20");
    await expect(
      deliveryOn(rpcClient, budget).deliver({ messageHex: "0xabcd", attestationHex: "0x1234" }),
    ).rejects.toThrow();
    expect(await budget.spentToday()).toBe(0n);
  });
});
