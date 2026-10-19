import { describe, expect, it } from "vitest";
import { routeFor } from "./__fixtures__/scripted";
import type { MavnaWidgetEvent } from "./config";
import type { Engine } from "./engine";
import { Flow } from "./flow";
import { toRouteView } from "./quote";

// Only what the flow reads before a transfer reaches the network. start() and
// runTransfer() are the system under test; nothing here is mounted.
const engine = {
  defaultSourceChain: "arbitrum-sepolia",
  ranking: "best-received",
  historyKey: "test.transfers",
  sourceChainDetail: () => ({ kind: "other", name: "Somewhere", family: "move" }),
} as unknown as Engine;

function flowWithRoute(): { flow: Flow; started: () => number } {
  const events: MavnaWidgetEvent[] = [];
  const flow = new Flow({ engine, emit: (event) => events.push(event) });
  const view = toRouteView(routeFor("layerzero"));
  flow.state = { ...flow.state, routes: [view], selected: view.id };
  return { flow, started: () => events.filter((e) => e.type === "transferStarted").length };
}

describe("Flow.start", () => {
  it("starts one transfer however many times it is pressed", () => {
    const { flow, started } = flowWithRoute();
    flow.start();
    flow.start();
    flow.start();
    expect(started()).toBe(1);
  });

  it("can start again once the transfer before it has ended", async () => {
    const { flow, started } = flowWithRoute();
    flow.start();
    const view = flow.chosen();
    if (view === undefined) throw new Error("no route chosen");
    // a source family this page cannot sign for ends the transfer at once
    await flow.runTransfer(view, { kind: "other", name: "Somewhere", family: "move" });
    flow.start();
    expect(started()).toBe(2);
  });
});
