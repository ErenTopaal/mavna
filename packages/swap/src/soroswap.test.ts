import { MavnaError } from "@mavna/core";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyOf, json, routedFetch } from "./__fixtures__/network.js";
import { SoroswapProvider } from "./soroswap.js";

const PROXY = "https://sponsor.example";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const owner = Keypair.random().publicKey();

const request = {
  assetIn: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  assetOut: "native",
  amountIn: "100000000",
  maxSlippageBps: 50,
  destinationKind: "account" as const,
};

/** The shape Soroswap answered with on mainnet on 2026-10-19, trimmed. */
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
  rawTrade: { amountIn: "99900000", amountOutMin: "562468867", distribution: [] },
};

function unsignedFor(source: string): string {
  return new TransactionBuilder(new Account(source, "41"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.payment({ destination: source, asset: Asset.native(), amount: "1" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soroswap through the proxy", () => {
  it("asks the proxy, never Soroswap, and sends no key", async () => {
    const net = routedFetch({ [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody) });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY }).quote(
      request,
    );

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.url).toBe(`${PROXY}/swap/soroswap/quote`);
    const headers = new Headers(net.calls[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
    // Classic ids become their asset contracts, which is what Soroswap trades.
    expect(bodyOf(net.calls[0])).toEqual({
      network: "mainnet",
      assetIn: USDC,
      assetOut: XLM,
      amount: "100000000",
      slippageBps: 50,
      protocols: ["soroswap", "phoenix", "aqua", "sushi", "comet", "sdex"],
    });
    expect(quote).toMatchObject({
      provider: "soroswap",
      amountOut: "565295344",
      amountOutMinimum: "562468867",
      venues: ["aqua"],
      isClassicPathPayment: false,
    });
  });

  it("passes the integrator fee through, and refuses one Soroswap would not accept", async () => {
    const net = routedFetch({ [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody) });
    vi.stubGlobal("fetch", net.fetch);
    await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY, feeBps: 30 }).quote(request);
    expect(bodyOf(net.calls[0])).toMatchObject({ feeBps: 30 });

    for (const feeBps of [10, 301, -1, 2.5]) {
      expect(() => new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY, feeBps })).toThrow(
        MavnaError,
      );
    }
  });

  it("keeps the orderbook out of a contract destination", async () => {
    const net = routedFetch({ [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody) });
    vi.stubGlobal("fetch", net.fetch);
    await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY }).quote({
      ...request,
      destinationKind: "contract",
    });
    expect(bodyOf(net.calls[0])).toMatchObject({
      protocols: ["soroswap", "phoenix", "aqua", "sushi", "comet"],
    });
  });

  it("refuses a quote for a different pair or amount than it asked for", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/quote`]: () => json({ ...quoteBody, amountIn: "1" }),
      }).fetch,
    );
    const error = await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY })
      .quote(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("refuses an answer that fails the schema, as not retryable", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/quote`]: () => json({ ...quoteBody, amountOut: "1.5" }),
      }).fetch,
    );
    const error = await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY })
      .quote(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("takes the proxy's own retry advice on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/quote`]: () =>
          json({ error: "Too many requests.", retryable: true }, 429),
      }).fetch,
    );
    const busy = await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY })
      .quote(request)
      .catch((e: unknown) => e);
    expect((busy as MavnaError).retryable).toBe(true);

    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/quote`]: () =>
          json({ error: "No route between these assets.", retryable: false }, 422),
      }).fetch,
    );
    const none = await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY })
      .quote(request)
      .catch((e: unknown) => e);
    expect((none as MavnaError).retryable).toBe(false);
  });

  it("is unusable when the sponsor has no proxy, or proxies another network", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/health`]: () => json({ error: "No such endpoint." }, 404),
      }).fetch,
    );
    expect(await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY }).isUsable()).toBe(
      false,
    );

    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/health`]: () =>
          json({ network: "testnet", usable: true, protocols: ["soroswap"] }),
      }).fetch,
    );
    expect(await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY }).isUsable()).toBe(
      false,
    );

    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/health`]: () =>
          json({ network: "mainnet", usable: true, protocols: ["soroswap", "aqua"] }),
      }).fetch,
    );
    expect(await new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY }).isUsable()).toBe(
      true,
    );
  });

  it("builds through the proxy, returning the transaction for the owner", async () => {
    const xdr = unsignedFor(owner);
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody),
      [`${PROXY}/swap/soroswap/build`]: () => json({ xdr }),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY });
    const quote = await provider.quote(request);
    const tx = await provider.build({ quote, account: new Account(owner, "41") });

    expect(tx.source).toBe(owner);
    expect(bodyOf(net.calls[1])).toEqual({
      network: "mainnet",
      quote: quoteBody,
      from: owner,
      to: owner,
    });
  });

  it("refuses a built transaction that spends from someone else", async () => {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody),
      [`${PROXY}/swap/soroswap/build`]: () =>
        json({ xdr: unsignedFor(Keypair.random().publicKey()) }),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY });
    const quote = await provider.quote(request);
    const error = await provider
      .build({ quote, account: new Account(owner, "41") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("will not build another venue's quote", async () => {
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY });
    const error = await provider
      .build({
        quote: {
          provider: "aquarius",
          assetIn: USDC,
          assetOut: XLM,
          amountIn: "1",
          amountOut: "1",
          amountOutMinimum: "1",
          venues: [],
          isClassicPathPayment: false,
          raw: {},
        },
        account: new Account(owner, "1"),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
  });
});
