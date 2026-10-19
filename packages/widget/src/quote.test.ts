import { CCTP_CONTRACTS, sourceUsdcFor } from "@mavna/adapter-cctp";
import {
  type Asset,
  MavnaError,
  type QuoteRequest,
  type RouteRejection,
  type RouteSet,
} from "@mavna/core";
import { createCircuitBreaker, parseDisabledSources } from "@mavna/routing";
import { RpcClient } from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";
import { describe, expect, it } from "vitest";
import { routeFor, ScriptedAdapter, SOURCE_USDC, STELLAR_XLM } from "./__fixtures__/scripted";
import {
  applySponsorTerms,
  assetsFor,
  buildAssets,
  declineUnsettleable,
  runQuote,
  toRouteView,
} from "./quote";

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
    usdt0Assets: async (): Promise<{ from: Asset; to: Asset }> => {
      throw new Error("a USDC send never asks for USDT0");
    },
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

describe("sending USDT0", () => {
  const usdt0From: Asset = {
    chainId: "arbitrum",
    id: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    symbol: "USD₮0",
    decimals: 6,
    curatedBy: "LayerZero",
  };
  const usdt0To: Asset = {
    chainId: "stellar",
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "LayerZero",
  };
  const asked: string[] = [];
  const usdt0Assets = async (chainId: string) => {
    asked.push(chainId);
    return { from: { ...usdt0From, chainId }, to: usdt0To };
  };

  it("takes both assets from the LayerZero deployment, whatever the receive toggle says", async () => {
    for (const wanted of ["USDC", "XLM", "USDT0"] as const) {
      const assets = await assetsFor({ ...engine, usdt0Assets }, "arbitrum", "USDT0", wanted);
      expect(assets).toEqual({ from: usdt0From, to: usdt0To });
    }
    expect(asked).toEqual(["arbitrum", "arbitrum", "arbitrum"]);
  });

  it("still names USDC by its token address when USDC is picked", async () => {
    const { from } = await assetsFor(
      { ...engine, usdt0Assets },
      "ethereum-sepolia",
      "USDC",
      "USDC",
    );
    expect(from.id).toBe(sourceUsdcFor("testnet", "ethereum-sepolia")?.address);
  });

  /** Records what each rail is asked, and answers like a rail with no route. */
  class Recorder extends ScriptedAdapter {
    readonly requests: QuoteRequest[] = [];
    override async quote(request?: QuoteRequest): Promise<RouteRejection> {
      if (request !== undefined) this.requests.push(request);
      return super.quote();
    }
  }

  const breaker = createCircuitBreaker(() => parseDisabledSources(undefined));
  const inputs = {
    chainId: "arbitrum",
    wanted: "USDT0" as const,
    amount: "12.5",
    destination: " GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI ",
    priority: "best" as const,
    rails: { Circle: true, Axelar: true, LayerZero: true },
    send: "USDT0" as const,
  };

  function quoteWith(
    assets: (chainId: string) => Promise<{ from: Asset; to: Asset }>,
    rail: Recorder,
  ): Promise<RouteSet> {
    return new Promise((resolve) => {
      runQuote(
        {
          ...engine,
          usdt0Assets: assets,
          rpc: new RpcClient({ url: "https://example.invalid" }),
          usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
          sponsorTerms: async () => ({
            network: "testnet",
            reserveFunding: "sponsor" as const,
            minDeliveryBaseUnits: 1_000_000n,
          }),
          adapters: [rail],
          breaker,
          xlmSwap: {
            provider: new SdexProvider("testnet"),
            delivered: engine.usdcOnStellar,
            deliveredContract: engine.usdcOnStellar.id,
            wanted: engine.xlmOnStellar,
            wantedContract: "native",
          },
          integratorFee: undefined,
        },
        inputs,
        () => {},
        resolve,
      );
    });
  }

  it("asks the rails for USDT0 into its Stellar asset, counted in the token's decimals", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    await quoteWith(usdt0Assets, rail);
    expect(rail.requests).toHaveLength(1);
    const request = rail.requests[0];
    expect(request?.from).toEqual(usdt0From);
    expect(request?.to).toEqual(usdt0To);
    expect(request?.sends).toEqual({ asset: usdt0From, baseUnits: "12500000" });
    expect(request?.destination).toBe("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI");
  });

  it("declines every rail with the deployment's own reason when the chain has none", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    const set = await quoteWith(async () => {
      throw new MavnaError("This route carries no token on the test network.", {
        retryable: false,
      });
    }, rail);
    expect(rail.requests).toEqual([]);
    expect(set.rejected).toEqual([
      {
        source: "layerzero",
        reason: "asset-unsupported",
        explanation: "This route carries no token on the test network.",
        retryable: false,
      },
    ]);
  });

  it("calls a node that did not answer temporary, not a missing route", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    const set = await quoteWith(async () => {
      throw new MavnaError("No usable node answered for chain 42161.", { retryable: true });
    }, rail);
    expect(set.rejected[0]?.reason).toBe("temporarily-unavailable");
    expect(set.rejected[0]?.retryable).toBe(true);
  });

  it("declines a new-account USDT0 route, saying the sponsor only curates USDC", () => {
    const fresh = routeFor("layerzero", { newAccount: true, delivers: usdt0To });
    const ready = routeFor("layerzero", { delivers: usdt0To });
    const set = declineUnsettleable(
      { routes: [fresh, ready], rejected: [], complete: true },
      engine.usdcOnStellar.id,
    );
    expect(set.routes).toEqual([ready]);
    expect(set.rejected[0]?.explanation).toMatch(/the sponsor curates/);
    expect(set.rejected[0]?.explanation).toMatch(/this route delivers USDT0\.$/);
  });

  it("shows the transfer fee in the asset it is charged in", () => {
    const route = routeFor("layerzero", { delivers: usdt0To });
    const charged = {
      ...route,
      sends: { asset: usdt0From, baseUnits: "5000000" },
      fees: [
        {
          kind: "bridge" as const,
          total: { asset: usdt0From, baseUnits: "1000" },
          recipients: [],
          includedInQuote: true,
        },
      ],
    };
    expect(toRouteView(charged).feeSymbol).toBe("USD₮0");
    expect(toRouteView(route).feeSymbol).toBe("USDC");
  });
});
