import { CCTP_CONTRACTS, sourceUsdcFor } from "@mavna/adapter-cctp";
import {
  type Asset,
  type BridgeAdapter,
  MavnaError,
  type QuoteRequest,
  type RouteRejection,
  type RouteSet,
} from "@mavna/core";
import { createCircuitBreaker, parseDisabledSources } from "@mavna/routing";
import { RpcClient } from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { routeFor, ScriptedAdapter, SOURCE_USDC, STELLAR_XLM } from "./__fixtures__/scripted";
import { OWN_DELIVERY_FEE_BUDGET_STROOPS } from "./own-delivery";
import {
  applySponsorTerms,
  assetsFor,
  buildAssets,
  declineUnsettleable,
  runQuote,
  toRouteView,
  trustlineName,
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
  baseReserveStroops: 5_000_000,
  usdcOnStellar: stellar(`USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`, "USDC", 7),
  xlmOnStellar: stellar("native", "XLM", 7),
};

/** An account entry the way the Stellar node returns it. */
function accountLedger(balance: bigint, subEntries: number) {
  return {
    val: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: Keypair.random().xdrAccountId(),
        balance: xdr.Int64.fromString(balance.toString()),
        seqNum: xdr.Int64.fromString("1"),
        numSubEntries: subEntries,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: new xdr.AccountEntryExt(0),
      }),
    ),
  };
}

/** A rail that quotes one route, the way a real one answers. */
function quotingOnce(route: ReturnType<typeof routeFor>): BridgeAdapter {
  const scripted = new ScriptedAdapter(route.source, [{ phase: "idle" }]);
  return {
    id: route.source,
    trustModel: scripted.trustModel,
    supportedChains: () => scripted.supportedChains(),
    quote: async () => route,
    buildTransactions: (r, context) => scripted.buildTransactions(r, context),
    status: (handle) => scripted.status(handle),
  };
}

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
    rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
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

describe("a trustline an account opens with its own XLM", () => {
  const usdt0: Asset = {
    chainId: "stellar",
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "LayerZero",
  };
  const eurc: Asset = { ...usdt0, id: `EURC:${CCTP_CONTRACTS.testnet.usdcIssuer}`, symbol: "EURC" };

  it("keeps a USDT0 trustline when the account pays its own reserve, and declines it when the sponsor would", () => {
    const route = routeFor("layerzero", { newAccount: true, delivers: usdt0 });
    const set = { routes: [route], rejected: [], complete: true };
    expect(declineUnsettleable(set, engine.usdcOnStellar.id, "self").routes).toEqual([route]);
    expect(declineUnsettleable(set, engine.usdcOnStellar.id, "sponsor").routes).toEqual([]);
  });

  it("still declines one to an asset the sponsor does not curate", () => {
    const route = routeFor("layerzero", { newAccount: true, delivers: eurc });
    const set = declineUnsettleable(
      { routes: [route], rejected: [], complete: true },
      engine.usdcOnStellar.id,
      "self",
    );
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/USDC or USDT0.*delivers EURC\.$/);
  });

  it("names the curated asset the preparation asks for", () => {
    const usdc = engine.usdcOnStellar.id;
    expect(trustlineName(routeFor("layerzero", { newAccount: true }), usdc)).toBe("USDC");
    expect(trustlineName(routeFor("layerzero", { newAccount: true, delivers: usdt0 }), usdc)).toBe(
      "USDT0",
    );
    expect(
      trustlineName(routeFor("layerzero", { newAccount: true, delivers: eurc }), usdc),
    ).toBeUndefined();
  });

  it("offers a USDT0 route to an existing account without the trustline when it pays its own reserve", async () => {
    const route = routeFor("layerzero", { newAccount: true, delivers: usdt0 });
    const rpc = new RpcClient({
      url: "https://example.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    vi.spyOn(rpc.server, "getLedgerEntries").mockResolvedValue({
      entries: [accountLedger(50_000_000n, 0)],
      latestLedger: 1,
    } as never);
    const quoted = (reserveFunding: "self" | "sponsor") =>
      new Promise<RouteSet>((resolve) => {
        runQuote(
          {
            ...engine,
            adapters: [quotingOnce(route)],
            breaker: createCircuitBreaker(() => parseDisabledSources(undefined)),
            xlmSwap: {
              provider: new SdexProvider("testnet"),
              delivered: engine.usdcOnStellar,
              deliveredContract: engine.usdcOnStellar.id,
              wanted: engine.xlmOnStellar,
              wantedContract: "native",
            },
            integratorFee: undefined,
            rpc,
            usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
            sponsorTerms: async () => ({
              network: "testnet",
              reserveFunding,
              minDeliveryBaseUnits: 0n,
            }),
            usdt0Assets: async () => ({ from: SOURCE_USDC, to: usdt0 }),
          },
          {
            chainId: "arbitrum",
            wanted: "USDT0",
            amount: "5",
            destination: route.destination,
            priority: "best",
            rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
            send: "USDT0",
          },
          () => {},
          resolve,
        );
      });
    expect((await quoted("self")).routes).toEqual([route]);
    const sponsored = await quoted("sponsor");
    expect(sponsored.routes).toEqual([]);
    expect(sponsored.rejected[0]?.explanation).toMatch(/the sponsor curates/);
  });
});

