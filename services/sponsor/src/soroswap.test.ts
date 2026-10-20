import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoroswapProxy, type ProxyRequest, type SoroswapProxyOptions } from "./soroswap.js";

/**
 * The proxy against a stand-in Soroswap: a real HTTP server on localhost, so the
 * proxy's own fetch, headers and timeouts are what is exercised, and the double
 * sits exactly at the network boundary.
 */

const KEY = "sk_test_this_must_never_leave_the_server";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
// a real account key, so a checksum check anywhere on the way accepts it
const OWNER = Keypair.random().publicKey();

const quoteBody = {
  assetIn: USDC,
  assetOut: XLM,
  tradeType: "EXACT_IN",
  amountIn: "100000000",
  amountOut: "565295344",
  otherAmountThreshold: "562468867",
  priceImpactPct: "0.00",
  platform: "aggregator",
  routePlan: [{ swapInfo: { protocol: "aqua", path: [USDC, XLM] }, percent: "100.00" }],
  rawTrade: { amountIn: "99900000" },
};

const healthBody = {
  status: { indexer: { mainnet: ["soroswap", "aqua", "sushi", "sdex"], testnet: ["soroswap"] } },
  aggregator: { mainnet: { enabled: true, paused: false, degraded: false } },
};

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Reply = { status: number; body: unknown } | "hang";

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function fakeSoroswap(routes: Record<string, () => Reply>): Promise<{
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: text === "" ? undefined : JSON.parse(text),
      });
      const reply = routes[`${req.method} ${path}`]?.() ?? { status: 404, body: {} };
      if (reply === "hang") return;
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function proxyFor(url: string, extra: Partial<SoroswapProxyOptions> = {}) {
  return createSoroswapProxy({ apiKey: KEY, network: "mainnet", baseUrl: url, ...extra });
}

const quoteRequest = (body: Record<string, unknown> = {}): ProxyRequest => ({
  method: "POST",
  path: "/swap/soroswap/quote",
  originAllowed: true,
  client: "203.0.113.7",
  body: {
    network: "mainnet",
    assetIn: USDC,
    assetOut: XLM,
    amount: "100000000",
    slippageBps: 50,
    protocols: ["soroswap", "aqua", "sdex"],
    ...body,
  },
});

