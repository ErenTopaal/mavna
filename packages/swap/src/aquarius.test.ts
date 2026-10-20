import { MavnaError } from "@mavna/core";
import {
  Account,
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import findPath from "./__fixtures__/aquarius-find-path-testnet.json" with { type: "json" };
import { loadInBrowser } from "./__fixtures__/browser.js";
import {
  bodyOf,
  type ContractCall,
  json,
  routedFetch,
  sorobanNode,
} from "./__fixtures__/network.js";
import { AquariusProvider, decodeSwapChain } from "./aquarius.js";

const API = "https://amm-api-testnet.aqua.network";
const RPC = "https://rpc.example";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
// Circle's testnet USDC and testnet XLM, as their asset contracts.
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL = "CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX";
const OTHER = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/** A swap chain as Aquarius encodes it: (pool tokens, pool hash, token out) per step. */
function chainOf(...steps: Array<[string[], string]>): string {
  return xdr.ScVal.scvVec(
    steps.map(([tokens, out]) =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvVec(tokens.map((t) => new Address(t).toScVal())),
        xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
        new Address(out).toScVal(),
      ]),
    ),
  ).toXDR("base64");
}
const CHAIN = chainOf([[USDC, XLM], XLM]);

const request = {
  assetIn: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  assetOut: "native",
  amountIn: "10000000",
  maxSlippageBps: 100,
  destinationKind: "account" as const,
};

const found = {
  success: true,
  swap_chain_xdr: CHAIN,
  pools: [POOL],
  tokens: ["USDC", "native"],
  tokens_addresses: [USDC, XLM],
  amount: 52_000_000,
  amount_with_fee: 52_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aquarius quotes", () => {
  it("asks for the asset contracts and floors the output by the user's slippage", async () => {
    const net = routedFetch({ [`${API}/api/external/v1/find-path/`]: () => json(found) });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await new AquariusProvider("testnet").quote(request);
    expect(bodyOf(net.calls[0])).toEqual({
      token_in_address: USDC,
      token_out_address: XLM,
      amount: "10000000",
    });
    expect(quote).toMatchObject({
      provider: "aquarius",
      amountOut: "52000000",
      amountOutMinimum: "51480000",
      venues: [POOL],
      isClassicPathPayment: false,
    });
  });

  it("refuses a path that does not start and end at the asked-for assets", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () =>
          json({ ...found, tokens_addresses: [XLM, USDC] }),
      }).fetch,
    );
    const error = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("refuses an amount a double could not hold exactly", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () => json({ ...found, amount: 2 ** 60 }),
      }).fetch,
    );
    const error = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("says no route plainly, and a server error is worth retrying", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () => json({ ...found, success: false, pools: [] }),
      }).fetch,
    );
    const none = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect((none as MavnaError).retryable).toBe(false);

    vi.stubGlobal(
      "fetch",
      routedFetch({ [`${API}/api/external/v1/find-path/`]: () => json({}, 503) }).fetch,
    );
    const down = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect((down as MavnaError).retryable).toBe(true);
  });
});

describe("the swap chain Aquarius sends back", () => {
  const quoting = (chain: string) => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () => json({ ...found, swap_chain_xdr: chain }),
      }).fetch,
    );
    return new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
  };

  it("is taken when it starts at the asked token and ends at the asked one, over hops that connect", async () => {
    expect(await quoting(chainOf([[USDC, OTHER], OTHER], [[OTHER, XLM], XLM]))).not.toBeInstanceOf(
      Error,
    );
  });

  it.each([
    ["ends in another token", chainOf([[USDC, OTHER], OTHER])],
    ["starts at a pool without the asked token", chainOf([[OTHER, XLM], XLM])],
    ["skips a token between hops", chainOf([[USDC, OTHER], OTHER], [[USDC, XLM], XLM])],
    ["is empty", chainOf()],
    ["does not decode as a chain", xdr.ScVal.scvVec([xdr.ScVal.scvU32(7)]).toXDR("base64")],
  ])("is refused when it %s, whatever the answer's token list says", async (_what, chain) => {
    const error = await quoting(chain);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).message).toMatch(/swap path/);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("is checked again at build, so a quote carrying another chain is not built", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ [`${API}/api/external/v1/find-path/`]: () => json(found) }).fetch,
    );
    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: RPC });
    const quote = await provider.quote(request);
    const swapped = {
      ...quote,
      raw: { ...(quote.raw as object), swapChainXdr: chainOf([[USDC, OTHER], OTHER]) },
    };
    const error = await provider
      .build({ quote: swapped, account: new Account(Keypair.random().publicKey(), "1") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).message).toMatch(/swap path/);
  });
});

