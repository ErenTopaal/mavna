import { MavnaError } from "@mavna/core";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  StrKey,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CallAnswer,
  type ContractCall,
  routedFetch,
  sorobanNode,
} from "./__fixtures__/network.js";
import { SushiSwapProvider } from "./sushiswap.js";

const RPC = "https://rpc.example";
const FACTORY = "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF";
const ROUTER = "CDMIM23WOUL5CZBKX3GOA3V5R5AMVIMTCP52KCDQORWELAPLJ27WZCHL";
const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDT0_USDC_500 = "CBVHBZSZOS6KRDJ4D44FU2YLIENOVSSLM3UGKW6XQMVIFUAMWIWCVH2U";
const USDC_XLM_3000 = "CCR2CH4GQVCZHG7CHFVMNANCK45CU5DVKXZIIITDZQAU3CEJZ7RQH2MQ";

/**
 * The pools that exist on mainnet as of 2026-10-19, by unordered pair and fee:
 * USDT0/USDC at 500 and USDC/XLM at 3000. No USDT0/XLM pool exists.
 */
const POOLS: Readonly<Record<string, string>> = {
  [`${[USDC, USDT0].sort().join("|")}|500`]: USDT0_USDC_500,
  [`${[USDC, XLM].sort().join("|")}|3000`]: USDC_XLM_3000,
};

function addr(v: xdr.ScVal | undefined): string {
  return v === undefined ? "" : Address.fromScVal(v).toString();
}

function fieldsOf(v: xdr.ScVal | undefined): Record<string, xdr.ScVal> {
  const out: Record<string, xdr.ScVal> = {};
  for (const entry of v?.map() ?? []) out[entry.key().sym().toString()] = entry.val();
  return out;
}

/** A router that pays out 0.1 percent less per hop than goes in. */
function sushiChain(seen: ContractCall[], overrides: Partial<Record<string, CallAnswer>> = {}) {
  return sorobanNode((call) => {
    seen.push(call);
    const override = overrides[call.method];
    if (override !== undefined) return override;
    if (call.contract === FACTORY && call.method === "get_pool") {
      const [a, b, fee] = call.args;
      const key = `${[addr(a), addr(b)].sort().join("|")}|${fee?.u32()}`;
      const pool = POOLS[key];
      return pool === undefined ? xdr.ScVal.scvVoid() : new Address(pool).toScVal();
    }
    if (call.contract === ROUTER && call.method === "quote_exact_input") {
      const params = fieldsOf(call.args[0]);
      let amount = BigInt(scValToNative(params.amount_in ?? xdr.ScVal.scvVoid()));
      for (const _ of params.fees?.vec() ?? []) amount = (amount * 999n) / 1000n;
      return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount"),
          val: nativeToScVal(amount, { type: "i128" }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("sqrt_price_x96_after"),
          val: nativeToScVal(1n, { type: "u256" }),
        }),
      ]);
    }
    if (call.method === "get_oracle_hints") {
      return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("checkpoint"), val: xdr.ScVal.scvU32(6) }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("checkpoint_min"),
          val: xdr.ScVal.scvU32(0),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("slot"),
          val: nativeToScVal(29_873_713n, { type: "u128" }),
        }),
      ]);
    }
    if (call.contract === ROUTER && call.method === "swap_exact_input_hints") {
      return nativeToScVal(1n, { type: "i128" });
    }
    return { error: `HostError: no such function ${call.method}` };
  });
}

const request = {
  assetIn: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  assetOut: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  amountIn: "100000000",
  maxSlippageBps: 50,
  destinationKind: "account" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sushiswap quotes", () => {
  it("prices the direct pool and floors by the user's slippage", async () => {
    const seen: ContractCall[] = [];
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain(seen) }).fetch);
    const quote = await new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC }).quote(request);
    expect(quote).toMatchObject({
      provider: "sushiswap",
      amountOut: "99900000",
      amountOutMinimum: "99400500",
      venues: [USDT0_USDC_500],
      isClassicPathPayment: false,
      raw: { path: [USDT0, USDC], fees: [500], pools: [USDT0_USDC_500] },
    });
  });

  it("finds a two-hop path when no direct pool exists", async () => {
    const seen: ContractCall[] = [];
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain(seen) }).fetch);
    const quote = await new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC }).quote({
      ...request,
      assetOut: "native",
    });
    expect(quote.raw).toEqual({
      path: [USDT0, USDC, XLM],
      fees: [500, 3000],
      pools: [USDT0_USDC_500, USDC_XLM_3000],
    });
    expect(quote.amountOut).toBe("99800100");
  });

  it("asks the factory with the pair ordered by address bytes", async () => {
    const seen: ContractCall[] = [];
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain(seen) }).fetch);
    await new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC }).quote(request);
    const lookups = seen.filter((c) => c.method === "get_pool");
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      const [a, b] = lookup.args;
      // Base32 text order does not follow byte order, so this is checked on bytes.
      expect(StrKey.decodeContract(addr(a)).compare(StrKey.decodeContract(addr(b)))).toBeLessThan(
        0,
      );
    }
  });

  it("says plainly when no pool path exists", async () => {
    const seen: ContractCall[] = [];
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain(seen) }).fetch);
    const error = await new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC })
      .quote({ ...request, assetOut: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("treats an unreachable node as retryable", async () => {
    vi.stubGlobal("fetch", routedFetch({}).fetch);
    const error = await new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC })
      .quote(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });

  it("is not usable on testnet, where Sushi has no deployment", async () => {
    const provider = new SushiSwapProvider({ network: "testnet", rpcUrl: RPC });
    expect(await provider.isUsable()).toBe(false);
    await expect(provider.quote(request)).rejects.toBeInstanceOf(MavnaError);
  });
});

