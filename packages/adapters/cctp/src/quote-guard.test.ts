import type { Asset, QuoteRequest } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { assetsAreCanonical, sourceUsdcFor } from "./assets.js";
import { CCTP_CONTRACTS } from "./config.js";
import { SOLANA_USDC } from "./solana.js";
import { STARKNET_DEPLOYMENTS } from "./starknet.js";

const STELLAR_ID = `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`;

const asset = (chainId: string, id: string, decimals = 6): Asset => ({
  chainId,
  id,
  symbol: "USDC",
  decimals,
  curatedBy: "Circle",
});

const request = (from: Asset, toId = STELLAR_ID): QuoteRequest => ({
  from,
  to: asset("stellar-testnet", toId, 7),
  sends: { asset: from, baseUnits: "1000000" },
  destination: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
  maxSlippageBps: 50,
});

describe("assetsAreCanonical", () => {
  const evm = sourceUsdcFor("testnet", "ethereum-sepolia");
  if (evm === undefined) throw new Error("no ethereum-sepolia deployment");

  it("accepts the canonical EVM USDC in any letter case", () => {
    const checksummed = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    expect(
      assetsAreCanonical(request(asset("ethereum-sepolia", checksummed)), evm, STELLAR_ID),
    ).toBe(true);
    expect(
      assetsAreCanonical(request(asset("ethereum-sepolia", evm.address)), evm, STELLAR_ID),
    ).toBe(true);
  });

  it("refuses a lookalike EVM token and a chain id passed as the asset id", () => {
    const lookalike = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7239";
    expect(assetsAreCanonical(request(asset("ethereum-sepolia", lookalike)), evm, STELLAR_ID)).toBe(
      false,
    );
    expect(
      assetsAreCanonical(request(asset("ethereum-sepolia", "ethereum-sepolia")), evm, STELLAR_ID),
    ).toBe(false);
  });

  it("refuses when the amount is denominated in a different token", () => {
    const from = asset("ethereum-sepolia", evm.address);
    const req = {
      ...request(from),
      sends: { asset: asset("ethereum-sepolia", "0xdead"), baseUnits: "1" },
    };
    expect(assetsAreCanonical(req, evm, STELLAR_ID)).toBe(false);
  });

  it("refuses a Stellar USDC from another issuer", () => {
    const other = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const from = asset("ethereum-sepolia", evm.address);
    expect(assetsAreCanonical(request(from, other), evm, STELLAR_ID)).toBe(false);
    expect(assetsAreCanonical(request(from, "native"), evm, STELLAR_ID)).toBe(false);
  });

  it("compares a Solana mint exactly", () => {
    const sol = sourceUsdcFor("testnet", "solana-devnet");
    if (sol === undefined) throw new Error("no solana deployment");
    const mint = SOLANA_USDC.testnet;
    expect(assetsAreCanonical(request(asset("solana-devnet", mint)), sol, STELLAR_ID)).toBe(true);
    expect(
      assetsAreCanonical(request(asset("solana-devnet", mint.toLowerCase())), sol, STELLAR_ID),
    ).toBe(false);
  });

  it("compares Starknet addresses ignoring case and leading zeros", () => {
    const stark = sourceUsdcFor("testnet", "starknet-sepolia");
    if (stark === undefined) throw new Error("no starknet deployment");
    const canonical = STARKNET_DEPLOYMENTS.testnet.usdc;
    const padded = `0x00${canonical.slice(2).toUpperCase()}`;
    expect(assetsAreCanonical(request(asset("starknet-sepolia", padded)), stark, STELLAR_ID)).toBe(
      true,
    );
    expect(
      assetsAreCanonical(request(asset("starknet-sepolia", `${canonical}1`)), stark, STELLAR_ID),
    ).toBe(false);
  });
});

describe("sourceUsdcFor", () => {
  it("knows nothing about an unsupported chain", () => {
    expect(sourceUsdcFor("testnet", "fantom")).toBeUndefined();
  });
});

describe("CctpAdapter.quote asset identity", () => {
  // declined before any network read, so the endpoint is never contacted
  const adapter = new CctpAdapter({
    network: "testnet",
    rpc: new RpcClient({ url: "https://rpc.invalid" }),
    baseReserveStroops: 5_000_000,
  });

  it("declines a token that only calls itself USDC", async () => {
    const fake = asset("ethereum-sepolia", "0x000000000000000000000000000000000000dEaD");
    const result = await adapter.quote(request(fake));
    expect("reason" in result && result.reason).toBe("asset-unsupported");
  });

  it("declines a Stellar USDC from another issuer", async () => {
    const real = sourceUsdcFor("testnet", "ethereum-sepolia");
    const from = asset("ethereum-sepolia", real?.address ?? "");
    const other = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const result = await adapter.quote(request(from, other));
    expect("reason" in result && result.reason).toBe("asset-unsupported");
  });
});