describe("aquarius builds", () => {
  it("calls swap_chained on the router with the found chain and the user's floor", async () => {
    const owner = Keypair.random().publicKey();
    const seen: ContractCall[] = [];
    const net = routedFetch({
      [`${API}/api/external/v1/find-path/`]: () => json(found),
      [RPC]: sorobanNode((call) => {
        seen.push(call);
        return xdr.ScVal.scvU64(xdr.Uint64.fromString("52000000"));
      }, Networks.TESTNET),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: RPC });
    const quote = await provider.quote(request);
    const tx = await provider.build({ quote, account: new Account(owner, "10") });

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.contract).toBe(ROUTER);
    expect(call?.method).toBe("swap_chained");
    expect(call?.source).toBe(owner);
    const [user, chain, tokenIn, amountIn, floor] = call?.args ?? [];
    expect(user && Address.fromScVal(user).toString()).toBe(owner);
    expect(chain?.toXDR("base64")).toBe(CHAIN);
    expect(tokenIn && Address.fromScVal(tokenIn).toString()).toBe(USDC);
    expect(amountIn && scValToNative(amountIn)).toBe(10_000_000n);
    expect(floor && scValToNative(floor)).toBe(51_480_000n);

    // Assembled from the simulation: resources attached, sequence advanced.
    expect(tx.source).toBe(owner);
    expect(tx.sequence).toBe("11");
    expect(Number(tx.fee)).toBeGreaterThan(12_345);
  });

  it("turns a failed simulation into a refusal that is not retried", async () => {
    const net = routedFetch({
      [`${API}/api/external/v1/find-path/`]: () => json(found),
      [RPC]: sorobanNode(
        () => ({ error: "HostError: Error(Contract, #2006)\nmore" }),
        Networks.TESTNET,
      ),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: RPC });
    const quote = await provider.quote(request);
    const error = await provider
      .build({ quote, account: new Account(Keypair.random().publicKey(), "1") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
    expect((error as MavnaError).message).toContain("Error(Contract, #2006)");
    expect((error as MavnaError).message).not.toContain("more");
  });
});

describe("Aquarius's swap chain as router hops", () => {
  it("decodes every hop in the router's own shape", () => {
    const hops = decodeSwapChain(findPath.swap_chain_xdr);
    expect(hops).toHaveLength(4);
    expect(hops[0]?.tokens).toContain(XLM);
    expect(hops.at(-1)?.tokenOut).toBe(USDC);
    for (const hop of hops) expect(hop.poolIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses something that is not a swap chain", () => {
    expect(() => decodeSwapChain(xdr.ScVal.scvU32(1).toXDR("base64"))).toThrow(/shape/);
    expect(() => decodeSwapChain(xdr.ScVal.scvVec([]).toXDR("base64"))).toThrow(/shape/);
    expect(() => decodeSwapChain("not xdr")).toThrow();
  });

  it("quotes a path that runs from what is sold to what is bought", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(findPath)));
    const quote = await new AquariusProvider("testnet").quotePath({
      assetIn: XLM,
      assetOut: USDC,
      amountIn: "100000000",
      maxSlippageBps: 100,
    });
    expect(quote.amountOut).toBe(String(findPath.amount));
    expect(BigInt(quote.amountOutMinimum)).toBeLessThan(BigInt(quote.amountOut));
    expect(quote.path).toHaveLength(4);
  });

  it("refuses a chain priced for some other pair", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(findPath)));
    await expect(
      new AquariusProvider("testnet").quotePath({
        assetIn: XLM,
        assetOut: XLM,
        amountIn: "100000000",
        maxSlippageBps: 100,
      }),
    ).rejects.toThrow(/another asset|connect|different question/);
  });
});

