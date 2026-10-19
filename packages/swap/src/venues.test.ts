import { MavnaError } from "@mavna/core";
import { Account, Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, routedFetch, sorobanNode } from "./__fixtures__/network.js";
import { selectSwapProvider } from "./select.js";
import { createSwapVenues, STELLAR_USDT0 } from "./venues.js";

const PROXY = "https://sponsor.example";
const RPC = "https://rpc.example";
const AQUA_MAIN = "https://amm-api.aqua.network";
const AQUA_TEST = "https://amm-api-testnet.aqua.network";
const USDC_MAIN = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM_MAIN = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDT0_MAIN = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";

const usdcToXlm = {
  assetIn: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  assetOut: "native",
  amountIn: "100000000",
  maxSlippageBps: 50,
  destinationKind: "account" as const,
};

const soroswapQuote = {
  assetIn: USDC_MAIN,
  assetOut: XLM_MAIN,
  tradeType: "EXACT_IN",
  amountIn: "100000000",
  amountOut: "565295344",
  otherAmountThreshold: "562468867",
  platform: "aggregator",
  routePlan: [{ swapInfo: { protocol: "aqua", path: [USDC_MAIN, XLM_MAIN] }, percent: "100" }],
  rawTrade: {},
};

const aquariusFound = (tokens: string[]) => ({
  success: true,
  // one pool from the first token straight to the last, as Aquarius encodes it
  swap_chain_xdr: xdr.ScVal.scvVec(
    tokens.length === 0
      ? []
      : [
          xdr.ScVal.scvVec([
            xdr.ScVal.scvVec(tokens.map((t) => new Address(t).toScVal())),
            xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
            new Address(tokens.at(-1) as string).toScVal(),
          ]),
        ],
  ).toXDR("base64"),
  pools: ["CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV"],
  tokens_addresses: tokens,
  amount: 565_000_000,
});

const healthy = (network: string) => () =>
  json({ network, usable: true, protocols: ["soroswap", "aqua"] });
