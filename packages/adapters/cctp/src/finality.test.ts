import type { Asset, QuoteRequest, Route } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oldDelivery } from "./__fixtures__/fixtures.js";
import { CctpAdapter } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
import { EVM_DEPLOYMENTS } from "./chains.js";
import { CCTP_CONTRACTS } from "./config.js";
import { standardAttestationSeconds } from "./finality.js";
import { NON_EVM_CHAINS } from "./nonevm.js";

/**
 * A standard burn waits for the source chain's finality before Circle attests,
 * and that wait is set by the chain: seconds on Avalanche, about a quarter of an
 * hour on Ethereum and the rollups that settle on it, hours on Linea and
 * Starknet. A Sepolia transfer sent through the app took longer than fifteen
 * minutes to attest while the quote said about five.
 */

describe("Circle's standard attestation time", () => {
  it("is known for every source domain the adapter routes from", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const domains = [
        ...Object.values(EVM_DEPLOYMENTS[network]).map((d) => d.domain),
        ...Object.values(NON_EVM_CHAINS[network]).map((c) => c.domain),
      ];
      for (const domain of domains) {
        expect(standardAttestationSeconds(domain), `domain ${domain}`).toBeGreaterThan(0);
      }
    }
  });

  it("follows Circle's published averages, taking the slow end", () => {
    // ethereum, and an op stack rollup that waits for it
    expect(standardAttestationSeconds(0)).toBe(19 * 60);
    expect(standardAttestationSeconds(2)).toBe(19 * 60);
    // avalanche and arc finalise in about one block
    expect(standardAttestationSeconds(1)).toBe(8);
    expect(standardAttestationSeconds(26)).toBe(1);
    // linea and starknet take hours
    expect(standardAttestationSeconds(11)).toBe(32 * 3600);
    expect(standardAttestationSeconds(25)).toBe(4 * 3600);
  });

  it("refuses a domain it has no figure for rather than guessing", () => {
    expect(() => standardAttestationSeconds(9999)).toThrow(/9999/);
  });
});

describe("a quoted CCTP route's time", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function quoteFrom(chainId: string): Promise<Route> {
    const client = new RpcClient({
      url: "https://soroban-testnet.stellar.org",
      sleep: async () => {},
    });
    const entries = oldDelivery.recipientLedgerEntries;
    vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async () => ({
      latestLedger: entries.latestLedger,
      entries: entries.entries.map((e) => ({
        key: xdr.LedgerKey.fromXdr(e.key, "base64"),
        val: xdr.LedgerEntryData.fromXdr(e.xdr, "base64"),
      })),
    }));
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).includes("/v2/burn/USDC/fees/")) {
        return Response.json([{ finalityThreshold: 2000, minimumFee: 0 }]);
      }
      if (String(input).includes("/order_book")) {
        return Response.json({
          bids: [{ price: "0.2", amount: "1000" }],
          asks: [{ price: "0.2", amount: "5000" }],
        });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    const usdc = sourceUsdcFor("testnet", chainId);
    const from: Asset = {
      chainId,
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
    const result = await new CctpAdapter({
      network: "testnet",
      rpc: client,
      baseReserveStroops: 5_000_000,
    }).quote(request);
    if ("reason" in result) throw new Error(`declined: ${result.explanation}`);
    return result;
  }

  it("covers Ethereum's finality wait, not a flat five minutes", async () => {
    const route = await quoteFrom("ethereum-sepolia");
    expect(route.estimatedSeconds).toBeGreaterThanOrEqual(19 * 60);
    const bridge = route.steps.find((step) => step.kind === "bridge");
    expect(bridge?.estimatedSeconds).toBeGreaterThanOrEqual(19 * 60);
  });

  it("stays short from a chain that finalises at once", async () => {
    const route = await quoteFrom("avalanche-fuji");
    expect(route.estimatedSeconds).toBeLessThan(5 * 60);
  });

  it("adds up its steps", async () => {
    const route = await quoteFrom("ethereum-sepolia");
    const steps = route.steps.reduce((sum, step) => sum + step.estimatedSeconds, 0);
    expect(route.estimatedSeconds).toBe(steps);
  });
});
