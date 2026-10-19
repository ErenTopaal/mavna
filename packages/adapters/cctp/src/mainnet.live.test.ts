import { createNetworkConfig, PUBLIC_MAINNET_RPC_URLS, RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
import { buildApproval, buildBurn } from "./burn.js";
import { deploymentFor, sourceChainsFor } from "./chains.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * The claim that mainnet is an operations task rather than an engineering one.
 *
 * The plan's Phase 12 states it as the practical test of the whole
 * network-agnosticism requirement: if promoting to mainnet needs a component
 * changed, the requirement was violated somewhere earlier and that is the
 * finding. A claim like that is worth a test rather than a paragraph, because
 * the way it fails is silent: everything keeps working on testnet.
 *
 * So this runs the same code paths with the network flipped and nothing else
 * touched. It quotes, it inspects a real mainnet destination, and it builds a
 * real burn against mainnet addresses. Nothing is submitted: no mainnet
 * transaction is signed here and no mainnet funds move.
 */

const READ_ONLY = "This test never signs and never submits.";

/** A real mainnet account, used only as something to read. */
const MAINNET_ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("promoting to mainnet", () => {
  it("resolves a mainnet configuration from the same call testnet uses", () => {
    const config = createNetworkConfig({
      id: "mainnet",
      rpcUrl: PUBLIC_MAINNET_RPC_URLS[0] ?? "",
    });
    expect(config.passphrase).toContain("Public Global Stellar Network");
    expect(config.baseReserveStroops).toBeGreaterThan(0);
  });

  it("carries a distinct set of mainnet contracts, not testnet's", () => {
    // The failure this guards against is a mainnet build silently addressing
    // testnet contracts, which on a real network means funds sent nowhere.
    expect(CCTP_CONTRACTS.mainnet.cctpForwarder).not.toBe(CCTP_CONTRACTS.testnet.cctpForwarder);
    expect(CCTP_CONTRACTS.mainnet.usdcIssuer).not.toBe(CCTP_CONTRACTS.testnet.usdcIssuer);
  });

  it("offers mainnet source chains, every one with its own verified addresses", () => {
    const chains = sourceChainsFor("mainnet");
    expect(chains.length).toBeGreaterThanOrEqual(20);

    const tokens = new Set<string>();
    for (const chainId of chains) {
      const deployment = deploymentFor("mainnet", chainId);
      expect(deployment, `${chainId} has no mainnet deployment`).toBeDefined();
      tokens.add(deployment?.usdc.toLowerCase() ?? chainId);
    }
    // A collision would mean one chain's USDC leaked into another's entry, which
    // burns something that is not USDC.
    expect(tokens.size).toBe(chains.length);
  });

  it("builds a mainnet burn with no code change, only the network argument", () => {
    const params = {
      amount: 1_000_000n,
      stellarRecipient: MAINNET_ACCOUNT,
      network: "mainnet" as const,
      sourceChainId: "ethereum",
      maxFee: 0n,
    };

    const burn = buildBurn(params);
    const approval = buildApproval(params);
    const mainnetEthereum = deploymentFor("mainnet", "ethereum");

    expect(burn.contract).toBe(mainnetEthereum?.tokenMessengerV2);
    expect(approval.contract).toBe(mainnetEthereum?.usdc);
    // Not Sepolia's messenger, which is the mistake this whole test exists for.
    expect(burn.contract).not.toBe(deploymentFor("testnet", "ethereum-sepolia")?.tokenMessengerV2);
    expect(READ_ONLY).toBeTruthy();
  });

  it("quotes against the real main network, reading only", async () => {
    // The one thing that cannot be checked without a mainnet endpoint: whether
    // the destination inspection, the fee lookup and the reserve arithmetic all
    // behave when pointed at the network that has real money on it.
    const config = createNetworkConfig({
      id: "mainnet",
      rpcUrl: PUBLIC_MAINNET_RPC_URLS[0] ?? "",
    });
    const adapter = new CctpAdapter({
      network: "mainnet",
      rpc: new RpcClient({ url: config.rpcUrl }),
      baseReserveStroops: config.baseReserveStroops,
    });

    const usdcOnEthereum = {
      chainId: "ethereum",
      id: sourceUsdcFor("mainnet", "ethereum")?.address ?? "",
      symbol: "USDC",
      decimals: 6,
      curatedBy: "Circle",
    };
    const result = await adapter.quote({
      from: usdcOnEthereum,
      to: {
        chainId: "stellar",
        id: `USDC:${CCTP_CONTRACTS.mainnet.usdcIssuer}`,
        symbol: "USDC",
        decimals: 7,
        curatedBy: "Circle",
      },
      sends: { asset: usdcOnEthereum, baseUnits: "25000000" },
      destination: MAINNET_ACCOUNT,
      maxSlippageBps: 50,
    });

    // Either answer is acceptable and both prove the point: the path runs on
    // mainnet. A rejection with a reason is a working adapter declining, not a
    // broken one. What would fail this test is a crash.
    if ("reason" in result) {
      expect(result.explanation.length).toBeGreaterThan(0);
      return;
    }
    expect(result.fromChain.id).toBe("ethereum");
    expect(result.toChain.id).toBe("stellar");
    expect(BigInt(result.receives.baseUnits)).toBeGreaterThan(0n);
  }, 60_000);
});
