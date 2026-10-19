import { describe, expect, it } from "vitest";
import { AquariusProvider } from "./aquarius.js";
import { SoroswapProvider } from "./soroswap.js";

/**
 * Against both live exchanges.
 *
 * The load-bearing assertion here is the one about Soroswap and testnet. The
 * project specification names it as the sole swap dependency and says testnet is
 * selected with a query parameter. Its health endpoint now lists testnet markets,
 * but it still cannot price the conversion Mavna needs there, and this test is
 * what stops "usable on testnet" being quietly re-assumed later.
 */

describe("Aquarius, live", () => {
  it("is usable on testnet, which is why it exists in this codebase", async () => {
    expect(await new AquariusProvider("testnet").isUsable()).toBe(true);
  });

  it("prices a real swap against real testnet liquidity", async () => {
    const quote = await new AquariusProvider("testnet").quote({
      assetIn: "CALZZIZI7LH645Q2OHCKUYBS542O4YUA5YV6UODTK6PA3DEIUFPEXZAG",
      assetOut: "CC537L4WTJXYQTRIACNSWHFQ2GLXQFT7CQD3SYWJ7WQLCCULXO3T7VGK",
      amountIn: "10000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });

    // Invariants, not exact figures: live liquidity decides the number and
    // asserting it would make this test lie the moment the pool moves.
    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    expect(BigInt(quote.amountOutMinimum)).toBeLessThanOrEqual(BigInt(quote.amountOut));
    expect(quote.venues.length).toBeGreaterThan(0);
    expect(quote.isClassicPathPayment).toBe(false);
  });

  it("says plainly when there is no route rather than returning a zero", async () => {
    await expect(
      new AquariusProvider("testnet").quote({
        assetIn: "CALZZIZI7LH645Q2OHCKUYBS542O4YUA5YV6UODTK6PA3DEIUFPEXZAG",
        assetOut: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        amountIn: "10000000",
        maxSlippageBps: 50,
        destinationKind: "account",
      }),
    ).rejects.toThrow();
  });
});

describe("Soroswap, live", () => {
  const key = process.env.SOROSWAP_API_KEY ?? "";

  // Checked 2026-10-19: /health lists testnet as indexed (soroswap, sdex), and
  // every testnet quote for Circle's test USDC against XLM answers 400, with
  // "No path found" or "Invalid Stellar address". Indexed is not the same as
  // able to serve, which is the finding the two-provider design rests on.
  it("lists testnet as indexed, so the health check alone cannot rule it out", async () => {
    const provider = new SoroswapProvider({ network: "testnet", apiKey: key || "sk_unused" });
    expect(await provider.isUsable()).toBe(true);
  });

  it.skipIf(key === "")(
    "cannot price the USDC to XLM conversion Mavna needs on testnet",
    async () => {
      const provider = new SoroswapProvider({ network: "testnet", apiKey: key });
      await expect(
        provider.quote({
          assetIn: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          assetOut: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          amountIn: "10000000",
          maxSlippageBps: 50,
          destinationKind: "account",
        }),
      ).rejects.toThrow(/could not price this swap \(HTTP 400\)/);
    },
  );

  it.skipIf(key === "")("reports itself usable on mainnet", async () => {
    const provider = new SoroswapProvider({ network: "mainnet", apiKey: key });
    expect(await provider.isUsable()).toBe(true);
  });

  it("refuses to exist without a key, because the key is server-side only", () => {
    expect(() => new SoroswapProvider({ network: "mainnet", apiKey: "" })).toThrow();
  });
});
