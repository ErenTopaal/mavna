import { describe, expect, it } from "vitest";
import { buildPathPayment, SdexProvider } from "./sdex.js";

/**
 * Stellar's own exchange, against the real test network.
 *
 * This venue is the one that makes "arrive in an asset the bridge does not
 * deliver" executable today, so its quotes are checked against the live
 * orderbook rather than a recording. Amount invariants only, never exact
 * values: live liquidity decides the numbers.
 */

const USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const provider = new SdexProvider("testnet");

describe("the orderbook as a swap venue", () => {
  it("prices five dollars into XLM off the live book", async () => {
    const quote = await provider.quote({
      assetIn: USDC,
      assetOut: "native",
      amountIn: "50000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });

    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    // The floor is below the quote by at most the slippage the caller chose.
    expect(BigInt(quote.amountOutMinimum)).toBeLessThanOrEqual(BigInt(quote.amountOut));
    expect(BigInt(quote.amountOutMinimum)).toBeGreaterThanOrEqual(
      (BigInt(quote.amountOut) * 9950n) / 10000n,
    );
    expect(quote.isClassicPathPayment).toBe(true);
  });

  it("refuses a contract destination at quote time, not at build time", async () => {
    // A classic path payment cannot address a contract, and discovering that
    // after the bridge leg was priced would waste the whole quote.
    await expect(
      provider.quote({
        assetIn: USDC,
        assetOut: "native",
        amountIn: "50000000",
        maxSlippageBps: 50,
        destinationKind: "contract",
      }),
    ).rejects.toThrow(/accounts, not contract/);
  });

  it("refuses a bare asset code, because a code is not an identity", async () => {
    await expect(
      provider.quote({
        assetIn: "USDC",
        assetOut: "native",
        amountIn: "50000000",
        maxSlippageBps: 50,
        destinationKind: "account",
      }),
    ).rejects.toThrow(/CODE:ISSUER/);
  });

  it("builds the exact operation its quote describes", async () => {
    const quote = await provider.quote({
      assetIn: USDC,
      assetOut: "native",
      amountIn: "50000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });

    // A real account shape with a sequence, no network write needed to build.
    const { Account } = await import("@stellar/stellar-sdk");
    const account = new Account("GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU", "1");
    const transaction = buildPathPayment({
      networkPassphrase: "Test SDF Network ; September 2015",
      account,
      quote,
    });

    expect(transaction.operations).toHaveLength(1);
    const operation = transaction.operations[0];
    expect(operation?.type).toBe("pathPaymentStrictSend");
  });
});
