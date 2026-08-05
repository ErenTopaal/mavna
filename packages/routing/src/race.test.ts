import type { BridgeAdapter, QuoteRequest, Route, RouteRejection, RouteSet } from "@mavna/core";
import { describe, expect, it } from "vitest";
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
});
