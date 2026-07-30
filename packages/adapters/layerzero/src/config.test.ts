import type { NetworkId } from "@mavna/core";
import { describe, expect, it } from "vitest";
import {
  chainIdForLayerZeroKey,
  explorerTxUrl,
  ROUTED_SYMBOLS,
  readableAmount,
  STELLAR_SIDE,
  sourceChainsFor,
  sourceFor,
  stellarExplorerTxUrl,
} from "./config.js";

/**
 * The configuration table, checked for the mistakes a table invites.
 *
 * None of this asserts that LayerZero is where the table says it is. That is
 * `scripts/verify-layerzero.mjs`, against the chains themselves. What is checked
 * here is internal coherence: the shapes, the uniqueness, and the fact that
 * nothing is meaningful on only one network.
 */

const NETWORKS: readonly NetworkId[] = ["testnet", "mainnet"];

describe("both networks are real, and neither is special", () => {
  it("resolves Stellar on each without a code path between them", () => {
    for (const network of NETWORKS) {
      const side = STELLAR_SIDE[network];
      expect(side.chainKey).toMatch(/^stellar/);
      expect(side.chainId).toMatch(/^stellar/);
      expect(side.eid).toBeGreaterThan(0);
    }
    // Testnet endpoint ids start 40, mainnet 30. Sharing one would mean a
    // testnet quote could be built against a mainnet pathway.
    expect(STELLAR_SIDE.testnet.eid).not.toBe(STELLAR_SIDE.mainnet.eid);
  });

  it("offers source chains on both", () => {
    for (const network of NETWORKS) {
      expect(sourceChainsFor(network).length).toBeGreaterThan(0);
    }
  });
});

describe("the source table", () => {
  it("gives every chain somewhere to ask and something to pay with", () => {
    for (const network of NETWORKS) {
      for (const chainId of sourceChainsFor(network)) {
        const source = sourceFor(network, chainId);
        expect(source).toBeDefined();
        if (source === undefined) continue;
        expect(source.rpc.length).toBeGreaterThan(0);
        for (const url of source.rpc) expect(url.startsWith("https://")).toBe(true);
        expect(source.evmChainId).toBeGreaterThan(0);
        // The fee is charged in this, so a wrong or missing symbol is a lie
        // told at the moment a user decides whether to sign.
        expect(source.nativeCurrency.symbol).not.toBe("");
        expect(source.nativeCurrency.decimals).toBeGreaterThan(0);
        expect(source.averageBlockMs).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Two chains sharing an EVM chain id would mean one chain's OFT address being
   * read through the other chain's node, which returns a confident wrong answer
   * rather than an error because LayerZero deploys at the same address
   * everywhere.
   */
  it("has no two chains claiming the same EVM chain id", () => {
    for (const network of NETWORKS) {
      const ids = sourceChainsFor(network).map((c) => sourceFor(network, c)?.evmChainId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("has no two chains claiming the same LayerZero key", () => {
    for (const network of NETWORKS) {
      const keys = sourceChainsFor(network).map((c) => sourceFor(network, c)?.layerZeroKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("maps a LayerZero key back to our name for the chain", () => {
    // The two vocabularies genuinely differ, which is the reason the map exists.
    expect(chainIdForLayerZeroKey("mainnet", "xlayer")).toBe("x-layer");
    expect(chainIdForLayerZeroKey("mainnet", "hyperliquid")).toBe("hyperevm");
    expect(chainIdForLayerZeroKey("testnet", "sepolia-testnet")).toBe("ethereum-sepolia");
    expect(chainIdForLayerZeroKey("mainnet", "not-a-chain")).toBeUndefined();
  });

  it("names chains the way the CCTP rail already does, so the router sees one vocabulary", () => {
    for (const shared of ["ethereum", "arbitrum", "optimism", "polygon", "ink", "sei"]) {
      expect(sourceFor("mainnet", shared)).toBeDefined();
    }
    expect(sourceFor("testnet", "ethereum-sepolia")).toBeDefined();
    expect(sourceFor("testnet", "arbitrum-sepolia")).toBeDefined();
  });

  it("does not pretend a testnet chain exists on mainnet, or the reverse", () => {
    expect(sourceFor("mainnet", "ethereum-sepolia")).toBeUndefined();
    expect(sourceFor("testnet", "ethereum")).toBeUndefined();
  });
});

describe("routed symbols", () => {
  /**
   * Testnet is empty on purpose and this pins that down rather than letting a
   * plausible-looking default appear later. LayerZero publishes no OFT registry
   * for any testnet, so there is nothing a symbol could resolve against.
   */
  it("carries USDT0 on mainnet and nothing on testnet", () => {
    expect(ROUTED_SYMBOLS.mainnet).toContain("USDT0");
    expect(ROUTED_SYMBOLS.testnet).toHaveLength(0);
  });
});

describe("explorer links", () => {
  it("links a source transaction where the chain publishes an explorer", () => {
    expect(explorerTxUrl("mainnet", "ethereum", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
  });

  it("gives an empty string rather than a broken link for a chain with none", () => {
    expect(explorerTxUrl("mainnet", "not-a-chain", "0xabc")).toBe("");
  });

  it("links Stellar on the right network", () => {
    expect(stellarExplorerTxUrl("mainnet", "hash")).toContain("/public/");
    expect(stellarExplorerTxUrl("testnet", "hash")).toContain("/testnet/");
  });
});

describe("amounts a person reads", () => {
  it("keeps the figure the user typed", () => {
    expect(readableAmount(25_000_000n, 6)).toBe("25");
    expect(readableAmount(1_500_000n, 6)).toBe("1.5");
    expect(readableAmount(1n, 6)).toBe("0.000001");
    expect(readableAmount(0n, 6)).toBe("0");
  });

  it("does not lose the last digit of a very large amount", () => {
    // Past 2^53, which is where doing this with a number starts rounding the
    // very figure someone is being asked to consent to.
    expect(readableAmount(123_456_789_012_345_678_901n, 18)).toBe("123.456789012345678901");
  });
});
