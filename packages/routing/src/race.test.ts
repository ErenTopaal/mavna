import {
  ADAPTER_QUOTE_TIMEOUT_MS,
  type BridgeAdapter,
  type ComposeQuoteRequest,
  type QuoteRequest,
  type Route,
  type RouteRejection,
  type RouteSet,
} from "@mavna/core";
import { describe, expect, it, vi } from "vitest";
import type { SwapQuoter } from "./enrich.js";
import { raceAdapters } from "./race.js";

const request = {} as QuoteRequest;

function adapter(id: string, behaviour: () => Promise<Route | RouteRejection>): BridgeAdapter {
  return {
    id,
    trustModel: "native-mint",
    supportedChains: async () => [],
    quote: behaviour,
    buildTransactions: async () => [],
    status: async () => ({ phase: "idle" }),
  };
}

// Enough of a route for ranking to hold it: the race now orders results by net
// outcome on every publish, so even a stub has to carry a number to rank by.
const route = (source: string, receivesBaseUnits = "1"): Route =>
  ({
    source,
    receives: { asset: { symbol: "USDC", decimals: 7 }, baseUnits: receivesBaseUnits },
    deliveredAtLeast: { asset: { symbol: "USDC", decimals: 7 }, baseUnits: receivesBaseUnits },
    fees: [] as Route["fees"],
    steps: [] as Route["steps"],
    estimatedSeconds: 60,
    signaturesRequired: 1,
  }) as Route;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("racing route sources", () => {
  it("returns what arrived even when one source is slow", async () => {
    const result = await raceAdapters(
      [
        adapter("fast", async () => route("fast")),
        adapter("slow", async () => {
          await sleep(5000);
          return route("slow");
        }),
      ],
      request,
      { timeoutMs: 50 },
    );

    // A slow rail costs its own route and nothing else. Partial results are the
    // normal case, not a degraded one.
    expect(result.routes.map((r) => r.source)).toEqual(["fast"]);
    expect(result.rejected.map((r) => r.source)).toEqual(["slow"]);
    expect(result.complete).toBe(true);
  });

  it("bounds every rail by the shared deadline when the caller sets none", async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const racing = raceAdapters([adapter("hung", () => new Promise(() => {}))], request).then(
        (set) => {
          finished = true;
          return set;
        },
      );
      await vi.advanceTimersByTimeAsync(ADAPTER_QUOTE_TIMEOUT_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await racing;
      expect(result.rejected.map((r) => r.reason)).toEqual(["timed-out"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says WHY a source produced nothing rather than omitting it", async () => {
    const result = await raceAdapters(
      [
        adapter("dead", async () => {
          throw new Error("ECONNREFUSED");
        }),
      ],
      request,
    );

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("errored");
    // Never a raw error string, a stack trace or a protocol message.
    expect(result.rejected[0]?.explanation).not.toContain("ECONNREFUSED");
    expect(result.rejected[0]?.explanation.length).toBeGreaterThan(0);
  });

  it("passes through a source's own reason for declining", async () => {
    const result = await raceAdapters(
      [
        adapter("picky", async () => ({
          source: "picky",
          reason: "amount-too-small",
          retryable: false,
          explanation: "Send at least $1.",
        })),
      ],
      request,
    );
    expect(result.rejected[0]?.reason).toBe("amount-too-small");
    expect(result.rejected[0]?.explanation).toBe("Send at least $1.");
  });

  it("publishes each answer as it lands, so the wait shows progress", async () => {
    const seen: RouteSet[] = [];
    await raceAdapters(
      [
        adapter("a", async () => route("a")),
        adapter("b", async () => {
          await sleep(20);
          return route("b");
        }),
      ],
      request,
      { onUpdate: (partial) => seen.push(partial) },
    );

    expect(seen.length).toBe(2);
    expect(seen[0]?.complete).toBe(false);
    expect(seen[seen.length - 1]?.complete).toBe(true);
  });

  it("one source failing never stops another succeeding", async () => {
    const result = await raceAdapters(
      [
        adapter("broken", async () => {
          throw new Error("boom");
        }),
        adapter("working", async () => route("working")),
      ],
      request,
    );
    expect(result.routes).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it("handles every source declining without pretending it succeeded", async () => {
    const result = await raceAdapters(
      [
        adapter("x", async () => {
          throw new Error("a");
        }),
        adapter("y", async () => {
          throw new Error("b");
        }),
      ],
      request,
    );
    expect(result.routes).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  it("times out a swap leg that never answers without stalling the other sources", async () => {
    const hung: SwapQuoter = { id: "hung", quote: () => new Promise(() => {}) };
    const asset = { chainId: "stellar-testnet", id: "x", symbol: "X", decimals: 7, curatedBy: "t" };
    const result = await raceAdapters(
      [
        adapter("stuck", async () => ({
          ...route("stuck"),
          destination: "GDEST",
          deliveredAtLeast: { asset, baseUnits: "1" },
        })),
        adapter("declines", async () => ({
          source: "declines",
          reason: "no-liquidity",
          explanation: "none",
          retryable: true,
        })),
      ],
      { ...request, maxSlippageBps: 50 },
      {
        timeoutMs: 50,
        swap: {
          provider: hung,
          delivered: asset,
          deliveredContract: "CA",
          wanted: asset,
          wantedContract: "CB",
        },
      },
    );

    expect(result.rejected.find((r) => r.source === "stuck")?.reason).toBe("timed-out");
    expect(result.rejected.find((r) => r.source === "declines")?.reason).toBe("no-liquidity");
    expect(result.complete).toBe(true);
  });
});

describe("the conversion inside the rail's budget", () => {
  const asset = { chainId: "stellar", id: "X:G", symbol: "X", decimals: 7, curatedBy: "t" };
  const wanted = { ...asset, id: "native", symbol: "XLM" };

  it("hands the swap leg what is left of the budget, and says the conversion ran out of time", async () => {
    // Fake time, so the budget arithmetic is checked exactly and a loaded
    // machine cannot move it. AbortSignal.timeout is Node's own timer, outside
    // the fakes, so it is replaced with a signal this test fires itself.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const deadline = new AbortController();
    const handed: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      handed.push(ms);
      return deadline.signal;
    });
    try {
      let legAsked = false;
      const waitsForDeadline: SwapQuoter = {
        id: "venues",
        quote: (q) =>
          new Promise((_resolve, reject) => {
            legAsked = true;
            q.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };
      const racing = raceAdapters(
        [
          adapter("rail", async () => {
            await sleep(60);
            return {
              ...route("rail"),
              destination: "GDEST",
              deliveredAtLeast: { asset, baseUnits: "1" },
            };
          }),
        ],
        { ...request, maxSlippageBps: 50 },
        {
          timeoutMs: 200,
          swap: {
            provider: waitsForDeadline,
            delivered: asset,
            deliveredContract: "CA",
            wanted,
            wantedContract: "native",
          },
        },
      );
      await vi.advanceTimersByTimeAsync(60);
      // the rail took 60 of its 200 ms, so the leg gets the 140 left, not a
      // fresh budget of its own
      expect(legAsked).toBe(true);
      expect(handed).toEqual([140]);

      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(1);
      const result = await racing;
      expect(result.routes).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toBe("timed-out");
      expect(result.rejected[0]?.explanation).toMatch(/XLM/);
      expect(result.rejected[0]?.retryable).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("a quoter that answers with what it has when the budget ends", () => {
  it("keeps that answer rather than calling the conversion late", async () => {
    const asset = { chainId: "stellar", id: "X:G", symbol: "X", decimals: 7, curatedBy: "t" };
    // like the venue chain: on the deadline it hands back a quote that already arrived
    const answersOnDeadline: SwapQuoter = {
      id: "venues",
      quote: (q) =>
        new Promise((resolve) => {
          q.signal?.addEventListener("abort", () => {
            void Promise.resolve().then(() =>
              resolve({ provider: "later-venue", amountOut: "5", amountOutMinimum: "5" }),
            );
          });
        }),
    };
    const result = await raceAdapters(
      [
        adapter("rail", async () => ({
          ...route("rail"),
          destination: "GDEST",
          deliveredAtLeast: { asset, baseUnits: "1" },
        })),
      ],
      { ...request, maxSlippageBps: 50 },
      {
        timeoutMs: 50,
        swap: {
          provider: answersOnDeadline,
          delivered: asset,
          deliveredContract: "CA",
          wanted: { ...asset, id: "native", symbol: "XLM" },
          wantedContract: "native",
        },
      },
    );
    expect(result.rejected).toEqual([]);
    expect(result.routes[0]?.steps.at(-1)?.source).toBe("later-venue");
  });
});

describe("compose routes", () => {
  const usdt0 = { chainId: "stellar", id: "USDT0:G", symbol: "USDT0", decimals: 7, curatedBy: "t" };
  const usdc = { chainId: "stellar", id: "USDC:G", symbol: "USDC", decimals: 7, curatedBy: "t" };
  const quoter: SwapQuoter = {
    id: "venue",
    quote: async (q) => ({
      provider: "venue",
      amountOut: q.amountIn,
      amountOutMinimum: q.amountIn,
    }),
  };
  const swap = {
    provider: quoter,
    delivered: usdt0,
    deliveredContract: "CUSDT0",
    wanted: usdc,
    wantedContract: "CUSDC",
  };
  const plainRoute = (source: string): Route =>
    ({
      ...route(source, "100"),
      id: `${source}-plain`,
      destination: "GDEST",
      receivesAtLeast: { asset: usdt0, baseUnits: "99" },
      deliveredAtLeast: { asset: usdt0, baseUnits: "99" },
      steps: [],
      fees: [],
    }) as unknown as Route;

  function composing(
    id: string,
    answer: (r: ComposeQuoteRequest) => Promise<Route | RouteRejection | undefined>,
    asked: ComposeQuoteRequest[] = [],
  ): BridgeAdapter {
    return {
      ...adapter(id, async () => plainRoute(id)),
      quoteCompose: (r) => {
        asked.push(r);
        return answer(r);
      },
    };
  }

  it("races a compose route beside the plain one, ranked with the rest", async () => {
    const asked: ComposeQuoteRequest[] = [];
    const result = await raceAdapters(
      [
        composing(
          "lz",
          async (r) => ({
            ...r.plain,
            id: "lz-compose",
            receives: { asset: usdc, baseUnits: "150" },
          }),
          asked,
        ),
      ],
      { ...request, to: usdc, maxSlippageBps: 50 },
      { swap },
    );
    expect(result.routes.map((r) => r.id)).toEqual(["lz-compose", "lz-plain"]);
    // the rail is handed its own plain route and the asset it delivers
    expect(asked[0]?.plain.id).toBe("lz-plain");
    expect(asked[0]?.arrivingContract).toBe("CUSDT0");
    expect(asked[0]?.wantedContract).toBe("CUSDC");
    expect(asked[0]?.to).toBe(usdc);
  });

  it("keeps the plain route when the compose route is rejected, and says why", async () => {
    const result = await raceAdapters(
      [
        composing("lz", async () => ({
          source: "lz",
          reason: "destination-unsupported",
          explanation: "A brand-new account keeps the plain route.",
          retryable: false,
        })),
      ],
      { ...request, to: usdc, maxSlippageBps: 50 },
      { swap },
    );
    expect(result.routes.map((r) => r.id)).toEqual(["lz-plain"]);
    expect(result.rejected.map((r) => r.explanation)).toEqual([
      "A brand-new account keeps the plain route.",
    ]);
  });

  it("adds nothing when the rail has no converting contract on this network", async () => {
    const result = await raceAdapters(
      [composing("lz", async () => undefined)],
      { ...request, to: usdc, maxSlippageBps: 50 },
      { swap },
    );
    expect(result.routes).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("is not asked when no conversion is wanted", async () => {
    const asked: ComposeQuoteRequest[] = [];
    await raceAdapters([composing("lz", async () => undefined, asked)], request);
    expect(asked).toHaveLength(0);
  });

  it("is not complete until the compose answer is in, and times it out on its own", async () => {
    const updates: RouteSet[] = [];
    const result = await raceAdapters(
      [composing("lz", () => new Promise(() => {}))],
      { ...request, to: usdc, maxSlippageBps: 50 },
      { swap, timeoutMs: 50, onUpdate: (u) => updates.push(u) },
    );
    expect(updates.filter((u) => u.complete)).toHaveLength(1);
    expect(updates.at(-1)?.complete).toBe(true);
    expect(result.routes.map((r) => r.id)).toEqual(["lz-plain"]);
    expect(result.rejected.map((r) => r.reason)).toEqual(["timed-out"]);
  });

  it("never adds a route or reopens the set after it reported complete, when a plain quote answers late", async () => {
    const updates: RouteSet[] = [];
    const asked: ComposeQuoteRequest[] = [];
    let swapAsked = 0;
    const late: BridgeAdapter = {
      ...adapter("lz", async () => {
        await sleep(60);
        return plainRoute("lz");
      }),
      quoteCompose: async (r) => {
        asked.push(r);
        return { ...r.plain, id: "lz-compose" };
      },
    };
    const counting: SwapQuoter = {
      id: "venue",
      quote: async (q) => {
        swapAsked += 1;
        return { provider: "venue", amountOut: q.amountIn, amountOutMinimum: q.amountIn };
      },
    };
    const result = await raceAdapters(
      [late],
      { ...request, to: usdc, maxSlippageBps: 50 },
      {
        swap: { ...swap, provider: counting },
        timeoutMs: 20,
        onUpdate: (u) => updates.push(u),
      },
    );
    const afterReturn = updates.length;
    await sleep(120);
    expect(result.routes).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(["timed-out"]);
    // nothing reaches the caller once the race has said it is done
    expect(updates.length).toBe(afterReturn);
    expect(updates.every((u) => u.routes.length === 0)).toBe(true);
    // and a rail that already lost its slot is not asked for anything more
    expect(asked).toHaveLength(0);
    expect(swapAsked).toBe(0);
  });

  it("hands the integrator fee to the contract that collects it, and does not take it twice", async () => {
    const asked: ComposeQuoteRequest[] = [];
    const result = await raceAdapters(
      [
        composing(
          "lz",
          async (r) => ({ ...r.plain, id: "lz-compose", compose: {} as Route["compose"] }),
          asked,
        ),
      ],
      { ...request, to: usdc, maxSlippageBps: 50 },
      {
        swap,
        integratorFee: { bps: 30, recipient: "GFEE", recipientName: "App", collects: () => true },
      },
    );
    expect(asked[0]?.integratorFee).toEqual({ bps: 30, recipient: "GFEE", recipientName: "App" });
    const compose = result.routes.find((r) => r.id === "lz-compose");
    expect(compose?.fees).toEqual([]);
    expect(compose?.receives.baseUnits).toBe("100");
  });
});

describe("rails that deliver the wanted asset themselves", () => {
  const usdt0 = { chainId: "stellar", id: "USDT0:G", symbol: "USDT0", decimals: 7, curatedBy: "t" };
  const xlm = { chainId: "stellar", id: "native", symbol: "XLM", decimals: 7, curatedBy: "t" };
  const converted: string[] = [];
  const quoter: SwapQuoter = {
    id: "venue",
    quote: async (q) => {
      converted.push(q.assetIn);
      return { provider: "venue", amountOut: q.amountIn, amountOutMinimum: q.amountIn };
    },
  };
  const swap = {
    provider: quoter,
    delivered: usdt0,
    deliveredContract: "CUSDT0",
    wanted: xlm,
    wantedContract: "native",
  };

  it("asks a direct rail for what the user wants, with no conversion and no compose", async () => {
    const asked: Record<string, QuoteRequest> = {};
    const composeAsked: string[] = [];
    const rail = (id: string): BridgeAdapter => ({
      ...adapter(id, async () => route(id)),
      quote: async (r) => {
        asked[id] = r;
        return {
          ...route(id, "100"),
          id: `${id}-plain`,
          destination: "GDEST",
          receives: { asset: r.to, baseUnits: "100" },
          receivesAtLeast: { asset: r.to, baseUnits: "99" },
          deliveredAtLeast: { asset: r.to, baseUnits: "99" },
          steps: [{ kind: "bridge", to: { asset: r.to, baseUnits: "100" } }],
        } as unknown as Route;
      },
      quoteCompose: async () => {
        composeAsked.push(id);
        return undefined;
      },
    });
    converted.length = 0;
    const result = await raceAdapters(
      [rail("lz"), rail("near")],
      { ...request, to: xlm, maxSlippageBps: 50 },
      { swap, direct: ["near"] },
    );
    expect(asked.lz?.to).toBe(usdt0);
    expect(asked.near?.to).toBe(xlm);
    // only the rail landing usdt0 is converted, and only it is asked to compose
    expect(converted).toEqual(["CUSDT0"]);
    expect(composeAsked).toEqual(["lz"]);
    const near = result.routes.find((r) => r.source === "near");
    expect(near?.steps.map((s) => s.kind)).toEqual(["bridge"]);
    expect(near?.receives.asset).toBe(xlm);
  });
});

describe("compose declines", () => {
  it("marks a decline of the convert-on-arrival offer as such", async () => {
    const usdt0 = {
      chainId: "stellar",
      id: "USDT0:G",
      symbol: "USDT0",
      decimals: 7,
      curatedBy: "t",
    };
    const usdc = { chainId: "stellar", id: "USDC:G", symbol: "USDC", decimals: 7, curatedBy: "t" };
    const swap = {
      provider: {
        id: "venue",
        quote: async () => {
          throw new Error("no venue");
        },
      } as SwapQuoter,
      delivered: usdt0,
      deliveredContract: "CUSDT0",
      wanted: usdc,
      wantedContract: "CUSDC",
    };
    const result = await raceAdapters(
      [
        {
          ...adapter("lz", async () => ({
            ...route("lz", "100"),
            deliveredAtLeast: { asset: usdt0, baseUnits: "99" },
            receivesAtLeast: { asset: usdt0, baseUnits: "99" },
          })),
          quoteCompose: async () => ({
            source: "lz",
            reason: "chain-unsupported",
            explanation: "No contract here.",
            retryable: false,
          }),
        },
      ],
      { ...request, to: usdc, maxSlippageBps: 50 },
      { swap },
    );
    const compose = result.rejected.find((r) => r.explanation === "No contract here.");
    expect(compose?.compose).toBe(true);
    expect(result.rejected.filter((r) => r.compose !== true)).toHaveLength(1);
  });
});
