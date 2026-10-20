import { Asset } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectSpendQuote } from "./spend.js";

const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

afterEach(() => vi.unstubAllGlobals());

/** Horizon's answer, in the shape it returned for a live mainnet query. */
function horizonAnswers(records: unknown[], status = 200): URL[] {
  const asked: URL[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    asked.push(new URL(input));
    return Promise.resolve(new Response(JSON.stringify({ _embedded: { records } }), { status }));
  });
  return asked;
}

describe("what the settlement's own path would spend", () => {
  it("reads the direct path's amount, not a cheaper path through another asset", async () => {
    const asked = horizonAnswers([
      {
        source_amount: "0.2635573",
        path: [{ asset_type: "credit_alphanum4", asset_code: "VELO" }],
      },
      { source_amount: "0.2636186", path: [] },
    ]);
    const quote = new DirectSpendQuote({ horizonUrl: "https://horizon.example/" });
    expect(await quote.directSpendStroops(USDC, "1.5000000")).toBe(2_636_186n);
    expect(asked[0]?.pathname).toBe("/paths/strict-receive");
    expect(asked[0]?.searchParams.get("source_assets")).toBe(
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
    expect(asked[0]?.searchParams.get("destination_amount")).toBe("1.5000000");
  });

  it("says there is no direct path when Horizon finds none", async () => {
    horizonAnswers([{ source_amount: "0.3", path: [{ asset_type: "native" }] }]);
    const quote = new DirectSpendQuote({ horizonUrl: "https://horizon.example" });
    expect(await quote.directSpendStroops(USDC, "1.5")).toBeUndefined();
  });

  it("throws when Horizon fails, rather than guessing", async () => {
    horizonAnswers([], 503);
    const quote = new DirectSpendQuote({ horizonUrl: "https://horizon.example" });
    await expect(quote.directSpendStroops(USDC, "1.5")).rejects.toThrow(/HTTP 503/);
  });
});
