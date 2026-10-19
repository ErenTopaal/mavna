import { MavnaError } from "@mavna/core";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountNotFound, createLedgerFloor, RpcClient, SubmitRejected } from "./rpc.js";

const noSleep = async (): Promise<void> => {};

function clientForTest(): RpcClient {
  return new RpcClient({ url: "https://example.invalid", baseDelayMs: 0, sleep: noSleep });
}

describe("ledger floor", () => {
  it("only ever rises", () => {
    const floor = createLedgerFloor();
    floor.observe(100);
    floor.observe(50);
    expect(floor.value).toBe(100);
  });
});

describe("read guard", () => {
  it("rejects an answer from a node behind the high-water mark, then accepts a fresh one", async () => {
    const client = clientForTest();
    client.observeWrite(1000);

    // The public endpoint is load balanced across nodes at different heights, so
    // this is the ordinary case rather than an exotic one.
    const ledgers = [990, 995, 1001];
    let call = 0;
    const value = await client.read("thing", async () => {
      const ledger = ledgers[call++] ?? 1001;
      return { value: `seen-at-${ledger}`, ledger };
    });

    expect(value).toBe("seen-at-1001");
    expect(call).toBe(3);
  });

  it("gives up rather than returning a stale answer", async () => {
    const client = clientForTest();
    client.observeWrite(5000);

    await expect(
      client.read("thing", async () => ({ value: "stale", ledger: 4000 })),
    ).rejects.toBeInstanceOf(MavnaError);
  });

  it("marks that failure retryable, because a caught-up node may answer next time", async () => {
    const client = clientForTest();
    client.observeWrite(5000);

    await client
      .read("thing", async () => ({ value: "stale", ledger: 4000 }))
      .catch((error) => {
        expect(error).toBeInstanceOf(MavnaError);
        expect((error as MavnaError).retryable).toBe(true);
      });
  });

  it("proof the guard is load-bearing: without it the stale answer would be returned", async () => {
    // This is the control. An unguarded read takes the first answer it gets, which
    // is exactly the bug the guard exists to prevent. If someone deletes the guard,
    // the test above starts returning "seen-at-990" and fails.
    const ledgers = [990, 995, 1001];
    let call = 0;
    const unguardedRead = async (): Promise<string> => {
      const ledger = ledgers[call++] ?? 1001;
      return `seen-at-${ledger}`;
    };

    expect(await unguardedRead()).toBe("seen-at-990");
  });

  it("raises the mark from a fresh read, so later reads cannot go backwards", async () => {
    const client = clientForTest();
    await client.read("first", async () => ({ value: 1, ledger: 700 }));
    expect(client.floor.value).toBe(700);

    await expect(client.read("second", async () => ({ value: 2, ledger: 699 }))).rejects.toThrow();
  });
});

describe("submission", () => {
  const passphrase = Networks.TESTNET;
  const source = Keypair.random();

  function presignedTx(validForSeconds: number): Transaction {
    const tx = new TransactionBuilder(new Account(source.publicKey(), "41"), {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "50" }))
      .setTimeout(validForSeconds)
      .build();
    tx.sign(source);
    return tx;
  }

  function rejectedWith(code: "txBadSeq"): rpc.Api.SendTransactionResponse {
    return {
      status: "ERROR",
      hash: "00",
      latestLedger: 1,
      latestLedgerCloseTime: 0,
      errorResult: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult[code](),
        ext: new xdr.TransactionResultExt(0),
      }),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up at once on a stale sequence when the envelope cannot be rebuilt", async () => {
    const client = clientForTest();
    let sent = 0;
    client.server.sendTransaction = async () => {
      sent += 1;
      return rejectedWith("txBadSeq");
    };

    const tx = presignedTx(300);
    const failure = await client
      .submit("settlement", async () => tx, { presigned: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmitRejected);
    expect((failure as SubmitRejected).code).toBe("txBadSeq");
    expect((failure as SubmitRejected).retryable).toBe(false);
    expect(sent).toBe(1);
  });

  it("still retries a stale sequence for a transaction it rebuilds", async () => {
    const client = clientForTest();
    let sent = 0;
    client.server.sendTransaction = async () => {
      sent += 1;
      return rejectedWith("txBadSeq");
    };

    const failure = await client
      .submit("delivery", async () => presignedTx(300), { attempts: 3 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
    expect(sent).toBe(3);
  });

  it("stops waiting for inclusion after the wait it was given, not the time bound", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now();
    const client = new RpcClient({
      url: "https://example.invalid",
      baseDelayMs: 1000,
      // each pause moves the clock, so the wait is measured in pretend seconds
      sleep: async (ms) => {
        vi.setSystemTime(Date.now() + ms);
      },
    });
    const tx = presignedTx(86_400);
    client.server.sendTransaction = async () => ({
      status: "PENDING",
      hash: tx.hash().toString("hex"),
      latestLedger: 1,
      latestLedgerCloseTime: 0,
    });
    client.server.getTransaction = async (hash) => ({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      txHash: hash,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    });

    const failure = await client
      .submit("settlement", async () => tx, { presigned: true, waitSeconds: 120 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
    expect((failure as MavnaError).message).toMatch(/may still land/);
    const waited = (Date.now() - started) / 1000;
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThan(130);
  });

  it("looks a transaction up only from a node that has caught up", async () => {
    const client = clientForTest();
    client.observeWrite(10);
    const heights = [9, 10];
    let asked = 0;
    client.server.getTransaction = async (hash) => ({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      txHash: hash,
      latestLedger: heights[asked++] ?? 10,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    });

    const found = await client.findTransaction("ab");
    expect(found.status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);
    expect(found.latestLedger).toBe(10);
    expect(asked).toBe(2);
  });
});

describe("loading an account", () => {
  it("says plainly when a caught-up node has no such account", async () => {
    const client = clientForTest();
    client.server.getLedgerEntries = async () => ({ latestLedger: 5, entries: [] });
    const missing = await client
      .loadAccount(Keypair.random().publicKey())
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AccountNotFound);
    expect((missing as AccountNotFound).retryable).toBe(false);
  });

  it("does not mistake a failed read for a missing account", async () => {
    const client = clientForTest();
    client.server.getLedgerEntries = async () => {
      throw new Error("connection reset");
    };
    const failure = await client
      .loadAccount(Keypair.random().publicKey())
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(AccountNotFound);
  });
});
