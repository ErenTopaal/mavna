import { describe, expect, it } from "vitest";
import { routeFor } from "./__fixtures__/scripted";
import type { MavnaWidgetEvent } from "./config";
import type { Engine } from "./engine";
import { Flow } from "./flow";
import { toRouteView } from "./quote";
import { DeliveredAsCame, StillMoving } from "./transfer";

// Only what the flow reads before a transfer reaches the network. start() and
// runTransfer() are the system under test; nothing here is mounted.
const engine = {
  network: "testnet",
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

describe("Flow.endWith", () => {
  it("tells the host a transfer it stopped watching is still moving, not that it failed", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = new Flow({ engine, emit: (event) => events.push(event) });
    flow.endWith(new StillMoving("Taking longer than this page waits."));
    expect(events).toEqual([
      { type: "transferStillMoving", reason: "Taking longer than this page waits." },
    ]);
  });

  it("tells the host a conversion delivered as it came apart from a failure, with what arrived", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = new Flow({ engine, emit: (event) => events.push(event) });
    flow.endWith(new DeliveredAsCame("USDT0 arrived as it came.", "USDT0", "5000000"));
    expect(events).toEqual([
      {
        type: "transferDeliveredAsCame",
        reason: "USDT0 arrived as it came.",
        asset: "USDT0",
        baseUnits: "5000000",
      },
    ]);
  });

  it("tells the host anything else failed", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = new Flow({ engine, emit: (event) => events.push(event) });
    flow.endWith(new Error("The network refused it."));
    expect(events).toEqual([{ type: "transferFailed", reason: "The network refused it." }]);
  });
});

describe("Flow.setNetwork", () => {
  it("asks the host to switch to a network it offers", () => {
    const asked: string[] = [];
    const flow = new Flow({
      engine,
      networks: ["testnet", "mainnet"],
      onNetworkChange: (network) => asked.push(network),
    });
    flow.setNetwork("mainnet");
    expect(asked).toEqual(["mainnet"]);
  });

  it("does nothing for a network it does not offer, or the one it is on", () => {
    const asked: string[] = [];
    const flow = new Flow({ engine, onNetworkChange: (network) => asked.push(network) });
    flow.setNetwork("mainnet");
    flow.setNetwork("testnet");
    expect(asked).toEqual([]);
  });

  it("does not switch while a transfer is running", () => {
    const asked: string[] = [];
    const flow = new Flow({
      engine,
      networks: ["testnet", "mainnet"],
      onNetworkChange: (network) => asked.push(network),
    });
    const view = toRouteView(routeFor("layerzero"));
    flow.state = { ...flow.state, routes: [view], selected: view.id };
    flow.start();
    flow.setNetwork("mainnet");
    expect(asked).toEqual([]);
  });
});