describe("sushiswap builds", () => {
  it("calls swap_exact_input_hints with fresh hints and the user's floor", async () => {
    const owner = Keypair.random().publicKey();
    const seen: ContractCall[] = [];
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain(seen) }).fetch);
    const provider = new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC });
    const quote = await provider.quote(request);
    const tx = await provider.build({ quote, account: new Account(owner, "5") });

    const hint = seen.find((c) => c.method === "get_oracle_hints");
    expect(hint?.contract).toBe(USDT0_USDC_500);
    const swap = seen.find((c) => c.method === "swap_exact_input_hints");
    expect(swap?.contract).toBe(ROUTER);
    expect(swap?.source).toBe(owner);
    const params = fieldsOf(swap?.args[0]);
    expect(addr(params.sender)).toBe(owner);
    expect(addr(params.recipient)).toBe(owner);
    expect(scValToNative(params.amount_in ?? xdr.ScVal.scvVoid())).toBe(100_000_000n);
    expect(scValToNative(params.amount_out_minimum ?? xdr.ScVal.scvVoid())).toBe(99_400_500n);
    expect((params.path?.vec() ?? []).map((v) => addr(v))).toEqual([USDT0, USDC]);
    const hints = swap?.args[1]?.vec() ?? [];
    expect(hints).toHaveLength(1);
    expect(scValToNative(hints[0] ?? xdr.ScVal.scvVoid())).toEqual({
      checkpoint: 6,
      checkpoint_min: 0,
      slot: 29_873_713n,
    });
    expect(tx.source).toBe(owner);
    expect(tx.sequence).toBe("6");
  });

  it("refuses a legacy pool whose hints lack checkpoint_min", async () => {
    const seen: ContractCall[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [RPC]: sushiChain(seen, {
          get_oracle_hints: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("checkpoint"),
              val: xdr.ScVal.scvU32(6),
            }),
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("slot"),
              val: nativeToScVal(1n, { type: "u128" }),
            }),
          ]),
        }),
      }).fetch,
    );
    const provider = new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC });
    const quote = await provider.quote(request);
    const error = await provider
      .build({ quote, account: new Account(Keypair.random().publicKey(), "1") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });
});

describe("a sushiswap quote that came back altered", () => {
  async function quoted() {
    vi.stubGlobal("fetch", routedFetch({ [RPC]: sushiChain([]) }).fetch);
    const provider = new SushiSwapProvider({ network: "mainnet", rpcUrl: RPC });
    return { provider, quote: await provider.quote(request) };
  }
  const account = () => new Account(Keypair.random().publicKey(), "1");

  it("is not built when its path ends in another token", async () => {
    const { provider, quote } = await quoted();
    const raw = { path: [USDT0, XLM], fees: [500], pools: [USDT0_USDC_500] };
    const error = await provider
      .build({ quote: { ...quote, raw }, account: account() })
      .catch((e) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).message).toMatch(/other tokens/);
  });

  it("is not built when its path starts somewhere else", async () => {
    const { provider, quote } = await quoted();
    const raw = { path: [XLM, USDC], fees: [500], pools: [USDT0_USDC_500] };
    await expect(provider.build({ quote: { ...quote, raw }, account: account() })).rejects.toThrow(
      /other tokens/,
    );
  });

  it("is not built when its fees and pools do not match its hops", async () => {
    const { provider, quote } = await quoted();
    const raw = { path: [USDT0, USDC], fees: [500, 3000], pools: [USDT0_USDC_500] };
    await expect(provider.build({ quote: { ...quote, raw }, account: account() })).rejects.toThrow(
      /does not hold together/,
    );
  });
});
