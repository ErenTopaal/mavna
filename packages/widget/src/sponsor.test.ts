import { afterEach, describe, expect, it, vi } from "vitest";
import { createSponsorClient } from "./sponsor";

function answer(status: number, body: string): void {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

const client = createSponsorClient("https://sponsor.test");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestDelivery", () => {
  it("reads a 404 as not attested yet", async () => {
    answer(404, JSON.stringify({ error: "Not attested.", retryable: true }));
    expect(await client.requestDelivery("0xabc", 6)).toEqual({ kind: "not-attested-yet" });
  });

  it("reads a 409 body as the outcome", async () => {
    const body = { kind: "recipient-not-ready", detail: "x" };
    answer(409, JSON.stringify(body));
    expect(await client.requestDelivery("0xabc", 6)).toEqual(body);
  });

  it("passes a 200 outcome through", async () => {
    const body = { kind: "delivered", txHash: "h", ledger: 7, settled: true };
    answer(200, JSON.stringify(body));
    expect(await client.requestDelivery("0xabc", 6)).toEqual(body);
  });

  it("rejects a 500 with the server's error", async () => {
    answer(500, JSON.stringify({ error: "Broke.", retryable: false }));
    await expect(client.requestDelivery("0xabc", 6)).rejects.toThrow("Broke.");
  });

  it("rejects a non-JSON 502 with the status", async () => {
    answer(502, "<html>bad gateway</html>");
    await expect(client.requestDelivery("0xabc", 6)).rejects.toThrow("The sponsor answered 502.");
  });

  it("rejects a non-JSON 404 rather than calling it not attested", async () => {
    answer(404, "<html>not found</html>");
    await expect(client.requestDelivery("0xabc", 6)).rejects.toThrow("The sponsor answered 404.");
  });
});

describe("other calls", () => {
  it("do not read a 404 as an outcome", async () => {
    answer(404, JSON.stringify({ error: "No such endpoint.", retryable: false }));
    await expect(client.requestPreparation("G", "1")).rejects.toThrow("No such endpoint.");
  });
});

describe("settle", () => {
  it("returns the server's answer on 200", async () => {
    answer(200, JSON.stringify({ settled: true, settlementTxHash: "h" }));
    expect(await client.settle("G")).toEqual({ settled: true, settlementTxHash: "h" });
  });

  it("reads a 404 as nothing held", async () => {
    answer(404, JSON.stringify({ error: "No settlement is held for that account." }));
    expect(await client.settle("G")).toEqual({ settled: false, held: false });
  });

  it("reads a 429 as retryable", async () => {
    answer(429, JSON.stringify({ error: "Slow down.", retryable: true }));
    expect(await client.settle("G")).toEqual({ settled: false, settlementRetryable: true });
  });

  it("rejects a 400 with the server's error", async () => {
    answer(400, JSON.stringify({ error: "Bad address.", retryable: false }));
    await expect(client.settle("x")).rejects.toThrow("Bad address.");
  });

  it("rejects a non-JSON 502 with the status", async () => {
    answer(502, "oops");
    await expect(client.settle("G")).rejects.toThrow("The sponsor answered 502.");
  });
});

describe("terms", () => {
  it("reads who funds reserves and the smallest delivery from /health", async () => {
    answer(
      200,
      JSON.stringify({
        ok: true,
        network: "mainnet",
        reserveFunding: "self",
        minDeliveryBaseUnits: "2500000",
      }),
    );
    expect(await client.terms()).toEqual({
      network: "mainnet",
      reserveFunding: "self",
      minDeliveryBaseUnits: 2_500_000n,
    });
  });

  it("reads a sponsor from before the switch as what it is: one that fronts reserves, with no minimum", async () => {
    answer(200, JSON.stringify({ ok: true, network: "testnet", sponsor: "G..." }));
    expect(await client.terms()).toEqual({
      network: "testnet",
      reserveFunding: "sponsor",
      minDeliveryBaseUnits: 0n,
    });
  });

  it("rejects an answer it cannot read rather than guessing", async () => {
    answer(200, JSON.stringify({ ok: true, network: "testnet", reserveFunding: "maybe" }));
    await expect(client.terms()).rejects.toThrow(/reserve/);
    answer(200, JSON.stringify({ ok: true, network: "testnet", minDeliveryBaseUnits: "1.5" }));
    await expect(client.terms()).rejects.toThrow(/minimum/);
    answer(200, JSON.stringify({ ok: true }));
    await expect(client.terms()).rejects.toThrow(/network/);
  });

  it("rejects when the sponsor does not answer", async () => {
    answer(503, "down");
    await expect(client.terms()).rejects.toThrow(/503/);
  });
});

describe("a sponsor that accepts the connection and never answers", () => {
  it("is given up on, with a reason, rather than waited on forever", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    try {
      const sponsor = createSponsorClient("https://sponsor.test", { timeoutMs: 20 });
      await expect(sponsor.requestDelivery(`0x${"ab".repeat(32)}`, 3)).rejects.toThrow(
        "The sponsor did not answer in time.",
      );
      await expect(sponsor.submitPreparation("AAAA")).rejects.toThrow(
        "The sponsor did not answer in time.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