describe("the soroswap proxy", () => {
  it("adds the key upstream and relays only the validated quote", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: quoteBody }),
    });
    const answer = await proxyFor(soroswap.url).handle(quoteRequest({ feeBps: 30 }));

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(quoteBody);
    expect(soroswap.seen[0]?.url).toBe("/quote?network=mainnet");
    expect(soroswap.seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(soroswap.seen[0]?.body).toEqual({
      assetIn: USDC,
      assetOut: XLM,
      amount: "100000000",
      tradeType: "EXACT_IN",
      protocols: ["soroswap", "aqua", "sdex"],
      slippageBps: 50,
      feeBps: 30,
    });
    expect(JSON.stringify(answer.body)).not.toContain(KEY);
  });

  it("never relays an answer that contains the key", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: { ...quoteBody, debug: `auth ${KEY}` } }),
    });
    const answer = await proxyFor(soroswap.url).handle(quoteRequest());
    expect(answer.status).toBe(502);
    expect(JSON.stringify(answer.body)).not.toContain(KEY);
  });

  it("does not relay Soroswap's error text, and says when the key itself was refused", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 401, body: { message: `invalid key ${KEY}` } }),
    });
    const answer = await proxyFor(soroswap.url).handle(quoteRequest());
    expect(answer).toEqual({
      status: 502,
      body: { error: "The swap service is misconfigured here.", retryable: false },
    });
  });

  it("refuses an origin that is not allowed, without calling Soroswap", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: quoteBody }),
    });
    const answer = await proxyFor(soroswap.url).handle({
      ...quoteRequest(),
      originAllowed: false,
    });
    expect(answer.status).toBe(403);
    expect(soroswap.seen).toHaveLength(0);
  });

  it("validates what the browser sends before spending a call", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: quoteBody }),
    });
    const proxy = proxyFor(soroswap.url);
    for (const bad of [
      { amount: "1.5" },
      { amount: "0" },
      { slippageBps: 10_001 },
      { feeBps: 10 },
      { feeBps: 301 },
      { protocols: [] },
      { protocols: ["uniswap"] },
      { assetIn: "USDC" },
      { network: "testnet" },
    ]) {
      const answer = await proxy.handle(quoteRequest(bad));
      expect(answer.status, JSON.stringify(bad)).toBe(400);
      expect(answer.body.retryable).toBe(false);
    }
    expect(soroswap.seen).toHaveLength(0);
  });

  it("maps Soroswap's answers onto ours with honest retry advice", async () => {
    const cases: [number | "hang", number, boolean][] = [
      [400, 422, false],
      [429, 429, true],
      [409, 409, true],
      [503, 502, true],
    ];
    for (const [upstream, status, retryable] of cases) {
      const soroswap = await fakeSoroswap({
        "POST /quote": () => (upstream === "hang" ? "hang" : { status: upstream, body: {} }),
      });
      const answer = await proxyFor(soroswap.url).handle(quoteRequest());
      expect(answer.status, String(upstream)).toBe(status);
      expect(answer.body.retryable, String(upstream)).toBe(retryable);
    }
  });

  it("treats a hung or unreachable Soroswap as retryable", async () => {
    const soroswap = await fakeSoroswap({ "POST /quote": () => "hang" });
    const hung = await proxyFor(soroswap.url, { timeoutMs: 50 }).handle(quoteRequest());
    expect(hung).toMatchObject({ status: 502, body: { retryable: true } });

    const gone = await proxyFor("http://127.0.0.1:1").handle(quoteRequest());
    expect(gone).toMatchObject({ status: 502, body: { retryable: true } });
  });

  it("tells the operator why Soroswap could not be reached, without the key", async () => {
    const logged: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    await proxyFor("http://127.0.0.1:1").handle(quoteRequest());
    errors.mockRestore();
    expect(logged.some((line) => /Soroswap.*\/quote.*(ECONNREFUSED|fetch failed)/.test(line))).toBe(
      true,
    );
    expect(logged.some((line) => line.includes(KEY))).toBe(false);
  });

  it("says when Soroswap answers with something that is not JSON", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 200, body: undefined }),
    });
    const logged: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    await proxyFor(soroswap.url).handle(quoteRequest());
    errors.mockRestore();
    expect(logged.some((line) => /Soroswap.*\/quote.*not JSON/.test(line))).toBe(true);
  });

  it("refuses a quote that fails the schema", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: { ...quoteBody, amountOut: "-5" } }),
    });
    const answer = await proxyFor(soroswap.url).handle(quoteRequest());
    expect(answer).toMatchObject({ status: 502, body: { retryable: false } });
  });

  it("builds a quote it is handed back, for the named account", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote/build": () => ({ status: 200, body: { xdr: "AAAAAgAAAAA=" } }),
    });
    const answer = await proxyFor(soroswap.url).handle({
      method: "POST",
      path: "/swap/soroswap/build",
      originAllowed: true,
      client: "203.0.113.7",
      body: { network: "mainnet", quote: quoteBody, from: OWNER, to: OWNER },
    });
    expect(answer).toEqual({ status: 200, body: { xdr: "AAAAAgAAAAA=" } });
    expect(soroswap.seen[0]?.url).toBe("/quote/build?network=mainnet");
    expect(soroswap.seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(soroswap.seen[0]?.body).toEqual({ quote: quoteBody, from: OWNER, to: OWNER });
  });

  it("refuses to build for something that is not a Stellar address", async () => {
    const soroswap = await fakeSoroswap({});
    const answer = await proxyFor(soroswap.url).handle({
      method: "POST",
      path: "/swap/soroswap/build",
      originAllowed: true,
      client: "203.0.113.7",
      body: { network: "mainnet", quote: quoteBody, from: "0xabc", to: OWNER },
    });
    expect(answer.status).toBe(400);
    expect(soroswap.seen).toHaveLength(0);
  });

  it("reports health for its own network, and caches it", async () => {
    const soroswap = await fakeSoroswap({
      "GET /health": () => ({ status: 200, body: healthBody }),
    });
    const proxy = proxyFor(soroswap.url);
    const health = {
      method: "GET",
      path: "/swap/soroswap/health",
      originAllowed: true,
      body: undefined,
    };
    const first = await proxy.handle({ ...health, client: "a" });
    await proxy.handle({ ...health, client: "b" });
    expect(first).toEqual({
      status: 200,
      body: { network: "mainnet", usable: true, protocols: ["soroswap", "aqua", "sushi", "sdex"] },
    });
    expect(soroswap.seen).toHaveLength(1);
    expect(soroswap.seen[0]?.authorization).toBeUndefined();
  });

  it("keeps an unusable answer for the same while, so a down Soroswap is not asked on every call", async () => {
    const soroswap = await fakeSoroswap({ "GET /health": () => ({ status: 503, body: {} }) });
    const proxy = proxyFor(soroswap.url);
    const health = {
      method: "GET",
      path: "/swap/soroswap/health",
      originAllowed: true,
      body: undefined,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await proxy.handle({ ...health, client: "a" });
    await proxy.handle({ ...health, client: "b" });
    errors.mockRestore();
    expect(first.body).toMatchObject({ usable: false });
    expect(soroswap.seen).toHaveLength(1);
  });

  it("is unusable while the mainnet aggregator is paused", async () => {
    const soroswap = await fakeSoroswap({
      "GET /health": () => ({
        status: 200,
        body: { ...healthBody, aggregator: { mainnet: { enabled: true, paused: true } } },
      }),
    });
    const answer = await proxyFor(soroswap.url).handle({
      method: "GET",
      path: "/swap/soroswap/health",
      originAllowed: true,
      client: "a",
      body: undefined,
    });
    expect(answer.body.usable).toBe(false);
  });

  it("limits each client per minute, and everyone together", async () => {
    const soroswap = await fakeSoroswap({
      "POST /quote": () => ({ status: 201, body: quoteBody }),
    });
    let clock = 1_000_000;
    const proxy = proxyFor(soroswap.url, {
      perClientPerMinute: 2,
      totalPerMinute: 3,
      now: () => clock,
    });
    const from = (client: string) => proxy.handle({ ...quoteRequest(), client });

    expect((await from("a")).status).toBe(200);
    expect((await from("a")).status).toBe(200);
    const limited = await from("a");
    expect(limited).toMatchObject({ status: 429, body: { retryable: true } });
    expect((await from("b")).status).toBe(200);
    // Three spent in total: a fresh client is refused too.
    expect((await from("c")).status).toBe(429);

    clock += 60_000;
    expect((await from("a")).status).toBe(200);
    expect(soroswap.seen).toHaveLength(4);
  });

  it("knows only its three endpoints", async () => {
    const soroswap = await fakeSoroswap({});
    const proxy = proxyFor(soroswap.url);
    for (const [method, path] of [
      ["POST", "/swap/soroswap/send"],
      ["GET", "/swap/soroswap/quote"],
      ["POST", "/swap/soroswap/health"],
    ] as const) {
      const answer = await proxy.handle({
        method,
        path,
        originAllowed: true,
        client: "a",
        body: {},
      });
      expect(answer.status).toBe(404);
    }
  });

  it("will not start without a key", () => {
    expect(() => createSoroswapProxy({ apiKey: "", network: "mainnet" })).toThrow();
  });
});
