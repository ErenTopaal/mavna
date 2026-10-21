import { CCTP_CONTRACTS, sourceUsdcFor } from "@mavna/adapter-cctp";
import {
  type Asset,
  type BridgeAdapter,
  type ComposeQuoteRequest,
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
  approvalsLabel,
  buildAssets,
  declineUnsettleable,
  railsLabel,
  runQuote,
  type SponsorCheck,
  toRouteView,
  trustlineName,
} from "./quote";
import { usdt0SwapFor } from "./usdt0";

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
  // Horizon's order book, at its boundary: 10 XLM to the USDC
  xlmStroopsPerUsdc: async () => 100_000_000n,
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
        ext: xdr.AccountEntryExt.v0(),
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
    usdt0Swap: () => {
      throw new Error("a USDC send never converts USDT0");
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

  it("asks neither the sponsor nor any rail while there is no recipient", () => {
    let asked = 0;
    const finals: RouteSet[] = [];
    runQuote(
      {
        ...quoting,
        sponsorTerms: () => {
          asked += 1;
          return new Promise(() => {});
        },
      },
      { ...inputs, chainId: "arbitrum-sepolia", destination: "  " },
      () => {},
      (set) => finals.push(set),
    );
    expect(asked).toBe(0);
    expect(finals).toEqual([{ routes: [], rejected: [], complete: true }]);
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

  it("declines nothing on a sponsor that fronts reserves, above its minimum", () => {
    const [fresh, ready] = [routeFor("cctp", { newAccount: true }), routeFor("layerzero")];
    const set = applySponsorTerms(
      { routes: [fresh, ready], rejected: [], complete: true },
      // 10 XLM to the USDC, so the repayment may take at most 0.3 of the 5 arriving
      {
        network: "testnet",
        terms: sponsorFunded,
        destination: "exists",
        xlmStroopsPerUsdc: 100_000_000n,
      },
    );
    // the new account's repayment is one more approval, and a preparation the
    // sponsor has to build again may ask for one more after that
    expect(set.routes).toEqual([
      {
        ...fresh,
        // the most the repayment may take of what arrives, shown on its own line
        fees: [
          ...fresh.fees,
          {
            kind: "reserve-repayment",
            total: { asset: fresh.deliveredAtLeast.asset, baseUnits: "3000000" },
            recipients: [],
            includedInQuote: false,
          },
        ],
        signaturesRequired: fresh.signaturesRequired + 2,
        optionalSignatures: (fresh.optionalSignatures ?? 0) + 1,
      },
      ready,
    ]);
    expect(set.rejected).toEqual([]);
  });

  it("declines a sponsored setup whose arrival could not cover the most its repayment may take", () => {
    const fresh = routeFor("layerzero", { newAccount: true });
    // at 0.5 XLM to the USDC the 1.5 XLM reserve may take up to 6 USDC; 5 arrive
    const set = applySponsorTerms(
      { routes: [fresh], rejected: [], complete: true },
      {
        network: "testnet",
        terms: sponsorFunded,
        destination: "missing",
        xlmStroopsPerUsdc: 5_000_000n,
      },
    );
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]).toMatchObject({ source: "layerzero", reason: "amount-too-small" });
    expect(set.rejected[0]?.explanation).toMatch(/up to 6\.00 USDC.*at least 5\.00 USDC arrive/);
  });

  it("declines a sponsored setup it could not price, rather than guessing", () => {
    const fresh = routeFor("axelar", { newAccount: true });
    const set = applySponsorTerms(
      { routes: [fresh], rejected: [], complete: true },
      {
        network: "testnet",
        terms: sponsorFunded,
        destination: "missing",
        xlmStroopsPerUsdc: new Error("The order book has no bids."),
      },
    );
    expect(set.rejected[0]).toMatchObject({ reason: "temporarily-unavailable" });
    expect(set.rejected[0]?.explanation).toMatch(/no bids/);
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
    over: { wanted?: "USDT0" | "USDC" | "XLM" } = {},
    usdcOnStellar: Asset = engine.usdcOnStellar,
    engineOver: Record<string, unknown> = {},
  ): Promise<RouteSet> {
    return new Promise((resolve) => {
      runQuote(
        {
          ...engine,
          usdcOnStellar,
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
          usdt0Swap: (usdt0: Asset, wanted: Asset) =>
            usdt0SwapFor("mainnet", new SdexProvider("mainnet"), usdt0, wanted),
          xlmSwap: {
            provider: new SdexProvider("testnet"),
            delivered: engine.usdcOnStellar,
            deliveredContract: engine.usdcOnStellar.id,
            wanted: engine.xlmOnStellar,
            wantedContract: "native",
          },
          integratorFee: undefined,
          ...engineOver,
        },
        { ...inputs, ...over },
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

  /** A LayerZero double that quotes a plain route and records the compose ask. */
  class Composing extends Recorder {
    readonly composeAsks: ComposeQuoteRequest[] = [];
    override async quote(request?: QuoteRequest): Promise<RouteRejection> {
      return super.quote(request);
    }
    async quoteCompose(request: ComposeQuoteRequest): Promise<undefined> {
      this.composeAsks.push(request);
      return undefined;
    }
  }

  it.each([
    ["USDC", "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],
    ["XLM", "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"],
  ] as const)("races a conversion on arrival for USDT0 into %s", async (wanted, wantedContract) => {
    const rail = new Composing("layerzero", [{ phase: "idle" }]);
    const plain = routeFor("layerzero", { delivers: usdt0To });
    rail.quote = async (request?: QuoteRequest) => {
      if (request !== undefined) rail.requests.push(request);
      return plain as never;
    };
    // USDT0 is mainnet only, so the USDC it converts into is mainnet's
    const mainnetUsdc: Asset = {
      ...engine.usdcOnStellar,
      chainId: "stellar",
      id: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    };
    await quoteWith(usdt0Assets, rail, { wanted }, mainnetUsdc);
    // the rail is still asked for USDT0, what it can deliver
    expect(rail.requests[0]?.to).toEqual(usdt0To);
    expect(rail.composeAsks).toHaveLength(1);
    const ask = rail.composeAsks[0];
    expect(ask?.arriving).toEqual(usdt0To);
    // the token contract LayerZero delivers on Stellar, read on mainnet
    expect(ask?.arrivingContract).toBe("CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF");
    expect(ask?.wantedContract).toBe(wantedContract);
    expect(ask?.to.symbol).toBe(wanted);
  });

  it("declines converting USDT0 into USDC for a recipient that cannot hold USDC", async () => {
    const rail = new Composing("layerzero", [{ phase: "idle" }]);
    const plain = routeFor("layerzero", { delivers: usdt0To });
    rail.quote = async () => plain as never;
    const mainnetUsdc: Asset = {
      ...engine.usdcOnStellar,
      chainId: "stellar",
      id: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    };
    // a venue that prices it, so only the recipient's trustline can stop it
    const pricing = {
      id: "venue",
      quote: async () => ({
        provider: "venue",
        amountOut: "49000000",
        amountOutMinimum: "48700000",
      }),
    };
    const rpc = new RpcClient({
      url: "https://example.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    // the recipient's account exists and holds no USDC trustline
    vi.spyOn(rpc.server, "getLedgerEntries").mockResolvedValue({
      entries: [accountLedger(50_000_000n, 1)],
      latestLedger: 1,
    } as never);
    const set = await quoteWith(usdt0Assets, rail, { wanted: "USDC" }, mainnetUsdc, {
      rpc,
      usdt0Swap: (usdt0: Asset, wanted: Asset) => usdt0SwapFor("mainnet", pricing, usdt0, wanted),
    });
    expect(set.routes.filter((r) => r.steps.some((st) => st.kind === "swap"))).toEqual([]);
    expect(set.rejected.map((r) => r.explanation).join(" ")).toMatch(/cannot hold USDC yet/);
  });

  it("asks for no conversion when USDT0 is what is wanted", async () => {
    const rail = new Composing("layerzero", [{ phase: "idle" }]);
    await quoteWith(usdt0Assets, rail);
    expect(rail.composeAsks).toEqual([]);
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

  it("keeps a node's own words out of every rail's explanation when finding USDT0 fails", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    const said =
      "No OFT on Ethereum can reach Stellar right now. USDT0 at 0x6c96de32cea08842dcc4058c14d3aaad7fa41dee: " +
      "No usable node answered for chain 1. Last problem: https://1rpc.io/eth answered HTTP 503.";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = await quoteWith(async () => {
      throw new MavnaError(said, { retryable: true });
    }, rail);
    expect(set.rejected[0]).toMatchObject({
      reason: "temporarily-unavailable",
      explanation: "USDT0 could not be looked up on this chain just now. Try again in a moment.",
      detail: said,
    });
    expect(set.rejected.map((r) => r.explanation).join(" ")).not.toMatch(/1rpc|HTTP 503|0x6c96/);
    expect(warned.mock.calls.flat().join(" ")).toMatch(/HTTP 503/);
    warned.mockRestore();
  });

  it("gives the operator the refusal's own detail, not only its user sentence", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    const node =
      "No usable node answered for chain 1. Last problem: https://1rpc.io/eth answered HTTP 503.";
    const refusal = Object.assign(
      new MavnaError("LayerZero could not be read for this chain right now.", { retryable: true }),
      { detail: node },
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = await quoteWith(async () => {
      throw refusal;
    }, rail);
    expect(set.rejected[0]?.detail).toContain(node);
    expect(set.rejected[0]?.explanation).not.toContain("1rpc");
    expect(warned.mock.calls.flat().join(" ")).toContain("HTTP 503");
    warned.mockRestore();
  });

  it("shows a final refusal in its own words, its detail only to the operator", async () => {
    const rail = new Recorder("layerzero", [{ phase: "idle" }]);
    const refusal = Object.assign(
      new MavnaError("No OFT on this chain reaches Stellar.", { retryable: false }),
      { detail: "peers(30401) returned 0x00 from https://node.example" },
    );
    const set = await quoteWith(async () => {
      throw refusal;
    }, rail);
    expect(set.rejected[0]?.explanation).toBe("No OFT on this chain reaches Stellar.");
    expect(set.rejected[0]?.detail).toContain("node.example");
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
            usdt0Swap: () => {
              throw new Error("this quote wants USDT0 itself");
            },
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
    expect(sponsored.rejected[0]?.explanation).toMatch(/cannot hold USDT0 yet/);
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
  /** The route as offered: the account signs the delivery too. */
  const counted = (route: ReturnType<typeof routeFor>) => ({
    ...route,
    signaturesRequired: route.signaturesRequired + 1,
  });
  const only = (route: ReturnType<typeof routeFor>, spare: bigint | undefined) =>
    applySponsorTerms({ routes: [route], rejected: [], complete: true }, check(spare));

  it("is offered to an account that can spare the delivery fee", () => {
    const route = routeFor("cctp");
    expect(only(route, OWN_DELIVERY_FEE_BUDGET_STROOPS).routes).toEqual([counted(route)]);
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
    expect(only(route, enough).routes).toEqual([counted(route)]);
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
    expect(only(small, OWN_DELIVERY_FEE_BUDGET_STROOPS).routes).toEqual([counted(small)]);
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
            usdt0Swap: () => {
              throw new Error("a USDC send never converts USDT0");
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
    expect((await quoted()).routes).toEqual([counted(route)]);
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

describe("how many approvals a route asks for", () => {
  it("counts the repayment the user signs when the sponsor fronts the reserve, and not otherwise", () => {
    const fresh = routeFor("layerzero", { newAccount: true });
    const set = { routes: [fresh], rejected: [], complete: true };
    expect(applySponsorTerms(set, terms("sponsor")).routes[0]?.signaturesRequired).toBe(
      fresh.signaturesRequired + 2,
    );
    // paying its own reserve, the account signs a trustline and no repayment
    expect(applySponsorTerms(set, terms("self")).routes[0]?.signaturesRequired).toBe(
      fresh.signaturesRequired,
    );
  });

  const terms = (reserveFunding: "self" | "sponsor") => ({
    network: "testnet",
    terms: { network: "testnet", reserveFunding, minDeliveryBaseUnits: 0n },
    destination: "exists" as const,
    spareStroops: 100_000_000n,
    baseReserveStroops: 5_000_000,
    xlmStroopsPerUsdc: 100_000_000n,
  });

  it("counts the delivery the receiving account signs for a Circle route when it pays its own", () => {
    const circle = routeFor("cctp");
    const relayed = routeFor("layerzero");
    const set = { routes: [circle, relayed], rejected: [], complete: true };
    const own = applySponsorTerms(set, terms("self"));
    expect(own.routes.map((r) => r.signaturesRequired)).toEqual([
      circle.signaturesRequired + 1,
      relayed.signaturesRequired,
    ]);
    const sponsored = applySponsorTerms(set, terms("sponsor"));
    expect(sponsored.routes.map((r) => r.signaturesRequired)).toEqual([
      circle.signaturesRequired,
      relayed.signaturesRequired,
    ]);
  });
});

describe("a conversion on Stellar the recipient must be able to hold", () => {
  const usdt0: Asset = {
    chainId: "stellar",
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "LayerZero",
  };
  // USDT0 arrives, and the recipient's own signature converts it into USDC
  const converting = (() => {
    const base = routeFor("layerzero", { swap: true, delivers: engine.usdcOnStellar });
    return {
      ...base,
      deliveredAtLeast: { asset: usdt0, baseUnits: "50000000" },
      steps: base.steps.map((s) =>
        s.kind === "swap"
          ? { ...s, from: { asset: usdt0, baseUnits: "50000000" }, to: base.receives }
          : s,
      ),
    };
  })();
  const check = (
    reserveFunding: "self" | "sponsor",
    holdsWanted: SponsorCheck["holdsWanted"],
    spareStroops = 100_000_000n,
  ) => ({
    network: "testnet",
    terms: { network: "testnet", reserveFunding, minDeliveryBaseUnits: 0n },
    destination: "exists" as const,
    spareStroops,
    baseReserveStroops: 5_000_000,
    convertsInto: engine.usdcOnStellar,
    holdsWanted,
  });
  const only = (c: ReturnType<typeof check>) =>
    applySponsorTerms({ routes: [converting], rejected: [], complete: true }, c);

  it("is offered as it is when the recipient can already hold what it converts into", () => {
    expect(only(check("sponsor", "ready")).routes).toEqual([converting]);
  });

  it("is declined at quote time when the recipient cannot hold it and the sponsor would not help", () => {
    const set = only(check("sponsor", "missing"));
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]).toMatchObject({ reason: "destination-unsupported" });
    expect(set.rejected[0]?.explanation).toMatch(/cannot hold USDC yet.*receive USDT0/);
  });

  it("is declined on any terms when the issuer has not authorised the recipient", () => {
    for (const funding of ["self", "sponsor"] as const) {
      expect(only(check(funding, "unauthorized")).rejected[0]?.explanation).toMatch(
        /not authorised/,
      );
    }
  });

  it("is declined with the node's reason when the trustline cannot take the arrival", () => {
    for (const funding of ["self", "sponsor"] as const) {
      const set = only(check(funding, { unusable: "Its USDC trustline is at its limit." }));
      expect(set.routes).toEqual([]);
      expect(set.rejected[0]?.explanation).toMatch(/at its limit.*Receive USDT0 instead/);
    }
  });

  it("is offered with one more approval when the account opens the trustline itself", () => {
    const set = only(check("self", "missing"));
    expect(set.routes.map((r) => r.signaturesRequired)).toEqual([
      converting.signaturesRequired + 1,
    ]);
  });

  it("is declined when the account cannot spare the reserve for that trustline", () => {
    const set = only(check("self", "missing", 5_000_000n));
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/0\.5 XLM to hold USDC/);
  });

  it("says it could not check rather than guessing", () => {
    expect(only(check("sponsor", new Error("node down"))).rejected[0]).toMatchObject({
      reason: "temporarily-unavailable",
      retryable: true,
    });
  });
});

describe("a conversion on arrival's cost to finish by hand", () => {
  it("is carried to the route view in XLM, and left out when it could not be priced", () => {
    const base = routeFor("layerzero");
    const compose = {
      contract: "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ",
      venue: "aquarius",
      arriving: base.receives.asset,
      arrivingContract: "C1",
      wanted: base.receives.asset,
      wantedContract: "C2",
      minOut: "1",
      path: [],
      fee: undefined,
      trust: "t",
      walletNote: "w",
      fallback: "f",
    };
    expect(
      toRouteView({ ...base, compose: { ...compose, finishCostStroops: "2070159" } }).compose
        ?.finishXlm,
    ).toBe("0.2070159");
    expect(toRouteView({ ...base, compose }).compose?.finishXlm).toBeUndefined();
  });
});

describe("the rails status line", () => {
  it("counts what is on out of the rails actually configured, not a fixed three", () => {
    const all = { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true };
    expect(railsLabel(all, ["Circle", "Axelar", "LayerZero", "NEAR Intents"])).toBe("4 of 4");
    expect(railsLabel({ ...all, Axelar: false }, ["Circle", "Axelar", "LayerZero"])).toBe("2 of 3");
  });
});

describe("a quote that fails as a whole", () => {
  it("says why for every rail rather than ending in an empty list", async () => {
    const broken = {
      reasonFor: () => {
        throw new Error("the breaker could not be read");
      },
    };
    const set = await new Promise<RouteSet>((resolve) => {
      runQuote(
        {
          ...engine,
          adapters: [new ScriptedAdapter("cctp", [{ phase: "idle" }])],
          breaker: broken as never,
          xlmSwap: undefined as never,
          integratorFee: undefined,
          rpc: new RpcClient({ url: "https://example.invalid" }),
          usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
          sponsorTerms: async () => ({
            network: "testnet",
            reserveFunding: "sponsor" as const,
            minDeliveryBaseUnits: 0n,
          }),
          usdt0Assets: async () => {
            throw new Error("not asked");
          },
          usdt0Swap: () => {
            throw new Error("not asked");
          },
        },
        {
          chainId: "ethereum-sepolia",
          wanted: "USDC",
          amount: "5",
          destination: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
          priority: "best",
          rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
        },
        () => {},
        resolve,
      );
    });
    expect(set.complete).toBe(true);
    expect(set.rejected).toEqual([
      {
        source: "cctp",
        reason: "temporarily-unavailable",
        explanation: expect.stringMatching(/breaker could not be read/),
        retryable: true,
      },
    ]);
  });
});

describe("the reason a sponsor-funded route cannot set up a trustline", () => {
  const usdt0: Asset = {
    chainId: "stellar",
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "LayerZero",
  };
  const set = () => ({
    routes: [routeFor("layerzero", { newAccount: true, delivers: usdt0 })],
    rejected: [],
    complete: true,
  });

  it("speaks of the account that exists as one that cannot hold the asset yet", () => {
    const why = declineUnsettleable(set(), engine.usdcOnStellar.id, "sponsor", "exists").rejected[0]
      ?.explanation;
    expect(why).toMatch(/cannot hold USDT0 yet/);
    expect(why).not.toMatch(/new Stellar account/);
  });

  it("speaks of a new account only when there is none", () => {
    const why = declineUnsettleable(set(), engine.usdcOnStellar.id, "sponsor", "missing")
      .rejected[0]?.explanation;
    expect(why).toMatch(/new Stellar account/);
  });
});

describe("a conversion on a route whose arrival repays the sponsor", () => {
  const fronted = (() => {
    const base = routeFor("cctp", { newAccount: true });
    return {
      ...base,
      fees: [
        {
          kind: "account-reserve" as const,
          total: { asset: engine.xlmOnStellar, baseUnits: "15000000" },
          recipients: [],
          includedInQuote: true,
        },
      ],
    };
  })();
  const atFive = {
    id: "venue",
    quote: async (q: { amountIn: string }) => {
      const out = (BigInt(q.amountIn) * 5n).toString();
      return { provider: "venue", amountOut: out, amountOutMinimum: out };
    },
  };
  const quoted = (reserveFunding: "self" | "sponsor") =>
    new Promise<RouteSet>((resolve) => {
      const rpc = new RpcClient({
        url: "https://example.invalid",
        baseDelayMs: 0,
        sleep: async () => {},
      });
      vi.spyOn(rpc.server, "getLedgerEntries").mockResolvedValue({
        entries: [accountLedger(500_000_000n, 0)],
        latestLedger: 1,
      } as never);
      runQuote(
        {
          ...engine,
          adapters: [quotingOnce(fronted)],
          breaker: createCircuitBreaker(() => parseDisabledSources(undefined)),
          xlmSwap: {
            provider: atFive,
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
          usdt0Assets: async () => {
            throw new Error("not asked");
          },
          usdt0Swap: () => {
            throw new Error("not asked");
          },
        },
        {
          chainId: "ethereum-sepolia",
          wanted: "XLM",
          amount: "5",
          destination: fronted.destination,
          priority: "best",
          rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
        },
        () => {},
        resolve,
      );
    });

  it("leaves the repayment aside and shows it as its own line when the sponsor fronts the reserve", async () => {
    const [route] = (await quoted("sponsor")).routes;
    const repayment = route?.fees.find((f) => f.kind === "reserve-repayment");
    expect(repayment?.total.baseUnits).toBe("6000000");
    expect(route && toRouteView(route).repaymentSetAside).toEqual({ amount: 0.6, symbol: "USDC" });
  });

  it("sets nothing aside when the account pays its own reserve", async () => {
    const [route] = (await quoted("self")).routes;
    expect(route?.fees.some((f) => f.kind === "reserve-repayment")).toBe(false);
  });
});

describe("the approvals a route will ask for", () => {
  it("is shown as at most that many when some may be skipped", () => {
    const route = { ...routeFor("layerzero"), signaturesRequired: 3, optionalSignatures: 1 };
    expect(approvalsLabel(toRouteView(route))).toBe("Up to 3 steps");
    const every = { ...routeFor("layerzero"), signaturesRequired: 2 };
    expect(approvalsLabel(toRouteView(every))).toBe("2 steps");
  });
});

describe("a conversion the recipient pays the network fee for", () => {
  // the conversion on Stellar is the recipient's own transaction, so an account
  // with no XLM to spare cannot send it: a live Arc transfer to a zero-XLM
  // account arrived and its conversion failed with txINSUFFICIENT_BALANCE
  const intoXlm = routeFor("cctp", { swap: true, delivers: STELLAR_XLM });
  const terms = {
    network: "testnet",
    reserveFunding: "sponsor" as const,
    minDeliveryBaseUnits: 0n,
  };
  const offered = (
    spareStroops: bigint | undefined,
    destination: "exists" | "missing" = "exists",
  ) =>
    applySponsorTerms(
      { routes: [intoXlm], rejected: [], complete: true },
      {
        network: "testnet",
        terms,
        destination,
        spareStroops,
        baseReserveStroops: 5_000_000,
        xlmStroopsPerUsdc: 100_000_000n,
      },
    );

  it("is declined for an account with no XLM to spare, saying why and what to do", () => {
    const set = offered(0n);
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]).toMatchObject({ reason: "destination-unsupported" });
    expect(set.rejected[0]?.explanation).toMatch(/network fee/);
    expect(set.rejected[0]?.explanation).toMatch(/0 XLM to spare/);
    expect(set.rejected[0]?.explanation).toMatch(/Receive USDC/);
  });

  it("is offered to an account that can spare the fee", () => {
    expect(offered(100_000_000n).routes).toEqual([intoXlm]);
  });

  it("is declined into a new account, which is set up holding only its minimum", () => {
    const fresh = routeFor("cctp", { newAccount: true, swap: true, delivers: STELLAR_XLM });
    const set = applySponsorTerms(
      { routes: [fresh], rejected: [], complete: true },
      {
        network: "testnet",
        terms,
        destination: "missing",
        baseReserveStroops: 5_000_000,
        xlmStroopsPerUsdc: 100_000_000n,
      },
    );
    expect(set.routes).toEqual([]);
    expect(set.rejected[0]?.explanation).toMatch(/network fee/);
  });
});

describe("a new account's reserve repaid from USDC that arrives as USDC", () => {
  // a live Sepolia transfer to a new account was reviewed as "You receive 1.50
  // USDC"; the settlement then took 0.37875 USDC of it to repay the reserve
  const fresh = routeFor("cctp", { newAccount: true });
  const set = applySponsorTerms(
    { routes: [fresh], rejected: [], complete: true },
    {
      network: "testnet",
      terms: { network: "testnet", reserveFunding: "sponsor", minDeliveryBaseUnits: 0n },
      destination: "missing",
      // 10 XLM to the USDC: the 1.5 XLM reserve may take up to 0.3 USDC
      xlmStroopsPerUsdc: 100_000_000n,
    },
  );

  it("carries the most the repayment may take of the arrival", () => {
    const repayment = set.routes[0]?.fees.find((f) => f.kind === "reserve-repayment");
    expect(repayment?.total).toEqual({ asset: fresh.deliveredAtLeast.asset, baseUnits: "3000000" });
    expect(repayment?.includedInQuote).toBe(false);
  });

  it("is shown on the review as taken from what arrives", () => {
    const route = set.routes[0];
    if (route === undefined) throw new Error("declined");
    const view = toRouteView(route);
    expect(view.repaymentSetAside).toEqual({ amount: 0.3, symbol: "USDC" });
  });
});
