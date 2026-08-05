import type { Asset, Route } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { applyIntegratorFee, attachSwapLeg, type SwapQuoter } from "./enrich.js";

/**
 * The two transformations between a rail's quote and the user's screen.
 *
 * Both move money numbers, so both are tested on the numbers: what lands, what
 * the floor is, and who is shown taking what.
 */

const usdc: Asset = {
  chainId: "stellar-testnet",
  id: "USDC:GISSUER",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};
const xlm: Asset = {
  chainId: "stellar-testnet",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

const route: Route = {
  id: "cctp-test",
  source: "cctp",
  trustModel: "native-mint",
  fromChain: { id: "ethereum-sepolia", name: "Ethereum Sepolia", explorerTxUrl: undefined },
  toChain: { id: "stellar-testnet", name: "Stellar Testnet", explorerTxUrl: undefined },
  destination: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
  sends: { asset: { ...usdc, chainId: "ethereum-sepolia", decimals: 6 }, baseUnits: "5000000" },
  receives: { asset: usdc, baseUnits: "50000000" },
  receivesAtLeast: { asset: usdc, baseUnits: "50000000" },
  fees: [],
  estimatedSeconds: 300,
  steps: [
    {
      id: "bridge",
      kind: "bridge",
      source: "cctp",
      from: { asset: usdc, baseUnits: "5000000" },
      to: { asset: usdc, baseUnits: "50000000" },
      estimatedSeconds: 300,
      execution: undefined,
    },
  ],
  signaturesRequired: 2,
  expiresAtUnix: 2_000_000_000,
};

const quoter = (amountOut: string, amountOutMinimum: string): SwapQuoter => ({
  id: "aquarius",
  quote: () => Promise.resolve({ provider: "aquarius", amountOut, amountOutMinimum }),
});

const attachment = (provider: SwapQuoter) => ({
  provider,
  delivered: usdc,
  deliveredContract: "CUSDC",
  wanted: xlm,
  wantedContract: "CXLM",
});

describe("attaching the conversion leg", () => {
  it("re-states the route in the asset the user asked for", async () => {
    const out = await attachSwapLeg(route, attachment(quoter("31000000000", "30845000000")), 50);
    if ("reason" in out) throw new Error(out.explanation);

    expect(out.receives.asset.symbol).toBe("XLM");
    expect(out.receives.baseUnits).toBe("31000000000");
    // The floor is the exchange's own minimum, bounded by the user's slippage.
    expect(out.receivesAtLeast.baseUnits).toBe("30845000000");
    expect(out.steps.map((s) => s.kind)).toEqual(["bridge", "swap"]);
    // The conversion is one more thing to sign, said upfront.
    expect(out.signaturesRequired).toBe(3);
  });

  it("rejects with the reason when the pair cannot be served, never mis-delivers", async () => {
    const failing: SwapQuoter = {
      id: "aquarius",
      quote: () => Promise.reject(new Error("No path found for this pair.")),
    };
    const out = await attachSwapLeg(route, attachment(failing), 50);
    if (!("reason" in out)) throw new Error("should have rejected");

    // A route that quietly delivers USDC to someone who asked for XLM would be
    // worse than no route, so the failure mode is a rejection with words in it.
    expect(out.reason).toBe("no-liquidity");
    expect(out.retryable).toBe(true);
    expect(out.explanation).toContain("XLM");
  });
});

describe("the integrator's cut", () => {
  it("deducts it from the headline and itemises who takes it", () => {
    const out = applyIntegratorFee(route, {
      bps: 30,
      recipient: "GINTEGRATOR",
      recipientName: "Example Wallet",
    });

    // 0.30% of 50000000 is 150000, rounded down.
    expect(out.receives.baseUnits).toBe("49850000");
    expect(out.receivesAtLeast.baseUnits).toBe("49850000");
    const fee = out.fees.find((f) => f.kind === "integrator");
    expect(fee?.total.baseUnits).toBe("150000");
    expect(fee?.recipients[0]?.name).toBe("Example Wallet");
    expect(fee?.includedInQuote).toBe(true);
  });

  it("runs at zero so turning a fee on is configuration, not a new code path", () => {
    const out = applyIntegratorFee(route, {
      bps: 0,
      recipient: "GINTEGRATOR",
      recipientName: "Example Wallet",
    });
    expect(out.receives.baseUnits).toBe(route.receives.baseUnits);
    expect(out.fees.find((f) => f.kind === "integrator")?.total.baseUnits).toBe("0");
  });

  it("refuses a rate no integrator could defend", () => {
    expect(() =>
      applyIntegratorFee(route, { bps: 5000, recipient: "G", recipientName: "x" }),
    ).toThrow(RangeError);
  });
});