const pools = () => json({ count: 10 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("venue order", () => {
  it("is Soroswap, SushiSwap, Aquarius on mainnet, and never SDEX", () => {
    const venues = createSwapVenues({ network: "mainnet", soroswapProxyUrl: PROXY });
    expect(venues.order).toEqual(["soroswap", "sushiswap", "aquarius"]);
  });

  it("is Soroswap then Aquarius on testnet, where Sushi has no deployment", () => {
    const venues = createSwapVenues({ network: "testnet", soroswapProxyUrl: PROXY });
    expect(venues.order).toEqual(["soroswap", "aquarius"]);
  });

  it("leaves Soroswap out when no proxy holds its key", () => {
    expect(createSwapVenues({ network: "mainnet" }).order).toEqual(["sushiswap", "aquarius"]);
  });
});

describe("the chain", () => {
  it("takes Soroswap's quote where Soroswap serves", async () => {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: healthy("mainnet"),
      [`${PROXY}/swap/soroswap/quote`]: () => json(soroswapQuote),
    });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await createSwapVenues({ network: "mainnet", soroswapProxyUrl: PROXY }).quote(
      usdcToXlm,
    );
    expect(quote.provider).toBe("soroswap");
    // Sushi is not asked about a pair without USDT0, and Aquarius is not reached.
    expect(net.calls.some((c) => c.url.startsWith(AQUA_MAIN))).toBe(false);
    expect(net.calls.some((c) => c.url.startsWith(RPC))).toBe(false);
  });

  it("falls to Aquarius when Soroswap has no route", async () => {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: healthy("testnet"),
      [`${PROXY}/swap/soroswap/quote`]: () =>
        json({ error: "No route between these assets.", retryable: false }, 422),
      [`${AQUA_TEST}/api/external/v1/pools/`]: pools,
      [`${AQUA_TEST}/api/external/v1/find-path/`]: () =>
        json(
          aquariusFound([
            "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          ]),
        ),
    });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await createSwapVenues({ network: "testnet", soroswapProxyUrl: PROXY }).quote({
      ...usdcToXlm,
      assetIn: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
    expect(quote.provider).toBe("aquarius");
  });

  it("puts SushiSwap ahead of Aquarius for a USDT0 pair when Soroswap is down", async () => {
    const node = sorobanNode((call) => {
      if (call.method === "get_pool") {
        return call.args[2]?.u32() === 500
          ? nativeToScVal("CBVHBZSZOS6KRDJ4D44FU2YLIENOVSSLM3UGKW6XQMVIFUAMWIWCVH2U", {
              type: "address",
            })
          : xdr.ScVal.scvVoid();
      }
      return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount"),
          val: nativeToScVal(99_900_000n, { type: "i128" }),
        }),
      ]);
    });
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: () => json({ error: "down" }, 502),
      [RPC]: node,
      [`${AQUA_MAIN}/api/external/v1/pools/`]: pools,
    });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await createSwapVenues({
      network: "mainnet",
      soroswapProxyUrl: PROXY,
      rpcUrl: RPC,
    }).quote({
      ...usdcToXlm,
      assetIn: STELLAR_USDT0,
      assetOut: USDC_MAIN,
    });
    expect(quote.provider).toBe("sushiswap");
    expect(net.calls.some((c) => c.url.includes("find-path"))).toBe(false);
  });

  it("does not offer SushiSwap a pair without USDT0", async () => {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: () => json({ error: "down" }, 502),
      [`${AQUA_MAIN}/api/external/v1/pools/`]: pools,
      [`${AQUA_MAIN}/api/external/v1/find-path/`]: () => json(aquariusFound([USDC_MAIN, XLM_MAIN])),
    });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await createSwapVenues({
      network: "mainnet",
      soroswapProxyUrl: PROXY,
      rpcUrl: RPC,
    }).quote(usdcToXlm);
    expect(quote.provider).toBe("aquarius");
    expect(net.calls.some((c) => c.url.startsWith(RPC))).toBe(false);
  });

  it("names every venue's reason when none can convert", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/health`]: healthy("testnet"),
        [`${PROXY}/swap/soroswap/quote`]: () =>
          json({ error: "No route between these assets.", retryable: false }, 422),
        [`${AQUA_TEST}/api/external/v1/pools/`]: pools,
        [`${AQUA_TEST}/api/external/v1/find-path/`]: () =>
          json({ ...aquariusFound([]), success: false, pools: [] }),
      }).fetch,
    );
    const error = await createSwapVenues({ network: "testnet", soroswapProxyUrl: PROXY })
      .quote({
        ...usdcToXlm,
        assetIn: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
    expect((error as MavnaError).message).toContain("soroswap");
    expect((error as MavnaError).message).toContain("aquarius");
  });

  it("asks a venue whether it is usable once a minute, not once a quote", async () => {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: healthy("mainnet"),
      [`${PROXY}/swap/soroswap/quote`]: () => json(soroswapQuote),
    });
    vi.stubGlobal("fetch", net.fetch);
    const venues = createSwapVenues({ network: "mainnet", soroswapProxyUrl: PROXY });
    await venues.quote(usdcToXlm);
    await venues.quote(usdcToXlm);
    expect(net.calls.filter((c) => c.url.endsWith("/health"))).toHaveLength(1);
  });

  it("builds through the venue that quoted", async () => {
    const owner = Keypair.random().publicKey();
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/health`]: () => json({ error: "down" }, 502),
      [`${AQUA_MAIN}/api/external/v1/pools/`]: pools,
      [`${AQUA_MAIN}/api/external/v1/find-path/`]: () => json(aquariusFound([USDC_MAIN, XLM_MAIN])),
      [RPC]: sorobanNode(() => nativeToScVal(1n, { type: "u128" })),
    });
    vi.stubGlobal("fetch", net.fetch);
    const venues = createSwapVenues({ network: "mainnet", soroswapProxyUrl: PROXY, rpcUrl: RPC });
    const quote = await venues.quote(usdcToXlm);
    const tx = await venues.build({ quote, account: new Account(owner, "1") });
    expect(tx.source).toBe(owner);
    expect(net.calls.some((c) => c.url.startsWith(RPC))).toBe(true);
  });

  it("will not build a quote from a venue it does not have", async () => {
    const venues = createSwapVenues({ network: "testnet" });
    await expect(
      venues.build({
        quote: {
          provider: "sdex",
          assetIn: "native",
          assetOut: "native",
          amountIn: "1",
          amountOut: "1",
          amountOutMinimum: "1",
          venues: [],
          isClassicPathPayment: true,
          raw: {},
        },
        account: new Account(Keypair.random().publicKey(), "1"),
      }),
    ).rejects.toBeInstanceOf(MavnaError);
  });
});

describe("selectSwapProvider", () => {
  it("picks the first usable venue that serves every pair, never SDEX", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${PROXY}/swap/soroswap/health`]: () => json({ error: "No such endpoint." }, 404),
        [`${AQUA_MAIN}/api/external/v1/pools/`]: pools,
      }).fetch,
    );
    const provider = await selectSwapProvider({ network: "mainnet", soroswapProxyUrl: PROXY });
    expect(provider.id).toBe("aquarius");
  });

  it("says swaps are unavailable when nothing is usable", async () => {
    vi.stubGlobal("fetch", routedFetch({}).fetch);
    const error = await selectSwapProvider({ network: "testnet" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });
});

// Keeps the USDT0 constant honest: it is the classic asset, whose contract is
// the one Sushi lists for USDT0 on Stellar.
it("knows USDT0 by code and issuer", async () => {
  const { toContractId } = await import("./wire.js");
  expect(toContractId(STELLAR_USDT0, "mainnet")).toBe(USDT0_MAIN);
});
