import { MavnaError } from "@mavna/core";
import { Asset } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import usdt0Book from "./__fixtures__/mainnet-usdt0-order-book.json" with { type: "json" };
import { XlmPriceSource } from "./price.js";

const usdc = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

interface Level {
  readonly price: string;
  readonly amount: string;
}

/** Horizon behind the network boundary: bid amounts in the asset, ask amounts in XLM. */
function horizonAnswers(response: () => Response): { readonly urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return response();
  });
  return { urls };
}

function book(bids: readonly Level[], asks: readonly Level[]): Response {
  return new Response(JSON.stringify({ bids, asks }), { status: 200 });
}

/** A bid for `xlm` XLM at `price` asset per XLM, as Horizon states it. */
const bid = (price: number, xlm: number): Level => ({
  price: price.toFixed(7),
  amount: (xlm * price).toFixed(7),
});
const ask = (price: number, xlm: number): Level => ({
  price: price.toFixed(7),
  amount: xlm.toFixed(7),
});

const source = (): XlmPriceSource => new XlmPriceSource({ horizonUrl: "https://horizon.test/" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the XLM price of an asset", () => {
  it("is the mid of the book over real depth, so a dust order inside the spread barely moves it", async () => {
    horizonAnswers(() =>
      book([bid(0.17, 5_000)], [ask(0.18, 0.01), ask(0.2156, 2_000), ask(0.26, 5_000)]),
    );
    const stroops = await source().xlmStroopsPerUnit(usdc);
    // the dust ask at 0.18 is a hundred-thousandth of the depth priced
    const expected = 10_000_000 / ((0.17 + 0.2156) / 2);
    expect(Math.abs(Number(stroops) - expected) / expected).toBeLessThan(0.0001);
  });

  it("walks past the first level when it is smaller than the depth priced", async () => {
    horizonAnswers(() => book([bid(0.2, 500), bid(0.1, 5_000)], [ask(0.2, 5_000)]));
    const stroops = await source().xlmStroopsPerUnit(usdc);
    // bids: 500 XLM at 0.2 and 500 at 0.1, so 0.15 for 1000 XLM
    expect(stroops).toBe(BigInt(Math.round(10_000_000 / ((0.15 + 0.2) / 2))));
  });

  it("asks Horizon for enough levels to walk", async () => {
    const { urls } = horizonAnswers(() => book([bid(0.2, 5_000)], [ask(0.2, 5_000)]));
    await source().xlmStroopsPerUnit(usdc);
    expect(new URL(urls[0] ?? "").searchParams.get("limit")).toBe("50");
  });

  it("refuses a market too thin to price", async () => {
    horizonAnswers(() => book([bid(0.2, 50)], [ask(0.2, 5_000)]));
    const failure = await source()
      .xlmStroopsPerUnit(usdc)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).message).toMatch(/too thin/);
    expect((failure as MavnaError).retryable).toBe(true);
  });

  it("marks a rate limit retryable and a bad request not", async () => {
    horizonAnswers(() => new Response("slow down", { status: 429 }));
    const limited = await source()
      .xlmStroopsPerUnit(usdc)
      .catch((e: unknown) => e);
    expect((limited as MavnaError).retryable).toBe(true);

    horizonAnswers(() => new Response("no", { status: 400 }));
    const refused = await source()
      .xlmStroopsPerUnit(usdc)
      .catch((e: unknown) => e);
    expect((refused as MavnaError).retryable).toBe(false);
  });

  it("says plainly when Horizon's answer is not JSON", async () => {
    horizonAnswers(() => new Response("<html>gateway</html>", { status: 200 }));
    const failure = await source()
      .xlmStroopsPerUnit(usdc)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
    expect((failure as MavnaError).cause).toBeInstanceOf(SyntaxError);
  });

  it("is one for XLM itself, without asking anyone", async () => {
    const { urls } = horizonAnswers(() => book([], []));
    expect(await source().xlmStroopsPerUnit(Asset.native())).toBe(10_000_000n);
    expect(urls).toHaveLength(0);
  });
});

describe("the USDT0 order book, as mainnet answered", () => {
  it("prices USDT0 at the mid of its first 1000 XLM a side, wide spread and all", async () => {
    // recorded 2026-10-21: bids near 0.170 and asks near 0.2156 USDT0 per XLM
    const { urls } = horizonAnswers(() => new Response(JSON.stringify(usdt0Book), { status: 200 }));
    const usdt0 = new Asset("USDT0", "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q");
    expect(await source().xlmStroopsPerUnit(usdt0)).toBe(51_876_162n);
    const asked = new URL(urls[0] ?? "");
    expect(asked.searchParams.get("buying_asset_type")).toBe("credit_alphanum12");
    expect(asked.searchParams.get("buying_asset_code")).toBe("USDT0");
  });
});
