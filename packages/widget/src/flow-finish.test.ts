import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "./engine";

// the finish itself is own-compose's, tested there; this is what the flow does with it
const finished: string[] = [];
let priced = 0;
vi.mock("./own-compose", () => ({
  finishCompose: async () => {
    priced += 1;
    return {
      kind: "priced" as const,
      feeStroops: 2_070_159n,
      finish: async () => {
        finished.push("signed");
        return { kind: "composed" as const, txHash: "c0de", ledger: 7 };
      },
    };
  },
}));

const { Flow } = await import("./flow");

afterEach(() => {
  finished.length = 0;
  priced = 0;
});

describe("finishing an overdue conversion from Activity, paying it yourself", () => {
  it("shows the simulated cost first and signs only on the second press", async () => {
    const engine = {
      network: "testnet",
      defaultSourceChain: "arbitrum-sepolia",
      ranking: "best-received",
      historyKey: "test.transfers",
      sourceChainDetail: () => ({ kind: "other", name: "Somewhere", family: "move" }),
    } as unknown as Engine;
    const flow = new Flow({ engine });
    const compose = { contract: "C", from: "G", guid: "ab".repeat(32), index: 0, message: "0x01" };
    // setState applied at once, since nothing is mounted
    flow.setState = ((patch: object) => {
      flow.state = { ...flow.state, ...patch };
    }) as never;
    flow.state = {
      ...flow.state,
      found: { tone: "wait", note: "Overdue", canFinish: true, compose },
    };
    const onFind = vi.spyOn(flow, "onFind").mockResolvedValue();

    await flow.onFinish();
    expect(finished).toEqual([]);
    expect(flow.state.lookupNote).toMatch(/up to 0\.2070159 XLM.*again/);

    await flow.onFinish();
    expect(finished).toEqual(["signed"]);
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("forgets a priced finish once another transfer is looked up", async () => {
    const engine = {
      network: "testnet",
      defaultSourceChain: "arbitrum-sepolia",
      ranking: "best-received",
      historyKey: "test.transfers",
      sourceChainDetail: () => ({ kind: "other", name: "Somewhere", family: "move" }),
    } as unknown as Engine;
    const flow = new Flow({ engine });
    flow.setState = ((patch: object) => {
      flow.state = { ...flow.state, ...patch };
    }) as never;
    const compose = { contract: "C", from: "G", guid: "ab".repeat(32), index: 0, message: "0x01" };
    flow.state = {
      ...flow.state,
      found: { tone: "wait", note: "Overdue", canFinish: true, compose },
    };
    await flow.onFinish();
    expect(priced).toBe(1);
    // a different lookup: what was priced was for the transfer before it
    flow.state = { ...flow.state, lookup: "not a key" } as never;
    await flow.onFind();
    flow.state = {
      ...flow.state,
      found: {
        tone: "wait",
        note: "Overdue",
        canFinish: true,
        compose: { ...compose, guid: "cd".repeat(32) },
      },
    } as never;
    await flow.onFinish();
    expect(finished).toEqual([]);
    expect(priced).toBe(2);
  });
});

describe("pressing twice, or looking up twice", () => {
  const engine = {
    network: "testnet",
    defaultSourceChain: "arbitrum-sepolia",
    ranking: "best-received",
    historyKey: "test.transfers",
    sourceChainDetail: () => ({ kind: "other", name: "Somewhere", family: "move" }),
  } as unknown as Engine;

  it("asks for one delivery, however fast Finish is pressed again", async () => {
    let asked = 0;
    const flow = new Flow({
      engine: {
        ...engine,
        // the first thing finishing a delivery does is read who pays for it
        sponsorTerms: () => {
          asked += 1;
          return new Promise(() => {});
        },
        sourceDomain: () => 3,
      } as unknown as Engine,
    });
    flow.setState = ((patch: object) => {
      flow.state = { ...flow.state, ...patch };
    }) as never;
    const hash = `0x${"ab".repeat(32)}`;
    flow.state = {
      ...flow.state,
      lookup: hash,
      history: [
        {
          sourceTxHash: hash,
          sourceChainId: "arbitrum-sepolia",
          sourceChainName: "Arbitrum Sepolia",
          destination: "G",
          sendsBaseUnits: "1",
          symbol: "USDC",
          decimals: 6,
          startedAtUnix: 0,
          explorerUrl: undefined,
        },
      ],
    };
    void flow.onFinish();
    void flow.onFinish();
    await vi.waitFor(() => expect(asked).toBeGreaterThan(0));
    expect(asked).toBe(1);
  });

  it("keeps the newer lookup's answer when an older, slower one lands after it", async () => {
    const answers = new Map<string, (phase: unknown) => void>();
    const rail = {
      id: "layerzero",
      supportedChains: async () => [],
      status: (handle: { sourceTxHash: string }) =>
        new Promise((resolve) => answers.set(handle.sourceTxHash, resolve)),
    };
    const flow = new Flow({ engine: { ...engine, adapters: [rail] } as unknown as Engine });
    flow.setState = ((patch: object) => {
      flow.state = { ...flow.state, ...patch };
    }) as never;
    const older = `0x${"aa".repeat(32)}`;
    const newer = `0x${"bb".repeat(32)}`;
    flow.state = { ...flow.state, lookup: older };
    const first = flow.onFind();
    flow.state = { ...flow.state, lookup: newer };
    const second = flow.onFind();
    await vi.waitFor(() => expect(answers.size).toBe(2));
    answers.get(newer)?.({ phase: "failed", cause: "the newer one" });
    await second;
    answers.get(older)?.({ phase: "failed", cause: "the older one" });
    await first;
    expect(flow.state.found?.note).toMatch(/the newer one/);
  });
});
