import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "./engine";

// the finish itself is own-compose's, tested there; this is what the flow does with it
const finished: string[] = [];
let priced = 0;
vi.mock("./own-compose", () => ({
  finishCompose: async () => ({
    kind: "priced" as const,
    feeStroops: BigInt(2_070_159 + 0 * ++priced),
    finish: async () => {
      finished.push("signed");
      return { kind: "composed" as const, txHash: "c0de", ledger: 7 };
    },
  }),
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
      found: { tone: "warn", note: "Overdue", canFinish: true, compose },
    } as never;
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
      found: { tone: "warn", note: "Overdue", canFinish: true, compose },
    } as never;
    await flow.onFinish();
    expect(priced).toBe(1);
    // a different lookup: what was priced was for the transfer before it
    flow.state = { ...flow.state, lookup: "not a key" } as never;
    await flow.onFind();
    flow.state = {
      ...flow.state,
      found: {
        tone: "warn",
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
