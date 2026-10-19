import { CCTP_CONTRACTS, sourceUsdcFor } from "@mavna/adapter-cctp";
import type { Asset, RouteSet } from "@mavna/core";
import { createCircuitBreaker, parseDisabledSources } from "@mavna/routing";
import { RpcClient } from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";
import { describe, expect, it } from "vitest";
import { routeFor, ScriptedAdapter, SOURCE_USDC, STELLAR_XLM } from "./__fixtures__/scripted";
import { applySponsorTerms, buildAssets, declineUnsettleable, runQuote } from "./quote";

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
    rpc: new RpcClient({ url: "https://example.invalid" }),
    usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
    sponsorTerms: () => Promise.reject(new Error("not asked: the quote ends before the sponsor")),
  };
  const inputs = {
    chainId: "fantom",
    wanted: "USDC" as const,
    amount: "5",
    destination: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    priority: "best" as const,
    rails: { Circle: true, Axelar: true, LayerZero: true },
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

describe("applySponsorTerms", () => {
  const sponsorFunded = {
    network: "testnet",
    reserveFunding: "sponsor" as const,
    minDeliveryBaseUnits: 1_000_000n,
  };
  const selfFunded = { ...sponsorFunded, reserveFunding: "self" as const };
  const sending = (source: string, baseUnits: string, fee = "0") => ({
    ...routeFor(source),
    sends: { asset: SOURCE_USDC, baseUnits },
    fees: [
      {
        kind: "bridge" as const,
        total: { asset: SOURCE_USDC, baseUnits: fee },
        recipients: [],
        includedInQuote: true,
      },
    ],
  });

  it("leaves everything alone on a sponsor that fronts reserves, above its minimum", () => {
    const routes = [routeFor("cctp", { newAccount: true }), routeFor("layerzero")];
    const set = applySponsorTerms(
      { routes, rejected: [], complete: true },
      { network: "testnet", terms: sponsorFunded, destination: "exists" },
    );
    expect(set.routes).toEqual(routes);
    expect(set.rejected).toEqual([]);
  });

  it("declines setting up an address that does not exist when accounts fund their own reserve", () => {
    const fresh = routeFor("cctp", { newAccount: true });
    const ready = routeFor("layerzero");
    const set = applySponsorTerms(
      { routes: [fresh, ready], rejected: [], complete: true },
      { network: "testnet", terms: selfFunded, destination: "missing" },
    );
    expect(set.routes).toEqual([ready]);
    expect(set.rejected).toEqual([
      {
        source: "cctp",
        reason: "destination-unsupported",
        explanation: expect.stringMatching(/does not exist yet.*XLM/),
        retryable: false,
      },
    ]);
  });

  it("keeps a trustline for an account that exists when it funds its own reserve", () => {
    const route = routeFor("axelar", { newAccount: true });
    const set = applySponsorTerms(
      { routes: [route], rejected: [], complete: true },
      { network: "testnet", terms: selfFunded, destination: "exists" },
    );
    expect(set.routes).toEqual([route]);
  });

  it("declines a Circle transfer that would arrive below the sponsor's minimum delivery", () => {
    const small = sending("cctp", "1000000", "1");
    const exact = sending("cctp", "1000001", "1");
    const otherRail = sending("layerzero", "10");
    const set = applySponsorTerms(
      { routes: [small, exact, otherRail], rejected: [], complete: true },
      { network: "testnet", terms: sponsorFunded, destination: "exists" },
    );
    expect(set.routes).toEqual([exact, otherRail]);
    expect(set.rejected).toEqual([
      {
        source: "cctp",
        reason: "amount-too-small",
        explanation: expect.stringMatching(/at least 1 USDC/),
        retryable: false,
      },
    ]);
  });

  it("declines what needs the sponsor when it cannot be reached, and keeps what does not", () => {
    const circle = routeFor("cctp");
    const fresh = routeFor("axelar", { newAccount: true });
    const ready = routeFor("layerzero");
    const set = applySponsorTerms(
      { routes: [circle, fresh, ready], rejected: [], complete: true },
      { network: "testnet", terms: new Error("The sponsor answered 503."), destination: "exists" },
    );
    expect(set.routes).toEqual([ready]);
    expect(set.rejected.map((r) => [r.source, r.reason, r.retryable])).toEqual([
      ["cctp", "temporarily-unavailable", true],
      ["axelar", "temporarily-unavailable", true],
    ]);
    expect(set.rejected[0]?.explanation).toMatch(/503/);
  });

  it("declines what needs the sponsor when it runs on another network", () => {
    const set = applySponsorTerms(
      { routes: [routeFor("cctp")], rejected: [], complete: true },
      { network: "mainnet", terms: sponsorFunded, destination: "exists" },
    );
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/testnet.*mainnet/);
  });

  it("declines a self-funded setup it could not check the destination for, as worth retrying", () => {
    const fresh = routeFor("axelar", { newAccount: true });
    const set = applySponsorTerms(
      { routes: [fresh], rejected: [], complete: true },
      { network: "testnet", terms: selfFunded, destination: new Error("node down") },
    );
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]).toMatchObject({ reason: "temporarily-unavailable", retryable: true });
  });
});
