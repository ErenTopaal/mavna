import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MavnaError } from "@mavna/core";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  SorobanDataBuilder,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountNotFound,
  createLedgerFloor,
  InclusionUnknown,
  RpcClient,
  SubmitExhausted,
  SubmitRejected,
} from "./rpc.js";

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
        ext: xdr.TransactionResultExt.v0(),
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
    // refused at the door every time, so nothing was ever included or charged
    expect(failure).toBeInstanceOf(SubmitExhausted);
    expect((failure as SubmitExhausted).code).toBe("stale-sequence");
  });

  it("does not call it a stale sequence when the node was only busy", async () => {
    const client = clientForTest();
    let sent = 0;
    client.server.sendTransaction = async () => {
      sent += 1;
      return sent === 1
        ? { status: "TRY_AGAIN_LATER", hash: "00", latestLedger: 1, latestLedgerCloseTime: 0 }
        : rejectedWith("txBadSeq");
    };
    const failure = await client
      .submit("delivery", async () => presignedTx(300), { attempts: 3 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmitExhausted);
    expect((failure as SubmitExhausted).code).toBe("exhausted");
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
      hash: xdr.encodeBytes(tx.hash(), "hex"),
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

/** What the SDK's HTTP client throws when a request runs past its timeout. */
function timedOut(): Error {
  return Object.assign(new Error("timeout of 15000 ms exceeded"), {
    name: "AxiosError",
    code: "ECONNABORTED",
  });
}

function pendingTx(hash: string): rpc.Api.SendTransactionResponse {
  return { status: "PENDING", hash, latestLedger: 1, latestLedgerCloseTime: 0 };
}

function missing(
  hash: string,
  latestLedger: number,
  latestLedgerCloseTime: number,
): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash: hash,
    latestLedger,
    latestLedgerCloseTime,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
  };
}

function landed(hash: string, ledger: number): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: hash,
    ledger,
    createdAt: 0,
    applicationOrder: 1,
    feeBump: false,
    latestLedger: ledger,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
  } as unknown as rpc.Api.GetTransactionResponse;
}

/** A client whose sleeps move a fake clock, so waits are measured in pretend seconds. */
function clockedClient(options: { baseDelayMs?: number } = {}): RpcClient {
  vi.useFakeTimers({ toFake: ["Date"] });
  return new RpcClient({
    url: "https://example.invalid",
    baseDelayMs: options.baseDelayMs ?? 1000,
    sleep: async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
  });
}

function txValidFor(seconds: number): Transaction {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "50" }))
    .setTimeout(seconds)
    .build();
  tx.sign(source);
  return tx;
}

describe("request timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds every request, since the SDK's own timeout option is ignored", () => {
    expect(clientForTest().server.httpClient.defaults.timeout).toBe(15_000);
    const client = new RpcClient({ url: "https://example.invalid", timeoutMs: 2_000 });
    expect(client.server.httpClient.defaults.timeout).toBe(2_000);
  });

  it("retries a read that timed out", async () => {
    const client = clientForTest();
    let calls = 0;
    const value = await client.read("thing", async () => {
      calls += 1;
      if (calls === 1) throw timedOut();
      return { value: "answer", ledger: 5 };
    });
    expect(value).toBe("answer");
    expect(calls).toBe(2);
  });

  it("calls a read that keeps timing out retryable", async () => {
    const client = clientForTest();
    const failure = await client
      .read("thing", async () => {
        throw timedOut();
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
    expect((failure as MavnaError).cause).toBeInstanceOf(Error);
  });

  it("does not retry a read that failed for another reason", async () => {
    const client = clientForTest();
    let calls = 0;
    const failure = await client
      .read("thing", async () => {
        calls += 1;
        throw new Error("bad request");
      })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("bad request");
    expect(calls).toBe(1);
  });

  it("looks for a send that timed out by its hash instead of building another", async () => {
    const client = clientForTest();
    const tx = txValidFor(300);
    const hash = xdr.encodeBytes(tx.hash(), "hex");
    let built = 0;
    client.server.sendTransaction = async () => {
      throw timedOut();
    };
    client.server.getTransaction = async (h) => landed(h, 42);
    const result = await client.submit("delivery", async () => {
      built += 1;
      return tx;
    });
    expect(result.txHash).toBe(hash);
    expect(built).toBe(1);
  });

  it("keeps waiting through a lookup that timed out", async () => {
    const client = clientForTest();
    const tx = txValidFor(300);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      if (asked === 1) throw timedOut();
      return landed(h, 7);
    };
    const result = await client.submit("delivery", async () => tx);
    expect(result.ledger).toBe(7);
  });
});

