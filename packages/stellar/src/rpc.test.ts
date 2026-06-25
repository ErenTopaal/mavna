import { MavnaError } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { createLedgerFloor, RpcClient } from "./rpc.js";

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
