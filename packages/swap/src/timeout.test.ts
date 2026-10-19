import { MavnaError } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AquariusProvider } from "./aquarius.js";
import { SoroswapProvider } from "./soroswap.js";

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
  assetIn: "CA",
  assetOut: "CB",
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
    const provider = new SoroswapProvider({ network: "mainnet", apiKey: "k", timeoutMs: 20 });
    const error = await provider.quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });
});