describe("deciding a transaction expired", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting while the ledger has not closed past the time bound, whatever the local clock says", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const maxTime = Number(tx.timeBounds?.maxTime);
    // the local clock runs two minutes ahead of the network
    vi.setSystemTime((maxTime + 120) * 1000);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      return asked < 3 ? missing(h, 10, maxTime - 5) : landed(h, 11);
    };
    const result = await client.submit("delivery", async () => tx);
    expect(result.ledger).toBe(11);
  });

  it("concludes it expired once a caught-up node has closed a ledger past the bound", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const maxTime = Number(tx.timeBounds?.maxTime);
    client.observeWrite(10);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    client.server.getTransaction = async (h) => missing(h, 12, maxTime + 1);
    const failure = await client
      .submit("delivery", async () => tx, { attempts: 1 })
      .catch((error: unknown) => error);
    expect((failure as MavnaError).message).toMatch(/not included before it expired/);
    expect((failure as MavnaError).retryable).toBe(true);
  });

  it("does not believe an expiry from a node behind the high-water mark", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const maxTime = Number(tx.timeBounds?.maxTime);
    client.observeWrite(20);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      return asked === 1 ? missing(h, 12, maxTime + 1) : landed(h, 21);
    };
    const result = await client.submit("delivery", async () => tx);
    expect(result.ledger).toBe(21);
  });

  it("says a transaction it rebuilds may still land, and not to retry, when nodes never say", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const maxTime = Number(tx.timeBounds?.maxTime);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    // a node stuck before the bound, for good
    client.server.getTransaction = async (h) => missing(h, 10, maxTime - 30);
    const failure = await client
      .submit("delivery", async () => tx)
      .catch((error: unknown) => error);
    expect((failure as MavnaError).message).toMatch(/may still land/);
    expect((failure as MavnaError).retryable).toBe(false);
  });

  it("waits on a hash until the ledger says its time bound has passed", async () => {
    const client = clockedClient();
    const maxTime = Math.floor(Date.now() / 1000) + 30;
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      return missing(h, 10, asked < 4 ? maxTime : maxTime + 5);
    };
    const failure = await client.waitForTransaction("ab", maxTime).catch((e: unknown) => e);
    expect((failure as MavnaError).message).toMatch(/not included before it expired/);
    expect(asked).toBe(4);
  });
});

describe("waiting for an account", () => {
  it("gives up at once on an error that is not about the account being absent", async () => {
    const client = clientForTest();
    let calls = 0;
    client.server.getLedgerEntries = async () => {
      calls += 1;
      throw new Error("bad request");
    };
    const failure = await client
      .waitForAccount(Keypair.random().publicKey())
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("bad request");
    expect(calls).toBe(1);
  });

  it("keeps the last reason when the account never appears", async () => {
    const client = clientForTest();
    client.server.getLedgerEntries = async () => ({ latestLedger: 5, entries: [] });
    const failure = await client
      .waitForAccount(Keypair.random().publicKey(), 3)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).message).toMatch(/never appeared/);
    expect((failure as MavnaError).cause).toBeInstanceOf(AccountNotFound);
  });
});

describe("preparing a contract call", () => {
  function simulated(latestLedger: number, fee: string): rpc.Api.SimulateTransactionResponse {
    return {
      id: "1",
      latestLedger,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder().setResourceFee(fee),
      minResourceFee: fee,
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    } as rpc.Api.SimulateTransactionSuccessResponse;
  }

  it("uses only a simulation from a node at or past the high-water mark", async () => {
    const client = clientForTest();
    client.observeWrite(100);
    const answers = [simulated(90, "999"), simulated(100, "123")];
    let asked = 0;
    client.server.simulateTransaction = async () => answers[asked++] ?? simulated(100, "123");

    const call = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC").call("decimals"),
      )
      .setTimeout(30)
      .build();
    const prepared = await client.prepare(call);

    expect(asked).toBe(2);
    const envelope = xdr.expectUnionVariant(prepared.toEnvelope(), "envelopeTypeTx");
    const data = xdr.expectUnionVariant(envelope.v1.tx.ext, "sorobanData").sorobanData;
    expect(data.resourceFee.toString()).toBe("123");
  });

  it("surfaces a simulation that failed", async () => {
    const client = clientForTest();
    client.server.simulateTransaction = async () =>
      ({ id: "1", latestLedger: 5, events: [], _parsed: true, error: "boom" }) as never;
    const call = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC").call("decimals"),
      )
      .setTimeout(30)
      .build();
    await expect(client.prepare(call)).rejects.toThrow("boom");
  });
});

