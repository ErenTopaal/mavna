import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESTINATION,
  routeFor,
  SOURCE_USDC,
  STELLAR_USDC,
  STELLAR_XLM,
} from "./__fixtures__/scripted";
import type { MavnaWidgetEvent } from "./config";
import type { Engine } from "./engine";
import { Flow } from "./flow";
import { toRouteView } from "./quote";
import {
  renderChains,
  renderFlight,
  renderReview,
  renderRoutes,
  renderSend,
  routeDetail,
} from "./screens";
import { DeliveredAsCame, DeliveredUnverified, StillMoving } from "./transfer";

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
    // that quote is spent; a fresh one for the same transfer can be started
    const fresh = toRouteView(routeFor("layerzero"));
    flow.state = { ...flow.state, routes: [fresh], selected: fresh.id };
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
    flow.endWith(new DeliveredAsCame("USDT0 arrived as it came.", "USDT0", "5000000", 7));
    expect(events).toEqual([
      {
        type: "transferDeliveredAsCame",
        reason: "USDT0 arrived as it came.",
        asset: "USDT0",
        baseUnits: "5000000",
      },
    ]);
  });

  it("tells the host a delivery it could not prove has ended, with the transaction to check", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = new Flow({ engine, emit: (event) => events.push(event) });
    flow.endWith(
      new DeliveredUnverified(
        "The rail's record no longer says what arrived.",
        "f00d",
        "https://stellar.expert/explorer/testnet/tx/f00d",
      ),
    );
    expect(events).toEqual([
      {
        type: "transferDeliveredUnverified",
        reason: "The rail's record no longer says what arrived.",
        stellarTxHash: "f00d",
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/f00d",
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

/** An Escape keydown from a target, remembering whether it was marked used. */
function escapeKey(target: unknown): KeyboardEvent {
  const e = {
    key: "Escape",
    target,
    defaultPrevented: false,
    preventDefault: () => {
      e.defaultPrevented = true;
    },
  };
  return e as unknown as KeyboardEvent;
}

function quotedFlow(asked: { terms: number }, emit?: (event: MavnaWidgetEvent) => void): Flow {
  const quoting = {
    ...engine,
    usdcOnStellar: STELLAR_USDC,
    xlmOnStellar: STELLAR_XLM,
    adapters: [],
    sourceChains: [],
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

  it("asks no rail once the recipient is cleared, and the panel waits for one instead", () => {
    vi.useFakeTimers();
    const asked = { terms: 0 };
    const flow = quotedFlow(asked);
    flow.state = { ...flow.state, showDeclined: true };
    flow.setDestination("");
    vi.advanceTimersByTime(500);
    expect(asked.terms).toBe(0);
    expect(flow.state.quoting).toBe(false);
    expect(flow.state.rejected).toEqual([]);
    expect(flow.resting()).toBe("recipient");
    const html = renderToStaticMarkup(renderRoutes(flow, { sym: "USDC", resting: flow.resting() }));
    expect(html).toContain("Awaiting a recipient");
    expect(html).toContain("Set a recipient to compare.");
    expect(html).not.toContain("Declined");
    expect(html).not.toContain("Enter an amount");
  });

  it("keeps waiting on the amount when neither is given yet", () => {
    const flow = quotedFlow({ terms: 0 });
    flow.state = { ...flow.state, amount: "", destination: "" };
    expect(flow.resting()).toBe("amount");
    flow.state = { ...flow.state, amount: "5", destination: DESTINATION };
    expect(flow.resting()).toBeUndefined();
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

describe("Flow.props.onTransferChange", () => {
  it("tells the host when a transfer starts and when it has ended", async () => {
    const told: boolean[] = [];
    const flow = new Flow({ engine, onTransferChange: (running) => told.push(running) });
    const view = toRouteView(routeFor("layerzero"));
    flow.state = { ...flow.state, ...FORM, routes: [view], selected: view.id };
    flow.start();
    await flow.runTransfer(view, { kind: "other", name: "Somewhere", family: "move" });
    expect(told).toEqual([true, false]);
  });
});

describe("the host page around the widget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is not animated on mount: only the widget's own parts are", () => {
    const flow = new Flow({ engine });
    const own = [{ own: 1 }];
    const animated: unknown[] = [];
    vi.stubGlobal("document", {
      querySelectorAll: () => [{ host: "header" }],
    });
    flow.m = { animate: (nodes: unknown) => animated.push(nodes), stagger: () => 0 } as never;
    flow.reduced = false;
    (flow.rootRef as { current: unknown }).current = { querySelectorAll: () => own };
    flow.entrance();
    expect(animated).toEqual([own]);
  });

  it("does not take an Escape pressed elsewhere on the page as going back", () => {
    const flow = applied(new Flow({ engine }));
    flow.state = { ...flow.state, screen: "chains", cameFrom: "send" };
    const inside = {};
    (flow.rootRef as { current: unknown }).current = { contains: (n: unknown) => n === inside };
    flow.handleKey(escapeKey({}));
    expect(flow.state.screen).toBe("chains");
    flow.handleKey(escapeKey(inside));
    expect(flow.state.screen).toBe("send");
  });

  it("marks an Escape it used, so a drawer around it stays open", () => {
    const flow = applied(new Flow({ engine }));
    const inside = {};
    (flow.rootRef as { current: unknown }).current = { contains: (n: unknown) => n === inside };
    flow.state = { ...flow.state, screen: "chains", cameFrom: "send" };
    const back = escapeKey(inside);
    flow.handleKey(back);
    expect(back.defaultPrevented).toBe(true);
    flow.state = { ...flow.state, screen: "send", walletOpen: true };
    const wallet = escapeKey(inside);
    flow.handleKey(wallet);
    expect(wallet.defaultPrevented).toBe(true);
    // on the form with nothing open there is nothing for it to do: the drawer closes
    flow.state = { ...flow.state, screen: "send", walletOpen: false, menuOpen: false };
    const left = escapeKey(inside);
    flow.handleKey(left);
    expect(left.defaultPrevented).toBe(false);
  });
});

describe("an integrator fee on a route", () => {
  it("is shown on review as its own line, with who receives it", () => {
    const base = routeFor("layerzero");
    const route = {
      ...base,
      fees: [
        {
          kind: "integrator" as const,
          total: { asset: STELLAR_XLM, baseUnits: "2500000" },
          recipients: [
            {
              name: "Acme Wallet",
              amount: { asset: STELLAR_XLM, baseUnits: "2500000" },
              address: DESTINATION,
            },
          ],
          includedInQuote: true,
        },
      ],
    };
    const view = toRouteView(route);
    expect(view.integratorFee).toEqual({ amount: 0.25, symbol: "XLM", recipient: "Acme Wallet" });
    const flow = quotedFlow({ terms: 0 });
    const html = renderToStaticMarkup(
      renderReview(flow, { r: view, chain: { id: "x", name: "X" }, sym: "XLM" }),
    );
    expect(html).toContain("Integrator fee");
    expect(html).toContain("0.25 XLM to Acme Wallet");
  });
});

describe("fees and rates on a route", () => {
  const ETH = {
    chainId: "arbitrum-sepolia",
    id: "native",
    symbol: "ETH",
    decimals: 18,
    curatedBy: "Ethereum",
  };
  const withFee = (asset: typeof ETH | typeof SOURCE_USDC, baseUnits: string) => {
    const base = routeFor("layerzero", { swap: true, delivers: STELLAR_XLM });
    return toRouteView({
      ...base,
      fees: [
        {
          kind: "bridge" as const,
          total: { asset, baseUnits },
          recipients: [],
          includedInQuote: false,
        },
      ],
    });
  };

  it("shows a small native fee in its own decimals, not as 0.00", () => {
    expect(withFee(ETH, "300000000000000").feeAmount).toBe("0.0003");
    expect(withFee(SOURCE_USDC, "250000").feeAmount).toBe("0.25");
  });

  it("prices the rate per unit sent, without taking a fee paid in another asset off it", () => {
    // 5 sent, 5 XLM received (fixture), the fee is gas in ETH
    const rows = routeDetail(withFee(ETH, "300000000000000"), "XLM", true);
    expect(rows.find((r) => r.key === "rate")?.value).toBe("1 USDC ≈ 1.0000 XLM");
  });

  it("names the asset actually sent in the rate", () => {
    const view = withFee(SOURCE_USDC, "0");
    const usdt0 = {
      ...view,
      route: {
        ...view.route,
        sends: { ...view.route.sends, asset: { ...SOURCE_USDC, symbol: "USDT0" } },
      },
    };
    expect(routeDetail(usdt0, "XLM", true).find((r) => r.key === "rate")?.value).toMatch(
      /^1 USDT0 ≈/,
    );
  });
});

describe("an arrival that stayed as it came", () => {
  it("is headlined with what arrived, not the conversion it did not get", () => {
    const events: MavnaWidgetEvent[] = [];
    const flow = applied(new Flow({ engine, emit: (event) => events.push(event) }));
    const view = toRouteView(routeFor("layerzero", { swap: true, delivers: STELLAR_XLM }));
    flow.state = { ...flow.state, ...FORM, routes: [view], selected: view.id };
    flow.endWith(new DeliveredAsCame("Not converted.", "USDC", "40000000", 7));
    expect(events.map((e) => e.type)).toEqual(["transferDeliveredAsCame"]);
    const html = renderToStaticMarkup(
      renderFlight(flow, { r: view, chain: { id: "x", name: "X" }, sym: "XLM", arrived: true }),
    );
    expect(html).toContain("Arrived on Stellar, not converted");
    expect(html).toContain("4.00");
    expect(html).toContain("USDC");
  });
});

describe("what the user wants to receive", () => {
  it("follows the configured wanted on a USDT0 send", () => {
    const flow = new Flow({ engine, init: { send: "USDT0", wanted: "XLM" } });
    expect(flow.state.wanted).toBe("XLM");
    expect(new Flow({ engine, init: { send: "USDT0" } }).state.wanted).toBe("USDT0");
  });

  it("is kept when the sent asset changes and can still deliver it", () => {
    const flow = applied(
      new Flow({
        engine: {
          ...engine,
          usdt0Chains: [{ id: "arbitrum-sepolia", name: "Arbitrum Sepolia" }],
          sourceChains: [{ id: "arbitrum-sepolia", name: "Arbitrum Sepolia" }],
        } as unknown as Engine,
        init: { wanted: "XLM" },
      }),
    );
    // nothing to send and no wallet, so the quote and balance it asks for end at once
    flow.setSend("USDT0");
    expect(flow.state.wanted).toBe("XLM");
    flow.state = { ...flow.state, wanted: "USDT0" };
    flow.setSend("USDC");
    expect(flow.state.wanted).toBe("USDC");
    // the receive side follows a plain switch: USDT0 lands as USDT0
    flow.setSend("USDT0");
    expect(flow.state.wanted).toBe("USDT0");
  });
});

describe("the NEAR Intents trust line", () => {
  it("names the HOT Bridge that pays out on Stellar, not only the solvers", () => {
    expect(toRouteView(routeFor("near-intents")).trust).toMatch(/HOT Bridge/);
  });
});

describe("the chain picker on a USDT0 send", () => {
  it("counts the chains it lists, not the USDC ones", () => {
    const chains = new Flow({
      engine: {
        ...engine,
        sourceChains: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
          { id: "c", name: "C" },
        ],
        usdt0Chains: [{ id: "a", name: "A" }],
      } as unknown as Engine,
      init: { send: "USDT0", chainId: "a" },
    });
    chains.state = { ...chains.state, chainQuery: "zzz" };
    const html = renderToStaticMarkup(renderChains(chains));
    expect(html).toContain("sends from 1 chain.");
    expect(html).not.toContain("3 chains");
  });
});

describe("what a screen reader hears", () => {
  it("is told the step the flight is on, and what it says", () => {
    const flow = quotedFlow({ terms: 0 });
    flow.state = {
      ...flow.state,
      phase: "sending",
      steps: [
        {
          id: "burn",
          label: "Send from Arbitrum",
          user: true,
          actor: "Your wallet",
          phase: "failed",
          note: "The network refused it.",
        },
      ],
    };
    const html = renderToStaticMarkup(
      renderFlight(flow, {
        r: flow.chosen(),
        chain: { id: "x", name: "X" },
        sym: "USDC",
        arrived: false,
      }),
    );
    expect(html).toMatch(/role="status"[^>]*>[^<]*Send from Arbitrum[^<]*The network refused it\./);
  });
});

describe("Flow.props.onAwaitingUser", () => {
  it("says when a step waits on the user's wallet, and when it no longer does", () => {
    const told: boolean[] = [];
    const flow = applied(new Flow({ engine, onAwaitingUser: (waiting) => told.push(waiting) }));
    flow.state = {
      ...flow.state,
      steps: [{ id: "burn", label: "Send", user: true, actor: "Your wallet", phase: "idle" }],
    };
    flow.setStep("burn", { phase: "blocked" });
    flow.setStep("burn", { phase: "pending" });
    flow.setStep("burn", { phase: "done" });
    expect(told).toEqual([true, false]);
  });
});

describe("how many wallet approvals a route says", () => {
  it("says up to, when an approval may be skipped on any rail", () => {
    expect(toRouteView(routeFor("cctp", { approve: true })).sigsUpTo).toBe(true);
    expect(toRouteView(routeFor("axelar")).sigsUpTo).toBe(false);
  });
});

describe("the header's Stellar address", () => {
  it("follows the wallet: a forgotten or switched account does not stay on screen", async () => {
    let tell: ((address: string | undefined) => void) | undefined;
    const flow = applied(
      new Flow({
        engine: {
          ...engine,
          stellar: {
            connect: async () => "GOLD",
            sign: async (x: string) => x,
            disconnect: async () => {},
            onChange: (listener: (a: string | undefined) => void) => {
              tell = listener;
              return () => {};
            },
          },
        } as unknown as Engine,
      }),
    );
    flow.followStellar();
    flow.state = { ...flow.state, stellarAddress: "GOLD" };
    tell?.("GNEW");
    expect(flow.state.stellarAddress).toBe("GNEW");
    tell?.(undefined);
    expect(flow.state.stellarAddress).toBeNull();
  });
});

describe("a transfer that ended without arriving", () => {
  const endings: Array<[string, () => Error]> = [
    ["failed", () => new Error("The network refused it.")],
    ["still moving", () => new StillMoving("This page stopped watching.")],
    [
      "delivered, unproven",
      () =>
        new DeliveredUnverified(
          "The rail's record no longer says what arrived.",
          "f00d",
          "https://stellar.expert/explorer/testnet/tx/f00d",
        ),
    ],
  ];

  const ended = (variant: "wide" | "compact", ending: () => Error) => {
    const quoting = {
      ...engine,
      usdcOnStellar: STELLAR_USDC,
      xlmOnStellar: STELLAR_XLM,
      adapters: [],
      sourceChains: [{ id: "arbitrum-sepolia", name: "Arbitrum Sepolia" }],
      usdt0Chains: [],
      // the sponsor cannot be asked, which a quote turns into declines and finishes
      sponsorTerms: () => Promise.reject(new Error("The sponsor is down.")),
      xlmStroopsPerUsdc: async () => 100_000_000n,
    } as unknown as Engine;
    const flow = applied(new Flow({ engine: quoting, variant }));
    const view = toRouteView(routeFor("layerzero"));
    flow.state = {
      ...flow.state,
      ...FORM,
      routes: [view],
      selected: view.id,
      screen: "flight",
      phase: "sending",
      steps: [{ id: "burn", label: "Send", user: true, actor: "Your wallet", phase: "pending" }],
    };
    flow.endWith(ending());
    return flow;
  };

  for (const variant of ["wide", "compact"] as const) {
    for (const [name, ending] of endings) {
      it(`${name}, ${variant}: offers a way back, and a new quote then resolves`, async () => {
        const flow = ended(variant, ending);
        const html = renderToStaticMarkup(flow.render() as React.ReactElement);
        expect(html).toContain("Send another");
        expect(html).toContain('aria-label="Back"');
        flow.sendAnother();
        expect(flow.state.screen).toBe("send");
        expect(flow.state.phase).toBe("quote");
        await vi.waitFor(() => expect(flow.state.quoting).toBe(false));
        expect(flow.state.complete).toBe(true);
      });
    }
  }

  it("lets a new amount quote after an ending, and Escape go back from the flight", async () => {
    vi.useFakeTimers();
    try {
      const flow = ended("compact", endings[0]?.[1] ?? (() => new Error("x")));
      flow.state = { ...flow.state, cameFrom: "review" };
      const inside = {};
      (flow.rootRef as { current: unknown }).current = { contains: (n: unknown) => n === inside };
      flow.handleKey(escapeKey(inside));
      // never back to the review of the quote that was sent: the form, quoting afresh
      expect(flow.state.screen).toBe("send");
      flow.setAmount("2");
      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();
      await vi.waitFor(() => expect(flow.state.quoting).toBe(false));
      expect(flow.state.complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a route that was sent", () => {
  const endings: Array<[string, () => Error, boolean]> = [
    ["failed", () => new Error("The network refused it."), false],
    ["still moving", () => new StillMoving("This page stopped watching."), true],
    [
      "delivered, unproven",
      () =>
        new DeliveredUnverified(
          "The rail's record no longer says what arrived.",
          "f00d",
          "https://stellar.expert/explorer/testnet/tx/f00d",
        ),
      true,
    ],
  ];

  /** A flow that sent the fixture route and then ended, as the runner ends it. */
  const sentAndEnded = (variant: "wide" | "compact", ending: () => Error) => {
    const events: MavnaWidgetEvent[] = [];
    const quoting = {
      ...engine,
      usdcOnStellar: STELLAR_USDC,
      xlmOnStellar: STELLAR_XLM,
      adapters: [],
      sourceChains: [{ id: "arbitrum-sepolia", name: "Arbitrum Sepolia" }],
      usdt0Chains: [],
      sponsorTerms: () => new Promise(() => {}),
      xlmStroopsPerUsdc: async () => 100_000_000n,
    } as unknown as Engine;
    const flow = applied(new Flow({ engine: quoting, variant, emit: (e) => events.push(e) }));
    const view = toRouteView(routeFor("layerzero"));
    flow.state = { ...flow.state, ...FORM, routes: [view], selected: view.id, screen: "review" };
    flow.start();
    flow.endWith(ending());
    flow.runEnded();
    const started = () => events.filter((e) => e.type === "transferStarted").length;
    return { flow, view, started };
  };

  for (const variant of ["wide", "compact"] as const) {
    for (const [name, ending] of endings) {
      it(`${name}, ${variant}: cannot be started again, and Back leads to the form`, () => {
        vi.useFakeTimers();
        try {
          const { flow, view, started } = sentAndEnded(variant, ending);
          expect(started()).toBe(1);
          expect(flow.state.routes).toEqual([]);
          flow.back();
          expect(flow.state.screen).toBe("send");
          // nothing chosen any more, so Start sends nothing
          flow.start();
          expect(started()).toBe(1);
          // and the spent quote itself is refused even if it were chosen again
          flow.state = { ...flow.state, routes: [view], selected: view.id };
          flow.start();
          expect(started()).toBe(1);
          expect(flow.state.note).toMatch(/already sent/);
        } finally {
          vi.useRealTimers();
        }
      });
    }
  }

  for (const [name, ending, moved] of endings) {
    it(`${name}: a fresh quote for the same recipient and amount ${moved ? "asks first" : "starts"}`, () => {
      vi.useFakeTimers();
      try {
        const { flow, started } = sentAndEnded("compact", ending);
        const fresh = toRouteView(routeFor("layerzero"));
        flow.state = { ...flow.state, routes: [fresh], selected: fresh.id, screen: "review" };
        flow.start();
        if (!moved) {
          expect(started()).toBe(2);
          return;
        }
        expect(started()).toBe(1);
        const html = renderToStaticMarkup(
          renderReview(flow, { r: fresh, chain: { id: "x", name: "X" }, sym: "USDC" }),
        );
        expect(html).toMatch(/may still arrive/);
        expect(html).toContain("Send it again");
        flow.confirmSendAgain();
        expect(started()).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe("the flight's eyebrow after an ending", () => {
  it("does not say Working for a transfer that ended, on screen or to a screen reader", () => {
    const flow = applied(new Flow({ engine }));
    const view = toRouteView(routeFor("layerzero"));
    flow.state = {
      ...flow.state,
      ...FORM,
      routes: [view],
      selected: view.id,
      flying: view,
      screen: "flight",
      phase: "sending",
      steps: [{ id: "burn", label: "Send", user: true, actor: "Your wallet", phase: "pending" }],
    };
    flow.endWith(new StillMoving("This page stopped watching."));
    const vals = flow.flightVals(false);
    expect(vals.stepEyebrow).toBe("Still on its way");
    const html = renderToStaticMarkup(
      renderFlight(flow, { r: view, chain: { id: "x", name: "X" }, sym: "USDC", arrived: false }),
    );
    expect(html).not.toMatch(/>Working</);
    expect(html).toMatch(/role="status"[^>]*>Still on its way/);
  });
});

describe("after an ending, round 6", () => {
  const endedFlow = (variant: "wide" | "compact", error: Error) => {
    const quoting = {
      ...engine,
      usdcOnStellar: STELLAR_USDC,
      xlmOnStellar: STELLAR_XLM,
      adapters: [],
      sourceChains: [{ id: "arbitrum-sepolia", name: "Arbitrum Sepolia" }],
      usdt0Chains: [],
      sponsorTerms: () => Promise.reject(new Error("The sponsor is down.")),
      xlmStroopsPerUsdc: async () => 100_000_000n,
    } as unknown as Engine;
    const flow = applied(new Flow({ engine: quoting, variant }));
    const view = toRouteView(routeFor("layerzero"));
    flow.state = {
      ...flow.state,
      ...FORM,
      routes: [view],
      selected: view.id,
      flying: view,
      screen: "flight",
      phase: "sending",
      steps: [{ id: "burn", label: "Send", user: true, actor: "Your wallet", phase: "pending" }],
    };
    flow.endWith(error);
    return flow;
  };

  it("takes the logo home to a form that quotes afresh, with no Send another left on it", async () => {
    const flow = endedFlow("wide", new StillMoving("This page stopped watching."));
    flow.home();
    expect(flow.state.screen).toBe("send");
    expect(flow.state.phase).toBe("quote");
    await vi.waitFor(() => expect(flow.state.quoting).toBe(false));
    expect(flow.state.complete).toBe(true);
    const html = renderToStaticMarkup(flow.render() as React.ReactElement);
    expect(html).not.toContain("Send another");
  });

  it("says Stopped for a failed ending, after steps that were done", () => {
    const flow = endedFlow("compact", new Error("x"));
    flow.state = {
      ...flow.state,
      phase: "sending",
      steps: [
        { id: "approve", label: "Approve", user: true, actor: "Your wallet", phase: "done" },
        { id: "burn", label: "Send", user: true, actor: "Your wallet", phase: "pending" },
      ],
    };
    flow.endWith(new Error("The network refused it."));
    expect(flow.flightVals(false).stepEyebrow).toBe("Stopped");
  });
});

describe("the flight's headline", () => {
  const flight = (phase: "failed" | "pending"): string => {
    const flow = quotedFlow({ terms: 0 });
    flow.state = {
      ...flow.state,
      phase: "ended",
      steps: [
        { id: "burn", label: "Send", user: true, actor: "Your wallet", phase },
        { id: "mint", label: "Mint", user: false, actor: "Circle", phase: "idle" },
      ],
    };
    const d = { r: flow.chosen(), chain: { id: "x", name: "X" }, sym: "USDC", arrived: false };
    return renderToStaticMarkup(renderFlight(flow, d));
  };

  it("does not say a transfer that stopped is arriving", () => {
    expect(flight("failed")).not.toContain("Arriving on Stellar");
    expect(flight("failed")).toContain("Did not arrive on Stellar");
  });

  it("still says one the page stopped watching is arriving", () => {
    expect(flight("pending")).toContain("Arriving on Stellar");
  });
});

describe("a figure too long for its card", () => {
  // what a figure needs to break onto a second line inside a flex row, rather
  // than run past the card edge and take the decimals and the unit with it
  const wraps = (html: string, figure: string): void => {
    const at = html.indexOf(`>${figure}`);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<", at);
    expect(html.slice(open, at)).toContain("overflow-wrap:anywhere");
  };

  it("wraps on the form, in the routes and in the flight", () => {
    const flow = quotedFlow({ terms: 0 });
    const view = toRouteView(routeFor("layerzero"));
    const big = { ...view, receives: 123456789012.12 };
    flow.state = { ...flow.state, routes: [big], selected: big.id };
    const figure = "123,456,789,012.12";
    const chain = { id: "x", name: "X" };
    wraps(
      renderToStaticMarkup(
        renderSend(flow, { r: big, chain, sym: "USDC", xlm: false, resting: false }),
      ),
      figure,
    );
    wraps(renderToStaticMarkup(renderRoutes(flow, { sym: "USDC", resting: undefined })), figure);
    wraps(
      renderToStaticMarkup(renderFlight(flow, { r: big, chain, sym: "USDC", arrived: true })),
      figure,
    );
  });
});

describe("the form while a quote is on its way", () => {
  // the line under the receive figure, empty or not, is what keeps the rows below still
  const floorRow = (html: string): number => (html.match(/letter-spacing:0.13em/g) ?? []).length;

  it("keeps the floor line's row, so the rows below do not jump when the quote lands", () => {
    const flow = quotedFlow({ terms: 0 });
    const chain = { id: "x", name: "X" };
    const view = flow.chosen();
    const waiting = renderToStaticMarkup(
      renderSend(flow, { r: undefined, chain, sym: "USDC", xlm: false, resting: false }),
    );
    const landed = renderToStaticMarkup(
      renderSend(flow, { r: view, chain, sym: "USDC", xlm: false, resting: false }),
    );
    expect(floorRow(landed)).toBe(1);
    expect(floorRow(waiting)).toBe(1);
  });

  it("has no floor line with no amount to quote", () => {
    const flow = quotedFlow({ terms: 0 });
    const html = renderToStaticMarkup(
      renderSend(flow, {
        r: undefined,
        chain: { id: "x", name: "X" },
        sym: "USDC",
        xlm: false,
        resting: true,
      }),
    );
    expect(floorRow(html)).toBe(0);
  });
});
