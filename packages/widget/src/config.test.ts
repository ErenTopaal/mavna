import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";

describe("resolveConfig, the network", () => {
  it("runs on testnet against the public node and the local sponsor when nothing is said", () => {
    const resolved = resolveConfig({ integrator: "t" });
    expect(resolved.engineConfig.network).toBe("testnet");
    expect(resolved.engineConfig.rpcUrl).toBe(PUBLIC_TESTNET_RPC_URL);
    expect(resolved.engineConfig.sponsorUrl).toBe("http://localhost:8787");
    expect(resolved.networks).toEqual(["testnet"]);
  });

  it("starts on the network the integrator chose, against the public mainnet node", () => {
    const resolved = resolveConfig({ integrator: "t", network: "mainnet" });
    expect(resolved.engineConfig.network).toBe("mainnet");
    expect(resolved.engineConfig.rpcUrl).toBe(PUBLIC_MAINNET_RPC_URLS[0]);
  });

  it("refuses an empty endpoint instead of running against nothing", () => {
    expect(() => resolveConfig({ integrator: "t", rpcUrl: "" })).toThrow(/rpcUrl/);
    expect(() => resolveConfig({ integrator: "t", sponsorUrl: "" })).toThrow(/sponsorUrl/);
    expect(() =>
      resolveConfig({
        integrator: "t",
        networks: ["testnet", "mainnet"],
        endpoints: { mainnet: { rpcUrl: "", sponsorUrl: "https://m.example" } },
      }),
    ).toThrow(/mainnet.*rpcUrl/);
  });

  it("switches to another offered network with that network's own endpoints", () => {
    const config = {
      integrator: "t",
      network: "testnet" as const,
      networks: ["testnet", "mainnet"] as const,
      sponsorUrl: "https://t.example",
      endpoints: { mainnet: { sponsorUrl: "https://m.example", rpcUrl: "https://rpc.m.example" } },
    };
    const onTestnet = resolveConfig(config);
    expect(onTestnet.engineConfig.sponsorUrl).toBe("https://t.example");
    const onMainnet = resolveConfig(config, "mainnet");
    expect(onMainnet.engineConfig.network).toBe("mainnet");
    expect(onMainnet.engineConfig.sponsorUrl).toBe("https://m.example");
    expect(onMainnet.engineConfig.rpcUrl).toBe("https://rpc.m.example");
    expect(onMainnet.networks).toEqual(["testnet", "mainnet"]);
  });

  it("keeps each network's transfer history apart, so Activity never looks one up on the other", () => {
    const config = {
      integrator: "t",
      network: "testnet" as const,
      networks: ["testnet", "mainnet"] as const,
      sponsorUrl: "https://t.example",
      endpoints: { mainnet: { sponsorUrl: "https://m.example" } },
    };
    const testnet = resolveConfig(config).engineConfig.historyKey;
    const mainnet = resolveConfig(config, "mainnet").engineConfig.historyKey;
    expect(testnet).not.toBe(mainnet);
    expect(mainnet).toBe("mavna.transfers.v1.mainnet");
    expect(resolveConfig({ ...config, keyPrefix: "acme" }, "mainnet").engineConfig.historyKey).toBe(
      "acme:mavna.transfers.v1.mainnet",
    );
  });

  it("refuses to offer a second network without its own sponsor, since a sponsor serves one network", () => {
    expect(() => resolveConfig({ integrator: "t", networks: ["testnet", "mainnet"] })).toThrow(
      /mainnet.*sponsorUrl/,
    );
  });

  it("refuses to start on a network it does not offer", () => {
    expect(() =>
      resolveConfig({ integrator: "t", network: "mainnet", networks: ["testnet"] }),
    ).toThrow(/mainnet/);
    expect(() => resolveConfig({ integrator: "t" }, "mainnet")).toThrow(/mainnet/);
  });

  it("lets the default network's endpoints be given either way", () => {
    const resolved = resolveConfig({
      integrator: "t",
      endpoints: { testnet: { rpcUrl: "https://rpc.t.example", sponsorUrl: "https://t.example" } },
    });
    expect(resolved.engineConfig.rpcUrl).toBe("https://rpc.t.example");
    expect(resolved.engineConfig.sponsorUrl).toBe("https://t.example");
  });
});

describe("the Arrival Contract a network converts through", () => {
  const config = {
    integrator: "t",
    network: "testnet" as const,
    networks: ["testnet", "mainnet"] as const,
    endpoints: { mainnet: { sponsorUrl: "https://m.example" } },
  };

  it("is the deployed one on testnet unless the integrator names another", () => {
    expect(resolveConfig(config).engineConfig.arrivalContract).toBe(
      "CDAIQ522QK5AFCCVGENKVE7SDF6KRCDCAPRFGUWQ4GXO4NJZRVOHQN6X",
    );
    expect(
      resolveConfig({ ...config, arrivalContract: "CAOWN" }).engineConfig.arrivalContract,
    ).toBe("CAOWN");
  });

  it("is none on mainnet, and the default network's choice does not carry over to it", () => {
    expect(resolveConfig(config, "mainnet").engineConfig.arrivalContract).toBeUndefined();
    expect(
      resolveConfig({ ...config, arrivalContract: "CAOWN" }, "mainnet").engineConfig
        .arrivalContract,
    ).toBeUndefined();
  });

  it("is set per network in endpoints", () => {
    const own = {
      ...config,
      endpoints: { mainnet: { sponsorUrl: "https://m.example", arrivalContract: "CAMAIN" } },
    };
    expect(resolveConfig(own, "mainnet").engineConfig.arrivalContract).toBe("CAMAIN");
  });
});

describe("what the form starts out receiving", () => {
  it("refuses USDT0 to receive when the form sends USDC, which cannot arrive as USDT0", () => {
    expect(() => resolveConfig({ integrator: "t", wanted: "USDT0" })).toThrow(
      /wanted.*USDT0.*fromAsset/,
    );
    expect(() =>
      resolveConfig({ integrator: "t", wanted: "USDT0", fromAsset: "USDT0" }),
    ).not.toThrow();
  });
});
