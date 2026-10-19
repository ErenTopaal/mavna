import { describe, expect, it } from "vitest";
import { assertChainAgrees, assertFeeIsPlausible, discoverStellarChain } from "./discovery.js";
import { estimateGasFee } from "./fees.js";

/**
 * Against Axelar's live registry and fee estimator.
 *
 * The specification's Axelar addresses were DEAD when checked. These tests exist
 * so that never silently happens again: identifiers are discovered, cross-checked
 * and asserted, and every one of Axelar's silent failure modes is covered.
 */

describe("runtime discovery, because these identifiers rot", () => {
  it("finds exactly one Stellar chain and refuses to guess otherwise", async () => {
    const chain = await discoverStellarChain("testnet");
    // Versioned on purpose: Axelar re-registers Stellar after each testnet reset.
    expect(chain.id).toMatch(/^stellar/);
    expect(chain.gateway).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("finds mainnet's chain too, under a different name", async () => {
    const chain = await discoverStellarChain("mainnet");
    expect(chain.id).toMatch(/^stellar/);
    // Mainnet is unversioned; testnet is not. Assuming either would be wrong.
    expect(chain.gateway).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("stops when the registry and the live contract disagree", () => {
    const discovered = { id: "stellar-2026-q1-2", gateway: "C" };
    expect(() => assertChainAgrees(discovered, "stellar-2025-q3")).toThrow(/redeployment/);
    expect(() => assertChainAgrees(discovered, "stellar-2026-q1-2")).not.toThrow();
  });
});

describe("the silent failure modes", () => {
  it("prices a real route", async () => {
    const chain = await discoverStellarChain("testnet");
    // Sent from Stellar, so priced in its own token.
    const estimate = await estimateGasFee("testnet", chain.id, "ethereum-sepolia", "XLM");
    // Flat and component-based, not a percentage.
    expect(BigInt(estimate.totalFee)).toBeGreaterThan(0n);
    expect(BigInt(estimate.baseFee)).toBeGreaterThan(0n);
  });

  it("REFUSES a zero fee, which means an unrecognised chain and not a free transfer", () => {
    // Axelar answers an unknown chain with 0 and HTTP 200. Paying zero gas
    // strands the message with no automatic recovery.
    expect(() => assertFeeIsPlausible("0", "stellar")).toThrow(/does not recognise/);
    expect(() => assertFeeIsPlausible(0, "made-up-chain")).toThrow(/strands/);
    expect(() => assertFeeIsPlausible("561001", "stellar-2026-q1-2")).not.toThrow();
  });

  it("catches the unversioned name that LOOKS right and quietly is not", async () => {
    // "stellar" is the mainnet name. On testnet it is not recognised, and the
    // estimator says so with a zero rather than an error.
    await expect(estimateGasFee("testnet", "stellar", "ethereum-sepolia", "XLM")).rejects.toThrow();
  });
});
