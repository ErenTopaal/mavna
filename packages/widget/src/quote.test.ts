import { CCTP_CONTRACTS, sourceUsdcFor } from "@mavna/adapter-cctp";
import type { Asset, RouteSet } from "@mavna/core";
import { createCircuitBreaker, parseDisabledSources } from "@mavna/routing";
import { SdexProvider } from "@mavna/swap";
import { describe, expect, it } from "vitest";
import { routeFor, ScriptedAdapter, STELLAR_XLM } from "./__fixtures__/scripted";
import { buildAssets, declineUnsettleable, runQuote } from "./quote";

const stellar = (id: string, symbol: string, decimals: number): Asset => ({
  chainId: "stellar-testnet",
  id,
  symbol,
  decimals,
  curatedBy: "Circle",
});
const engine = {
  network: "testnet" as const,
  usdcOnStellar: stellar(`USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`, "USDC", 7),
  xlmOnStellar: stellar("native", "XLM", 7),
};

describe("buildAssets", () => {
  it("names the real USDC token of the source chain, not the chain", () => {
    for (const chain of ["ethereum-sepolia", "base-sepolia", "solana-devnet", "starknet-sepolia"]) {
      const { from } = buildAssets(engine, chain, "USDC");
      expect(from.id).toBe(sourceUsdcFor("testnet", chain)?.address);
      expect(from.id).not.toBe(chain);
    }
  });

  it("delivers to the engine's Stellar asset", () => {
    expect(buildAssets(engine, "ethereum-sepolia", "USDC").to).toBe(engine.usdcOnStellar);
    expect(buildAssets(engine, "ethereum-sepolia", "XLM").to).toBe(engine.xlmOnStellar);
  });

  it("refuses a chain with no known USDC", () => {
    expect(() => buildAssets(engine, "fantom", "USDC")).toThrow(/fantom/);
  });
});

describe("runQuote", () => {
  const breaker = createCircuitBreaker(() => parseDisabledSources(undefined));
  const sdex = new SdexProvider("testnet");
  const quoting = {
    ...engine,
    adapters: [new ScriptedAdapter("cctp", [{ phase: "idle" }])],
    breaker,
    xlmSwap: {
      provider: sdex,
      delivered: engine.usdcOnStellar,
      deliveredContract: engine.usdcOnStellar.id,
      wanted: engine.xlmOnStellar,
      wantedContract: "native",
    },
    integratorFee: undefined,
  };
  const inputs = {
    chainId: "fantom",
    wanted: "USDC" as const,
    amount: "5",
    destination: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    priority: "best" as const,
    rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
  };

  it("reports a chain with no known USDC through the quote's own answer instead of throwing", () => {
    const updates: RouteSet[] = [];
    const finals: RouteSet[] = [];
    expect(() =>
      runQuote(
        quoting,
        inputs,
        (set) => updates.push(set),
        (set) => finals.push(set),
      ),
    ).not.toThrow();
    expect(finals).toHaveLength(1);
    expect(finals[0]?.complete).toBe(true);
    expect(finals[0]?.routes).toEqual([]);
    expect(finals[0]?.rejected).toEqual([
      {
        source: "cctp",
        reason: "asset-unsupported",
        explanation: "No USDC deployment is known for fantom.",
        retryable: false,
      },
    ]);
    expect(updates).toHaveLength(1);
  });
});

describe("declineUnsettleable", () => {
  const usdc = engine.usdcOnStellar.id;

  it("turns a new-account route that delivers something other than the sponsor's USDC into a decline", () => {
    const ready = routeFor("layerzero", { delivers: STELLAR_XLM });
    const fresh = routeFor("axelar", { newAccount: true, delivers: STELLAR_XLM });
    const fine = routeFor("cctp", { newAccount: true });
    const set = declineUnsettleable(
      { routes: [ready, fresh, fine], rejected: [], complete: true },
      usdc,
    );
    expect(set.routes).toEqual([ready, fine]);
    expect(set.rejected).toEqual([
      {
        source: "axelar",
        reason: "destination-unsupported",
        explanation: expect.stringMatching(/new Stellar account/),
        retryable: false,
      },
    ]);
    expect(set.complete).toBe(true);
  });
});
