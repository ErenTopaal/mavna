import type { Asset, QuoteRequest } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oldDelivery } from "./__fixtures__/fixtures.js";
import { CctpAdapter, circleFee } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * Circle quotes its fee in basis points, and not always whole ones: the fast
 * path into Stellar is 1.3, 1.4 and 12 depending on the chain. The amount set
 * aside as maxFee must never be below what Circle takes, or the burn waits or
 * reverts, so a fraction rounds up rather than to the nearest.
 */

describe("Circle's fee for an amount", () => {
  it("is exact for whole basis points", () => {
    expect(circleFee(1_000_000n, 0)).toBe(0n);
    expect(circleFee(1_000_000n, 1)).toBe(100n);
    expect(circleFee(25_000_000n, 12)).toBe(30_000n);
  });

  it("keeps the fraction of a fractional basis point", () => {
    // 1.3 bps of 1 USDC is 130 base units; rounding the rate to 1 bps gives 100
    expect(circleFee(1_000_000n, 1.3)).toBe(130n);
    expect(circleFee(1_000_000n, 1.4)).toBe(140n);
    expect(circleFee(1_000_000n, 0.5)).toBe(50n);
  });

  it("rounds up, never down, when the fee falls between base units", () => {
    // 1.3 bps of 1.000001 USDC is 130.00013 base units
    expect(circleFee(1_000_001n, 1.3)).toBe(131n);
    expect(circleFee(1n, 0.5)).toBe(1n);
  });

  it("refuses a rate it cannot read exactly", () => {
    expect(() => circleFee(1_000_000n, -1)).toThrow();
    expect(() => circleFee(1_000_000n, Number.NaN)).toThrow();
    expect(() => circleFee(1_000_000n, 1e-9)).toThrow();
  });
});

describe("a pair Circle does not route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function quoteWithFeeReply(reply: () => Response) {
    const client = new RpcClient({
      url: "https://soroban-testnet.stellar.org",
      sleep: async () => {},
    });
    const entries = oldDelivery.recipientLedgerEntries;
    vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async () => ({
      latestLedger: entries.latestLedger,
      entries: entries.entries.map((e) => ({
        key: xdr.LedgerKey.fromXDR(e.key, "base64"),
        val: xdr.LedgerEntryData.fromXDR(e.xdr, "base64"),
      })),
    }));
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).includes("/v2/burn/USDC/fees/")) return reply();
      // the fixture's recipient needs a reserve, so the floor asks the market
      if (String(input).includes("/order_book")) {
        return Response.json({ bids: [{ price: "0.2" }], asks: [{ price: "0.2" }] });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    const usdc = sourceUsdcFor("testnet", "ethereum-sepolia");
    const from: Asset = {
      chainId: "ethereum-sepolia",
      id: usdc?.address ?? "",
      symbol: "USDC",
      decimals: 6,
      curatedBy: "Circle",
    };
    const request: QuoteRequest = {
      from,
      to: {
        chainId: "stellar-testnet",
        id: `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`,
        symbol: "USDC",
        decimals: 7,
        curatedBy: "Circle",
      },
      sends: { asset: from, baseUnits: "25000000" },
      destination: oldDelivery.recipient,
      maxSlippageBps: 50,
    };
    return new CctpAdapter({
      network: "testnet",
      rpc: client,
      baseReserveStroops: 5_000_000,
    }).quote(request);
  }

  it("is declined as unsupported, not as a temporary outage", async () => {
    const result = await quoteWithFeeReply(() =>
      Response.json({ error: "Route not supported" }, { status: 400 }),
    );
    expect("reason" in result && result.reason).toBe("chain-unsupported");
    expect("reason" in result && result.retryable).toBe(false);
  });

  it("is told apart from Circle being down", async () => {
    const result = await quoteWithFeeReply(() => new Response("{}", { status: 503 }));
    expect("reason" in result && result.reason).toBe("temporarily-unavailable");
  });

  it("carries a fractional rate into the quoted fee", async () => {
    const result = await quoteWithFeeReply(() =>
      Response.json([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0.5 },
      ]),
    );
    if ("reason" in result) throw new Error(`declined: ${result.explanation}`);
    const bridge = result.fees.find((fee) => fee.kind === "bridge");
    // 0.5 bps of 25 USDC is 1250 base units; rounding the rate gives 0 or 2500
    expect(bridge?.total.baseUnits).toBe("1250");
  });
});
