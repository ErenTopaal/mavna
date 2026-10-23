import { CCTP_CONTRACTS } from "@mavna/adapter-cctp";
import type {
  Asset,
  BridgeAdapter,
  QuoteRequest,
  Route,
  RouteRejection,
  RouteSet,
} from "@mavna/core";
import { createCircuitBreaker, parseDisabledSources } from "@mavna/routing";
import { RpcClient } from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";
import { describe, expect, it, vi } from "vitest";
import { routeFor, ScriptedAdapter } from "./__fixtures__/scripted";
import { runQuote, visibleDeclines } from "./quote";
import { usdt0SwapFor } from "./usdt0";

/**
 * NEAR Intents delivers XLM and USDC on Stellar itself, so on a USDT0 send it
 * is asked for what the user wants, while LayerZero is asked for USDT0 and the
 * conversion is attached to its route.
 */

const usdt0From: Asset = {
  chainId: "ethereum",
  id: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  symbol: "USDT",
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
const usdc: Asset = {
  chainId: "stellar",
  id: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};
const xlm: Asset = {
  chainId: "stellar",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

/** Records what it is asked, and answers with a route or a rail's decline. */
class Recorder extends ScriptedAdapter {
  readonly requests: QuoteRequest[] = [];
  answer: ((request: QuoteRequest) => Route) | undefined;
  override async quote(request?: QuoteRequest): Promise<RouteRejection> {
    if (request !== undefined) this.requests.push(request);
    if (request !== undefined && this.answer !== undefined) return this.answer(request) as never;
    return super.quote();
  }
}

function quote(
  adapters: BridgeAdapter[],
  wanted: "USDT0" | "USDC" | "XLM",
  over: Record<string, unknown> = {},
): Promise<RouteSet> {
  const rpc = new RpcClient({
    url: "https://example.invalid",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  // an account that exists and holds every trustline asked about
  vi.spyOn(rpc.server, "getLedgerEntries").mockResolvedValue({
    entries: [],
    latestLedger: 1,
  } as never);
  return new Promise((resolve) => {
    runQuote(
      {
        network: "mainnet",
        baseReserveStroops: 5_000_000,
        usdcOnStellar: usdc,
        xlmOnStellar: xlm,
        xlmStroopsPerUnit: async () => 51_876_162n,
        repaymentCost: async () => 2_808_399n,
        rpc,
        usdcIssuer: CCTP_CONTRACTS.mainnet.usdcIssuer,
        sponsorTerms: async () => ({
          network: "mainnet",
          reserveFunding: "sponsor" as const,
          minDeliveryBaseUnits: 0n,
          lends: ["USDC", "USDT0"],
        }),
        adapters,
        breaker: createCircuitBreaker(() => parseDisabledSources(undefined)),
        usdt0Assets: async () => ({ from: usdt0From, to: usdt0To }),
        usdt0Swap: (from: Asset, to: Asset) =>
          usdt0SwapFor("mainnet", new SdexProvider("mainnet"), from, to),
        xlmSwap: {
          provider: new SdexProvider("mainnet"),
          delivered: usdc,
          deliveredContract: usdc.id,
          wanted: xlm,
          wantedContract: "native",
        },
        integratorFee: undefined,
        ...over,
      },
      {
        chainId: "ethereum",
        wanted,
        amount: "100",
        destination: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        priority: "best",
        rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
        send: "USDT0",
      },
      () => {},
      resolve,
    );
  });
}

describe("a USDT0 send through NEAR Intents", () => {
  it.each([
    ["XLM", xlm],
    ["USDC", usdc],
  ] as const)("asks NEAR Intents for %s itself, and LayerZero for USDT0", async (wanted, asset) => {
    const near = new Recorder("near-intents", [{ phase: "idle" }]);
    const layerzero = new Recorder("layerzero", [{ phase: "idle" }]);
    await quote([near, layerzero], wanted);
    expect(near.requests[0]?.to).toEqual(asset);
    expect(near.requests[0]?.from).toEqual(usdt0From);
    expect(layerzero.requests[0]?.to).toEqual(usdt0To);
  });

  it("asks NEAR Intents for USDT0 when USDT0 is what is wanted", async () => {
    const near = new Recorder("near-intents", [{ phase: "idle" }]);
    await quote([near], "USDT0");
    expect(near.requests[0]?.to).toEqual(usdt0To);
  });

  it("offers NEAR Intents' XLM as it comes, with no conversion to sign", async () => {
    const near = new Recorder("near-intents", [{ phase: "idle" }]);
    near.answer = () => routeFor("near-intents", { delivers: xlm });
    const set = await quote([near], "XLM");
    expect(set.rejected).toEqual([]);
    expect(set.routes[0]?.steps.map((s) => s.kind)).toEqual(["bridge"]);
    expect(set.routes[0]?.receives.asset).toEqual(xlm);
  });

  it("prices a new account's repayment on what NEAR Intents delivers, not on USDT0", async () => {
    const near = new Recorder("near-intents", [{ phase: "idle" }]);
    near.answer = () => routeFor("near-intents", { newAccount: true, delivers: usdc });
    const priced: string[] = [];
    const costed: string[] = [];
    const set = await quote([near], "USDC", {
      xlmStroopsPerUnit: async (asset: Asset) => {
        priced.push(asset.id);
        return 100_000_000n;
      },
      repaymentCost: async (asset: Asset, stroops: bigint) => {
        costed.push(asset.id);
        return stroops / 10n;
      },
    });
    expect(set.rejected).toEqual([]);
    expect(priced).toContain(usdc.id);
    expect(costed).toContain(usdc.id);
    const repays = set.routes[0]?.fees.find((f) => f.kind === "reserve-repayment");
    expect(repays?.total.asset).toEqual(usdc);
  });

  it("never sends a USDC send's NEAR Intents quote anywhere but to USDC", async () => {
    // a USDC send keeps its path: delivered as USDC, converted on Stellar
    const near = new Recorder("near-intents", [{ phase: "idle" }]);
    const rpc = new RpcClient({
      url: "https://example.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    vi.spyOn(rpc.server, "getLedgerEntries").mockResolvedValue({
      entries: [],
      latestLedger: 1,
    } as never);
    await new Promise<RouteSet>((resolve) => {
      runQuote(
        {
          network: "testnet",
          baseReserveStroops: 5_000_000,
          usdcOnStellar: usdc,
          xlmOnStellar: xlm,
          xlmStroopsPerUnit: async () => 100_000_000n,
          repaymentCost: async () => 1n,
          rpc,
          usdcIssuer: CCTP_CONTRACTS.testnet.usdcIssuer,
          sponsorTerms: async () => ({
            network: "testnet",
            reserveFunding: "sponsor" as const,
            minDeliveryBaseUnits: 0n,
          }),
          adapters: [near],
          breaker: createCircuitBreaker(() => parseDisabledSources(undefined)),
          usdt0Assets: async () => {
            throw new Error("a USDC send never asks for USDT0");
          },
          usdt0Swap: () => {
            throw new Error("a USDC send never converts USDT0");
          },
          xlmSwap: {
            provider: new SdexProvider("testnet"),
            delivered: usdc,
            deliveredContract: usdc.id,
            wanted: xlm,
            wantedContract: "native",
          },
          integratorFee: undefined,
        },
        {
          chainId: "arbitrum-sepolia",
          wanted: "XLM",
          amount: "5",
          destination: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
          priority: "best",
          rails: { Circle: true, Axelar: true, LayerZero: true, "NEAR Intents": true },
        },
        () => {},
        resolve,
      );
    });
    expect(near.requests[0]?.from.symbol).toBe("USDC");
    expect(near.requests[0]?.to).toEqual(usdc);
  });
});

describe("the declines shown", () => {
  const decline = (source: string, explanation: string, compose?: true): RouteRejection => ({
    source,
    reason: "destination-unsupported",
    explanation,
    retryable: false,
    ...(compose === undefined ? {} : { compose }),
  });

  it("shows one per rail, the plain route's own reason before the compose offer's", () => {
    const shown = visibleDeclines(
      [
        decline("layerzero", "There is no Arrival Contract on mainnet yet.", true),
        decline("layerzero", "It has 0 XLM to spare."),
        decline("near-intents", "NEAR Intents is not quoting right now."),
      ],
      [],
    );
    expect(shown.map((r) => r.explanation)).toEqual([
      "It has 0 XLM to spare.",
      "NEAR Intents is not quoting right now.",
    ]);
  });

  it("shows none for a rail whose route is on the list", () => {
    const shown = visibleDeclines(
      [decline("layerzero", "There is no Arrival Contract on mainnet yet.", true)],
      ["layerzero"],
    );
    expect(shown).toEqual([]);
  });

  it("keeps a compose decline when it is the rail's only answer", () => {
    const only = decline("layerzero", "The conversion could not be priced.", true);
    expect(visibleDeclines([only], [])).toEqual([only]);
  });
});
