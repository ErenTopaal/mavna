import { MavnaError } from "@mavna/core";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
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

const V3 = "CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4";
const ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const PAIR = "CC7CDFY2VGDODJ7WPO3JIK2MXLOAXL4LRQCC43UJDBAIJ4SVFO3HNPOC";

const address = (id: string) => nativeToScVal(id, { type: "address" });
const i128 = (n: string) => nativeToScVal(BigInt(n), { type: "i128" });
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] as xdr.ScVal }),
      ),
  );

/** One operation from `source`, wrapped the way Soroswap's build returns it. */
function envelope(source: string, op: xdr.Operation, fee: string = BASE_FEE): string {
  return new TransactionBuilder(new Account(source, "41"), {
    fee,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(op)
    .setTimeout(60)
    .build()
    .toXDR();
}

/**
 * Aggregator v3's swap_exact_in, shaped like the mainnet transactions it ran on
 * 2026-10-19 (e.g. c162ecfc...): gross amount in, min out, routes, partner.
 */
function v3Swap(
  options: {
    contract?: string;
    user?: string;
    tokenIn?: string;
    amountIn?: string;
    tokenOut?: string;
    minOut?: string;
    hopOut?: string;
    fn?: string;
  } = {},
): string {
  const user = options.user ?? owner;
  const hop = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Soroswap"),
    struct({
      pair: address(PAIR),
      token_in: address(options.tokenIn ?? USDC),
      token_out: address(options.hopOut ?? options.tokenOut ?? XLM),
    }),
  ]);
  const route = struct({ amount_in: i128("99900000"), hops: xdr.ScVal.scvVec([hop]) });
  return envelope(
    owner,
    new Contract(options.contract ?? V3).call(
      options.fn ?? "swap_exact_in",
      address(user),
      address(options.tokenIn ?? USDC),
      i128(options.amountIn ?? "100000000"),
      address(options.tokenOut ?? XLM),
      i128(options.minOut ?? "562468867"),
      xdr.ScVal.scvVec([route]),
      xdr.ScVal.scvVoid(),
    ),
  );
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
    const built = v3Swap();
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/quote`]: () => json(quoteBody),
      [`${PROXY}/swap/soroswap/build`]: () => json({ xdr: built }),
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

describe("what Soroswap built, checked before the user signs it", () => {
  async function built(xdrOf: string, quoted: Record<string, unknown> = quoteBody) {
    const net = routedFetch({
      [`${PROXY}/swap/soroswap/quote`]: () => json(quoted),
      [`${PROXY}/swap/soroswap/build`]: () => json({ xdr: xdrOf }),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl: PROXY });
    const quote = await provider.quote(request);
    return provider.build({ quote, account: new Account(owner, "41") }).catch((e: unknown) => e);
  }

  it("accepts aggregator v3 swapping exactly what was quoted, to the owner, at our floor or above", async () => {
    // our floor: 565295344 less 50 bps, rounded down
    const tx = await built(v3Swap({ minOut: "562468867" }));
    expect(tx).not.toBeInstanceOf(Error);
  });

  it.each([
    ["another contract", { contract: ROUTER }],
    ["another function", { fn: "swap_exact_out" }],
    ["another user", { user: Keypair.random().publicKey() }],
    ["another input token", { tokenIn: XLM }],
    ["another output token", { tokenOut: USDC, hopOut: USDC }],
    ["more input than quoted", { amountIn: "100000001" }],
    ["a floor below ours", { minOut: "562468866" }],
  ])("refuses one that names %s", async (_what, change) => {
    const error = await built(v3Swap(change));
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).message).toMatch(/not the swap that was quoted/);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("refuses a route that ends in a token other than the one asked for", async () => {
    const error = await built(v3Swap({ hopOut: USDC }));
    expect((error as MavnaError).message).toMatch(/not the swap that was quoted/);
  });

  it("refuses anything with a second operation, or a payment instead of a swap", async () => {
    expect(await built(unsignedFor(owner))).toBeInstanceOf(MavnaError);
    const two = new TransactionBuilder(new Account(owner, "41"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
          sendAmount: "10",
          destination: owner,
          destAsset: Asset.native(),
          destMin: "57",
          path: [],
        }),
      )
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(60)
      .build()
      .toXDR();
    expect(await built(two, { ...quoteBody, platform: "sdex" })).toBeInstanceOf(MavnaError);
  });

  it("accepts the router's swap for a router quote, and checks its path and recipient", async () => {
    const routerSwap = (to: string, last: string, min = "562468867") =>
      envelope(
        owner,
        new Contract(ROUTER).call(
          "swap_exact_tokens_for_tokens",
          i128("100000000"),
          i128(min),
          xdr.ScVal.scvVec([address(USDC), address(last)]),
          address(to),
          nativeToScVal(1_900_000_000n, { type: "u64" }),
        ),
      );
    const asRouter = { ...quoteBody, platform: "router" };
    expect(await built(routerSwap(owner, XLM), asRouter)).not.toBeInstanceOf(Error);
    expect(await built(routerSwap(Keypair.random().publicKey(), XLM), asRouter)).toBeInstanceOf(
      MavnaError,
    );
    expect(await built(routerSwap(owner, USDC), asRouter)).toBeInstanceOf(MavnaError);
    expect(await built(routerSwap(owner, XLM, "1"), asRouter)).toBeInstanceOf(MavnaError);
    // a router swap for an aggregator quote is not what was quoted either
    expect(await built(routerSwap(owner, XLM))).toBeInstanceOf(MavnaError);
  });

  it("accepts a classic path payment for an orderbook quote, to the owner, at our floor", async () => {
    const pathPayment = (destination: string, destMin: string, sendAmount = "10") =>
      envelope(
        owner,
        Operation.pathPaymentStrictSend({
          sendAsset: new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
          sendAmount,
          destination,
          destAsset: Asset.native(),
          destMin,
          path: [],
        }),
      );
    const asSdex = { ...quoteBody, platform: "sdex" };
    expect(await built(pathPayment(owner, "56.2468867"), asSdex)).not.toBeInstanceOf(Error);
    expect(await built(pathPayment(owner, "56.2468866"), asSdex)).toBeInstanceOf(MavnaError);
    expect(
      await built(pathPayment(Keypair.random().publicKey(), "56.2468867"), asSdex),
    ).toBeInstanceOf(MavnaError);
    expect(await built(pathPayment(owner, "56.2468867", "11"), asSdex)).toBeInstanceOf(MavnaError);
  });

  it("refuses a swap whose fee is more than any swap costs, since the user pays it", async () => {
    const pricey = envelope(
      owner,
      new Contract(V3).call(
        "swap_exact_in",
        address(owner),
        address(USDC),
        i128("100000000"),
        address(XLM),
        i128("562468867"),
        xdr.ScVal.scvVec([
          struct({
            amount_in: i128("99900000"),
            hops: xdr.ScVal.scvVec([
              xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol("Soroswap"),
                struct({ pair: address(PAIR), token_in: address(USDC), token_out: address(XLM) }),
              ]),
            ]),
          }),
        ]),
        xdr.ScVal.scvVoid(),
      ),
      "10000001",
    );
    const error = await built(pricey);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).message).toMatch(/fee of 1\.0000001 XLM/);
  });
});