/** What a dropped connection looks like from the SDK's HTTP client. */
function dropped(): Error {
  return Object.assign(new Error("socket hang up"), { name: "AxiosError", code: "ECONNRESET" });
}

describe("a connection that drops while waiting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting, since the transaction may land all the same", async () => {
    const client = clientForTest();
    const tx = txValidFor(300);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      if (asked < 3) throw dropped();
      return landed(h, 9);
    };
    const result = await client.submit("delivery", async () => tx);
    expect(result.ledger).toBe(9);
  });

  it("says which transaction may still land when the node never comes back", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const hash = xdr.encodeBytes(tx.hash(), "hex");
    client.server.sendTransaction = async () => pendingTx(hash);
    client.server.getTransaction = async () => {
      throw dropped();
    };
    const failure = await client
      .submit("delivery", async () => tx)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InclusionUnknown);
    expect((failure as InclusionUnknown).hash).toBe(hash);
    expect((failure as InclusionUnknown).message).toContain(hash);
    expect((failure as InclusionUnknown).message).toMatch(/may still land/);
    // a rebuilt transaction would be a second one beside it
    expect((failure as InclusionUnknown).retryable).toBe(false);
    expect((failure as InclusionUnknown).cause).toBeInstanceOf(Error);
  });

  it("lets a presigned envelope be resent, which cannot act twice", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    client.server.getTransaction = async () => {
      throw dropped();
    };
    const failure = await client
      .submit("settlement", async () => tx, { presigned: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InclusionUnknown);
    expect((failure as InclusionUnknown).retryable).toBe(true);
  });

  it("keeps the hash when waiting on one directly", async () => {
    const client = clockedClient();
    const maxTime = Math.floor(Date.now() / 1000) + 30;
    client.server.getTransaction = async () => {
      throw dropped();
    };
    const failure = await client.waitForTransaction("ab", maxTime).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(InclusionUnknown);
    expect((failure as InclusionUnknown).hash).toBe("ab");
  });
});

describe("the ledger's close time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is read as a number when the node sends it as a string, as the live endpoint does", async () => {
    const client = clockedClient();
    const tx = txValidFor(60);
    const maxTime = Number(tx.timeBounds?.maxTime);
    client.server.sendTransaction = async () => pendingTx(xdr.encodeBytes(tx.hash(), "hex"));
    // first a ledger one second short of the bound, then one past it
    let asked = 0;
    client.server.getTransaction = async (h) => {
      asked += 1;
      return {
        ...missing(h, 12, 0),
        latestLedgerCloseTime: String(asked === 1 ? maxTime - 1 : maxTime + 1),
      } as never;
    };
    const failure = await client
      .submit("delivery", async () => tx, { attempts: 1 })
      .catch((error: unknown) => error);
    expect((failure as MavnaError).message).toMatch(/not included before it expired/);
    expect(asked).toBe(2);
  });
});

describe("a node that never answers", () => {
  it("is given up on at the configured timeout", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new RpcClient({
        url: `http://127.0.0.1:${port}`,
        allowHttp: true,
        timeoutMs: 300,
      });
      const started = Date.now();
      const failure = await client.server.getLatestLedger().catch((error: unknown) => error);
      const waited = Date.now() - started;
      expect((failure as { code?: string }).code).toBe("ECONNABORTED");
      expect(waited).toBeGreaterThanOrEqual(280);
      expect(waited).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("plain http", () => {
  it("is refused by default", () => {
    expect(() => new RpcClient({ url: "http://127.0.0.1:8000" })).toThrow(/insecure/);
  });

  it("is allowed only for this machine, even when asked for", () => {
    for (const url of ["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"]) {
      expect(() => new RpcClient({ url, allowHttp: true })).not.toThrow();
    }
    for (const url of [
      "http://soroban-testnet.stellar.org",
      "http://10.0.0.5:8000",
      "http://localhost.example.com",
      "http://127.0.0.1.nip.io",
    ]) {
      expect(() => new RpcClient({ url, allowHttp: true })).toThrow(MavnaError);
    }
  });
});
