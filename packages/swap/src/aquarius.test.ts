import { xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import findPath from "./__fixtures__/aquarius-find-path-testnet.json" with { type: "json" };
import { AquariusProvider, decodeSwapChain } from "./aquarius.js";

// recorded from the testnet find-path endpoint, XLM to USDC, 10 XLM
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

afterEach(() => {
  vi.unstubAllGlobals();
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
    ).rejects.toThrow(/another asset|connect/);
  });
});
