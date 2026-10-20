import { MavnaError } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AquariusProvider } from "./aquarius.js";
import { SdexProvider } from "./sdex.js";
import { SoroswapProvider } from "./soroswap.js";
import { SushiSwapProvider } from "./sushiswap.js";
import { toContractId } from "./wire.js";

/**
 * A fetch that only ever finishes by being aborted, which is what a hung
 * provider looks like from here.
 */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
    })) as typeof fetch;
}

const request = {
  assetIn: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  assetOut: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  amountIn: "1000",
  maxSlippageBps: 50,
  destinationKind: "account" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider request timeouts", () => {
  it("aquarius surfaces an aborted request as a retryable MavnaError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new AquariusProvider("testnet", undefined, { timeoutMs: 20 });
    const error = await provider.quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });

  it("soroswap surfaces an aborted request as a retryable MavnaError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new SoroswapProvider({
      network: "mainnet",
      proxyUrl: "https://sponsor.example",
      timeoutMs: 20,
    });
    const error = await provider.quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });

  it("sushiswap surfaces an aborted simulation as a retryable MavnaError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new SushiSwapProvider({
      network: "mainnet",
      rpcUrl: "https://rpc.example",
      timeoutMs: 20,
    });
    const error = await provider
      .quote({
        ...request,
        assetIn: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
        assetOut: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });
});

describe("a caller that stops waiting", () => {
  // each venue's own bound is ten seconds here; the caller's is a few milliseconds
  const soon = () => AbortSignal.timeout(15);
  const quick = async (quote: Promise<unknown>) => {
    const started = Date.now();
    const error = await quote.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect(Date.now() - started).toBeLessThan(1_000);
  };

  it("stops aquarius's request", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new AquariusProvider("testnet", undefined, { timeoutMs: 10_000 });
    await quick(provider.quote({ ...request, signal: soon() }));
  });

  it("stops soroswap's request", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new SoroswapProvider({
      network: "mainnet",
      proxyUrl: "https://sponsor.example",
      timeoutMs: 10_000,
    });
    await quick(provider.quote({ ...request, signal: soon() }));
  });

  it("stops sushiswap's simulations", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = new SushiSwapProvider({
      network: "mainnet",
      rpcUrl: "https://rpc.example",
      timeoutMs: 10_000,
    });
    await quick(
      provider.quote({
        ...request,
        assetIn: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
        assetOut: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        signal: soon(),
      }),
    );
  });

  it("stops the orderbook's request", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await quick(
      new SdexProvider("testnet").quote({
        ...request,
        assetIn: "native",
        assetOut: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        signal: soon(),
      }),
    );
  });
});

describe("the orderbook's answers", () => {
  it("treats a rate limit as worth asking again, like every other venue", async () => {
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    const error = await new SdexProvider("testnet")
      .quote({
        ...request,
        assetIn: "native",
        assetOut: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });

  it("refuses a bare XLM code, because a bare code is not an identity", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}"));
    await expect(
      new SdexProvider("testnet").quote({
        ...request,
        assetIn: "XLM",
        assetOut: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      }),
    ).rejects.toThrow(/CODE:ISSUER or native/);
    expect(() => toContractId("XLM", "testnet")).toThrow();
  });
});