describe("a Circle transfer whose receiving account pays its own delivery", () => {
  const selfFunded = {
    network: "testnet",
    reserveFunding: "self" as const,
    minDeliveryBaseUnits: 1_000_000n,
  };
  const check = (spareStroops: bigint | undefined) => ({
    network: "testnet",
    terms: selfFunded,
    destination: "exists" as const,
    spareStroops,
    baseReserveStroops: 5_000_000,
  });
  const only = (route: ReturnType<typeof routeFor>, spare: bigint | undefined) =>
    applySponsorTerms({ routes: [route], rejected: [], complete: true }, check(spare));

  it("is offered to an account that can spare the delivery fee", () => {
    const route = routeFor("cctp");
    expect(only(route, OWN_DELIVERY_FEE_BUDGET_STROOPS).routes).toEqual([route]);
  });

  it("is declined, with what it costs and what the account has, when it cannot", () => {
    const set = only(routeFor("cctp"), OWN_DELIVERY_FEE_BUDGET_STROOPS - 1n);
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]).toMatchObject({ source: "cctp", reason: "destination-unsupported" });
    expect(set.rejected[0]?.explanation).toMatch(
      /pays for Circle's delivery on Stellar from its own XLM: up to 0\.1 XLM, and it has 0\.0999999 XLM to spare/,
    );
  });

  it("counts the trustline's reserve too when the account must open one", () => {
    const route = routeFor("cctp", { newAccount: true });
    const enough = OWN_DELIVERY_FEE_BUDGET_STROOPS + 5_000_000n + 1_000n;
    expect(only(route, enough).routes).toEqual([route]);
    const set = only(route, enough - 1n);
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/plus 0\.5 XLM to hold USDC/);
  });

  it("is declined for an address that cannot sign for its own account", () => {
    const set = only(routeFor("cctp"), undefined);
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/ordinary G account/);
  });

  it("is not held to the sponsor's minimum delivery, which only guards the sponsor's XLM", () => {
    const small = {
      ...routeFor("cctp"),
      sends: { asset: SOURCE_USDC, baseUnits: "10" },
    };
    expect(only(small, OWN_DELIVERY_FEE_BUDGET_STROOPS).routes).toEqual([small]);
  });

  it("leaves rails that deliver by themselves alone", () => {
    const route = routeFor("layerzero");
    expect(only(route, 0n).routes).toEqual([route]);
  });

  it("reads the account's spare XLM from the network at quote time", async () => {
    const route = routeFor("cctp");
    const rpc = new RpcClient({
      url: "https://example.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    let balance = 0n;
    vi.spyOn(rpc.server, "getLedgerEntries").mockImplementation(
      async () => ({ entries: [accountLedger(balance, 1)], latestLedger: 1 }) as never,
    );
    const quoted = () =>
      new Promise<RouteSet>((resolve) => {
        runQuote(
          {
            ...engine,
            adapters: [quotingOnce(route)],
            breaker: createCircuitBreaker(() => parseDisabledSources(undefined)),
            xlmSwap: {
              provider: new SdexProvider("testnet"),
              delivered: engine.usdcOnStellar,
              deliveredContract: engine.usdcOnStellar.id,
              wanted: engine.xlmOnStellar,
              wantedContract: "native",
            },
            integratorFee: undefined,
            rpc,
            usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
            sponsorTerms: async () => selfFunded,
            usdt0Assets: async () => {
              throw new Error("a USDC send never asks for USDT0");
            },
          },
          {
            chainId: "arbitrum-sepolia",
            wanted: "USDC",
            amount: "5",
            destination: route.destination,
            priority: "best",
            rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
          },
          () => {},
          resolve,
        );
      });
    // one subentry: a minimum of 1.5 XLM
    balance = 15_000_000n + OWN_DELIVERY_FEE_BUDGET_STROOPS;
    expect((await quoted()).routes).toEqual([route]);
    balance -= 1n;
    expect((await quoted()).routes).toEqual([]);
  });
});

describe("a route whose receiving account opens its own trustline", () => {
  const usdt0: Asset = {
    chainId: "stellar",
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "LayerZero",
  };
  const selfFunded = {
    network: "testnet",
    reserveFunding: "self" as const,
    minDeliveryBaseUnits: 0n,
  };
  const check = (destination: "exists" | "missing", spareStroops?: bigint) => ({
    network: "testnet",
    terms: selfFunded,
    destination,
    spareStroops,
    baseReserveStroops: 5_000_000,
  });

  it("names the asset it would hold when the account does not exist yet", () => {
    const set = applySponsorTerms(
      {
        routes: [routeFor("layerzero", { newAccount: true, delivers: usdt0 })],
        rejected: [],
        complete: true,
      },
      check("missing"),
    );
    expect(set.rejected[0]?.explanation).toMatch(/0\.5 to hold USDT0/);
    expect(set.rejected[0]?.explanation).not.toMatch(/USDC/);
  });

  it("is declined at quote time when the account cannot spare the reserve, on any rail", () => {
    const route = routeFor("layerzero", { newAccount: true, delivers: usdt0 });
    const enough = 5_000_000n + 1_000n;
    const offered = applySponsorTerms(
      { routes: [route], rejected: [], complete: true },
      check("exists", enough),
    );
    expect(offered.routes).toEqual([route]);
    const short = applySponsorTerms(
      { routes: [route], rejected: [], complete: true },
      check("exists", enough - 1n),
    );
    expect(short.routes).toEqual([]);
    expect(short.rejected[0]).toMatchObject({ reason: "destination-unsupported" });
    expect(short.rejected[0]?.explanation).toMatch(
      /0\.5 XLM to hold USDT0.*0\.5000999 XLM to spare/,
    );
  });
});
