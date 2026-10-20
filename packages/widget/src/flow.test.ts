import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESTINATION, routeFor, STELLAR_USDC, STELLAR_XLM } from "./__fixtures__/scripted";
import type { MavnaWidgetEvent } from "./config";
import type { Engine } from "./engine";
import { Flow } from "./flow";
import { toRouteView } from "./quote";
import { renderFlight, renderReview } from "./screens";
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

// what the fixture route was quoted for
const FORM = { amount: "5", destination: DESTINATION, chainId: "arbitrum-sepolia" };

function flowWithRoute(): { flow: Flow; started: () => number } {
  const events: MavnaWidgetEvent[] = [];
  const flow = new Flow({ engine, emit: (event) => events.push(event) });
  const view = toRouteView(routeFor("layerzero"));
  flow.state = { ...flow.state, ...FORM, routes: [view], selected: view.id };
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
    flow.state = { ...flow.state, ...FORM, routes: [view], selected: view.id };
    flow.start();
    flow.setNetwork("mainnet");
    expect(asked).toEqual([]);
  });
});

const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

/** React only applies setState once mounted; this applies it at once so the
    flow's own handlers can be driven without a renderer. */
function applied(flow: Flow): Flow {
  flow.setState = ((patch: unknown, done?: () => void) => {
    const next =
      typeof patch === "function"
        ? (patch as (s: Flow["state"], p: Flow["props"]) => Partial<Flow["state"]>)(
            flow.state,
            flow.props,
          )
        : (patch as Partial<Flow["state"]>);
    flow.state = { ...flow.state, ...next };
    done?.();
  }) as Flow["setState"];
  return flow;
}

function quotedFlow(asked: { terms: number }, emit?: (event: MavnaWidgetEvent) => void): Flow {
  const quoting = {
    ...engine,
    usdcOnStellar: STELLAR_USDC,
    xlmOnStellar: STELLAR_XLM,
    adapters: [],
    // the sponsor is the first thing a quote asks, so counting it counts quotes
    sponsorTerms: () => {
      asked.terms += 1;
      return new Promise(() => {});
    },
  } as unknown as Engine;
  const flow = applied(new Flow({ engine: quoting, emit }));
  const view = toRouteView(routeFor("layerzero"));
  flow.state = {
    ...flow.state,
    amount: "5",
    destination: DESTINATION,
    chainId: "arbitrum-sepolia",
    routes: [view],
    selected: view.id,
  };
  return flow;
}

describe("Flow.setDestination", () => {
  afterEach(() => vi.useRealTimers());

  it("drops the routes quoted for the old recipient at once and quotes again", () => {
    vi.useFakeTimers();
    const asked = { terms: 0 };
    const flow = quotedFlow(asked);
    flow.setDestination(OTHER);
    expect(flow.state.destination).toBe(OTHER);
    expect(flow.state.routes).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(asked.terms).toBe(1);
  });
});

describe("Flow.start against the form", () => {
  it("refuses a route quoted for another recipient", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = quotedFlow({ terms: 0 }, (event) => events.push(event));
    flow.state = { ...flow.state, destination: OTHER };
    flow.start();
    expect(events.filter((e) => e.type === "transferStarted")).toEqual([]);
    expect(flow.state.phase).toBe("quote");
  });

  it("refuses a route quoted for another amount", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = quotedFlow({ terms: 0 }, (event) => events.push(event));
    flow.state = { ...flow.state, amount: "100" };
    flow.start();
    expect(events.filter((e) => e.type === "transferStarted")).toEqual([]);
  });

  it("refuses a route quoted from another chain", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = quotedFlow({ terms: 0 }, (event) => events.push(event));
    flow.state = { ...flow.state, chainId: "base-sepolia" };
    flow.start();
    expect(events.filter((e) => e.type === "transferStarted")).toEqual([]);
  });

  it("starts a route quoted for exactly what the form holds", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = quotedFlow({ terms: 0 }, (event) => events.push(event));
    flow.start();
    expect(events.filter((e) => e.type === "transferStarted")).toHaveLength(1);
  });
});

describe("review and flight", () => {
  it("show the recipient, amount and chain the route will sign for, not the form", () => {
    const flow = quotedFlow({ terms: 0 });
    flow.state = { ...flow.state, destination: OTHER, amount: "100", chainId: "base-sepolia" };
    const r = flow.chosen();
    const d = { r, chain: { id: "base-sepolia", name: "Base Sepolia" }, sym: "USDC" };
    for (const html of [
      renderToStaticMarkup(renderReview(flow, d)),
      renderToStaticMarkup(renderFlight(flow, { ...d, arrived: false })),
    ]) {
      expect(html).toContain("GBZXN…MADI");
      expect(html).not.toContain("GBRPY…OX2H");
      expect(html).toContain("5.00 USDC");
      expect(html).not.toContain("100.00");
      expect(html).toContain("Arbitrum Sepolia");
      expect(html).not.toContain("Base Sepolia");
    }
  });
});

describe("Flow.setAmount", () => {
  afterEach(() => vi.useRealTimers());

  it("drops the routes quoted for the old amount at once and quotes again", () => {
    vi.useFakeTimers();
    const asked = { terms: 0 };
    const flow = quotedFlow(asked);
    flow.setAmount("100");
    expect(flow.state.amount).toBe("100");
    expect(flow.state.routes).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(asked.terms).toBe(1);
  });
});

describe("while a transfer runs", () => {
  it("does not leave the flight for the form, and does not quote over it", () => {
    vi.useFakeTimers();
    try {
      const asked = { terms: 0 };
      const flow = quotedFlow(asked);
      flow.start();
      vi.advanceTimersByTime(1);
      expect(flow.state.screen).toBe("flight");
      const steps = flow.state.steps;
      flow.go("send", "pop");
      flow.runQuote();
      expect(flow.state.screen).toBe("flight");
      expect(flow.state.steps).toBe(steps);
      expect(flow.state.phase).toBe("sending");
      expect(asked.terms).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
