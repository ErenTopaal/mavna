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