describe("a conversion path built from the router's own pools between listed tokens", () => {
  // Aquarius's testnet AQUA and USDT contracts, the testnet contract's path tokens
  const AQUA = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
  const USDT = "CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN";
  const index = (n: number) => Buffer.alloc(32, n);
  /** The router's order for a pool's tokens: by the address bytes, not the string. */
  const byBytes = (tokens: string[]) =>
    [...tokens].sort((a, b) =>
      Buffer.compare(new Address(a).toScAddress().toXDR(), new Address(b).toScAddress().toXDR()),
    );
  const key = (tokens: string[]) => byBytes(tokens).join(",");

  function router(
    pools: Record<string, Array<[number, (amountIn: bigint) => bigint]>>,
    asked: string[],
  ) {
    return sorobanNode((call) => {
      const tokens = (scValToNative(call.args[0] as xdr.ScVal) as string[]).map(String);
      // the router only knows a pool by its tokens in its own order
      if (tokens.join(",") !== key(tokens)) return { error: "HostError: tokens not sorted" };
      const known = pools[tokens.join(",")] ?? [];
      if (call.method === "get_pools") {
        asked.push(`get_pools ${tokens.length}`);
        return xdr.ScVal.scvMap(
          known.map(
            ([n]) =>
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvBytes(index(n)),
                val: new Address(POOL).toScVal(),
              }),
          ),
        );
      }
      if (call.method === "estimate_swap") {
        const poolIndex = Buffer.from((call.args[3] as xdr.ScVal).bytes()).readUInt8(0);
        const amount = BigInt(scValToNative(call.args[4] as xdr.ScVal) as bigint);
        const pool = known.find(([n]) => n === poolIndex);
        if (pool === undefined) return { error: "HostError: no such pool" };
        return nativeToScVal(pool[1](amount), { type: "u128" });
      }
      return { error: `unexpected ${call.method}` };
    }, Networks.TESTNET);
  }

  it("takes the best of the direct pools and one hop through a listed token, and never asks the API", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [RPC]: router(
          {
            [key([XLM, USDC])]: [
              [1, (a) => a / 20n],
              [2, (a) => a / 25n],
            ],
            [key([XLM, AQUA])]: [[3, (a) => a * 10n]],
            [key([AQUA, USDC])]: [[4, (a) => a / 150n]],
          },
          asked,
        ),
      }).fetch,
    );
    const quote = await new AquariusProvider("testnet", undefined, { rpcUrl: RPC }).quotePath({
      assetIn: XLM,
      assetOut: USDC,
      amountIn: "100000000",
      maxSlippageBps: 20,
      via: [AQUA, USDT],
    });
    // direct: 5,000,000 at best; through AQUA: 1e9 then 6,666,666
    expect(quote.amountOut).toBe("6666666");
    expect(quote.amountOutMinimum).toBe("6653332");
    expect(quote.path).toEqual([
      { tokens: byBytes([XLM, AQUA]), poolIndex: index(3).toString("hex"), tokenOut: AQUA },
      { tokens: byBytes([AQUA, USDC]), poolIndex: index(4).toString("hex"), tokenOut: USDC },
    ]);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("refuses plainly when no pools connect the pair through listed tokens", async () => {
    vi.stubGlobal("fetch", routedFetch({ [RPC]: router({}, []) }).fetch);
    await expect(
      new AquariusProvider("testnet", undefined, { rpcUrl: RPC }).quotePath({
        assetIn: XLM,
        assetOut: USDC,
        amountIn: "100000000",
        maxSlippageBps: 20,
        via: [AQUA],
      }),
    ).rejects.toThrow(/no pools that connect/);
  });
});

describe("aquarius paths in a browser, where there is no Buffer", () => {
  const entry = new URL("./aquarius.ts", import.meta.url).pathname;
  type Aquarius = typeof import("./aquarius.js");

  it("decodes the swap chain", async () => {
    const { decodeSwapChain: decode } = await loadInBrowser<Aquarius>(entry);
    const hops = decode(findPath.swap_chain_xdr);
    expect(hops).toHaveLength(4);
    for (const hop of hops) expect(hop.poolIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("quotes a path through the find-path service", async () => {
    const { AquariusProvider: Provider } = await loadInBrowser<Aquarius>(entry, {
      fetch: async () => new Response(JSON.stringify(findPath)),
    });
    const quote = await new Provider("testnet").quotePath({
      assetIn: XLM,
      assetOut: USDC,
      amountIn: "100000000",
      maxSlippageBps: 100,
    });
    expect(quote.path).toHaveLength(4);
  });

  it("builds a listed path from the router's pools, in the router's token order", async () => {
    const AQUA = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
    const ordered = [XLM, USDC].sort((a, b) =>
      Buffer.compare(new Address(a).toScAddress().toXDR(), new Address(b).toScAddress().toXDR()),
    );
    const seen: string[][] = [];
    const node = sorobanNode((call) => {
      const tokens = (scValToNative(call.args[0] as xdr.ScVal) as string[]).map(String);
      seen.push(tokens);
      if (call.method === "get_pools") {
        const direct = tokens.join(",") === ordered.join(",");
        return xdr.ScVal.scvMap(
          direct
            ? [
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvBytes(Buffer.alloc(32, 0xab)),
                  val: new Address(POOL).toScVal(),
                }),
              ]
            : [],
        );
      }
      return nativeToScVal(5_000_000n, { type: "u128" });
    }, Networks.TESTNET);
    const { AquariusProvider: Provider } = await loadInBrowser<Aquarius>(entry, {
      fetch: routedFetch({ [RPC]: node }).fetch,
    });
    const quote = await new Provider("testnet", undefined, { rpcUrl: RPC }).quotePath({
      assetIn: XLM,
      assetOut: USDC,
      amountIn: "100000000",
      maxSlippageBps: 20,
      via: [AQUA],
    });
    expect(seen[0]).toEqual(ordered);
    expect(quote.path).toEqual([{ tokens: ordered, poolIndex: "ab".repeat(32), tokenOut: USDC }]);
  });
});
