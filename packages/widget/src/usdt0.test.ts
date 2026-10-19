import { EVM_DEPLOYMENTS } from "@mavna/adapter-cctp";
import { EVM_SOURCES } from "@mavna/adapter-layerzero";
import { describe, expect, it } from "vitest";
import { layerZeroSourceDetail, usdt0ChainsFor } from "./usdt0";

describe("the chains USDT0 can be sent from", () => {
  it("are the LayerZero rail's own source chains, by name", () => {
    const chains = usdt0ChainsFor("mainnet", undefined);
    expect(chains.map((c) => c.id).sort()).toEqual(Object.keys(EVM_SOURCES.mainnet).sort());
    expect(chains.find((c) => c.id === "bera")?.name).toBe("Berachain");
    const names = chains.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("honour the integrator's allow and deny lists", () => {
    expect(
      usdt0ChainsFor("mainnet", { allow: ["arbitrum", "bera", "base"], deny: ["bera"] }).map(
        (c) => c.id,
      ),
    ).toEqual(["arbitrum"]);
  });

  it("follow the network", () => {
    expect(
      usdt0ChainsFor("testnet", undefined)
        .map((c) => c.id)
        .sort(),
    ).toEqual(Object.keys(EVM_SOURCES.testnet).sort());
  });
});

describe("signing from a chain only LayerZero carries", () => {
  it("knows which network a wallet has to switch to", () => {
    // Berachain is not a Circle chain, so nothing else would tell the wallet
    expect(EVM_DEPLOYMENTS.mainnet.bera).toBeUndefined();
    expect(layerZeroSourceDetail("mainnet", "bera")).toEqual({
      kind: "evm",
      evmChainId: 80094,
      name: "Berachain",
      nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
    });
  });

  it("knows nothing about a chain the rail does not send from", () => {
    expect(layerZeroSourceDetail("mainnet", "fantom")).toBeUndefined();
  });
});
