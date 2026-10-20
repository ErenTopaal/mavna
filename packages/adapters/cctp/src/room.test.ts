import type { Asset, QuoteRequest } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { Keypair, Asset as StellarAsset, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * A trustline caps what an account may hold. A mint above the room left under
 * that cap fails on Stellar after the burn, so it is refused at quote time.
 */

const RECIPIENT = Keypair.random().publicKey();
const USDC = `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The recipient's account and its USDC trustline, as the node returns them. */
function node(limitStroops: bigint): RpcClient {
  const client = new RpcClient({
    url: "https://soroban-testnet.stellar.org",
    sleep: async () => {},
  });
  const accountId = Keypair.fromPublicKey(RECIPIENT).xdrAccountId();
  const [code, issuer] = USDC.split(":");
  const line = new StellarAsset(code ?? "", issuer).toTrustLineXDRObject();
  vi.spyOn(client.server, "getLedgerEntries").mockResolvedValue({
    latestLedger: 100,
    entries: [
      {
        val: xdr.LedgerEntryData.account(
          new xdr.AccountEntry({
            accountId,
            balance: xdr.Int64.fromString("100000000"),
            seqNum: xdr.Int64.fromString("1"),
            numSubEntries: 1,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: new xdr.AccountEntryExt(0),
          }),
        ),
      },
      {
        val: xdr.LedgerEntryData.trustline(
          new xdr.TrustLineEntry({
            accountId,
            asset: line,
            balance: xdr.Int64.fromString("0"),
            limit: xdr.Int64.fromString(limitStroops.toString()),
            flags: 1,
            ext: new xdr.TrustLineEntryExt(0),
          }),
        ),
      },
    ],
  } as never);
  return client;
}

function quote(limitStroops: bigint) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    if (String(input).includes("/v2/burn/USDC/fees/")) {
      return Response.json([
        { finalityThreshold: 1000, minimumFee: 0 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]);
    }
    if (String(input).includes("/order_book")) {
      return Response.json({
        bids: [{ price: "0.2", amount: "1000" }],
        asks: [{ price: "0.2", amount: "5000" }],
      });
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
    to: { chainId: "stellar-testnet", id: USDC, symbol: "USDC", decimals: 7, curatedBy: "Circle" },
    // 25 USDC, all of it minted: Circle takes nothing on this pair
    sends: { asset: from, baseUnits: "25000000" },
    destination: RECIPIENT,
    maxSlippageBps: 50,
  };
  return new CctpAdapter({
    network: "testnet",
    rpc: node(limitStroops),
    baseReserveStroops: 5_000_000,
  }).quote(request);
}

describe("a recipient whose USDC trustline is nearly full", () => {
  it("is refused when the mint would not fit under its limit", async () => {
    const result = await quote(100_000_000n);
    expect(result).toMatchObject({ reason: "destination-unsupported" });
    expect("explanation" in result && result.explanation).toMatch(/room for only 10 USDC/);
  });

  it("is served when the mint fits exactly", async () => {
    const result = await quote(250_000_000n);
    expect("reason" in result).toBe(false);
  });
});
