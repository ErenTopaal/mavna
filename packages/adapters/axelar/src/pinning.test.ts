import { MavnaError } from "@mavna/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evmTokenService, forgetChains, loadChains } from "./deployments.js";
import { DEPLOYMENTS_COMMIT, PINNED_DEPLOYMENTS } from "./pinned.js";

/**
 * The contract a user approves comes from Axelar's published configuration, so
 * that file is read at a fixed commit and its critical addresses must agree with
 * the ones confirmed on-chain and written into pinned.ts.
 */

const ITS = "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C";
const GAS = "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6";
const ATTACKER = "0x00000000000000000000000000000000deadbeef";

function evmChain(id: string, its: string, gas: string) {
  return {
    name: id,
    axelarId: id,
    chainId: 84532,
    chainType: "evm",
    rpc: "https://sepolia.base.org",
    tokenSymbol: "ETH",
    decimals: 18,
    contracts: {
      InterchainTokenService: { address: its },
      AxelarGasService: { address: gas },
    },
  };
}

let asked: string[];

function publish(chains: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ chains }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  forgetChains();
  asked = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Axelar's deployment configuration", () => {
  it("is read at the pinned commit, never from a moving branch", async () => {
    publish({ "base-sepolia": evmChain("base-sepolia", ITS, GAS) });
    await loadChains("testnet");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`/${DEPLOYMENTS_COMMIT}/`);
    expect(asked[0]).not.toContain("/main/");
    expect(DEPLOYMENTS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is refused whole when a token service differs from the one confirmed on-chain", async () => {
    publish({ "base-sepolia": evmChain("base-sepolia", ATTACKER, GAS) });
    const failure = await loadChains("testnet").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(false);
  });

  it("is refused whole when a gas service differs from the one confirmed on-chain", async () => {
    publish({ "base-sepolia": evmChain("base-sepolia", ITS, ATTACKER) });
    await expect(loadChains("testnet")).rejects.toBeInstanceOf(MavnaError);
  });

  it("offers no token service on a chain that was never confirmed", async () => {
    expect(PINNED_DEPLOYMENTS.testnet["unconfirmed-chain"]).toBeUndefined();
    publish({
      "base-sepolia": evmChain("base-sepolia", ITS, GAS),
      "unconfirmed-chain": evmChain("unconfirmed-chain", ITS, GAS),
    });
    await expect(evmTokenService("testnet", "unconfirmed-chain")).rejects.toThrow(/token service/);
    expect((await evmTokenService("testnet", "base-sepolia")).address).toBe(ITS);
  });
});

describe("the nodes a confirmed chain is read through", () => {
  it("are the ones the sweep confirmed, with the config's node only one more candidate", async () => {
    const pinned = PINNED_DEPLOYMENTS.testnet["base-sepolia"];
    expect(pinned?.rpcUrls.length).toBeGreaterThan(0);
    publish({
      "base-sepolia": { ...evmChain("base-sepolia", ITS, GAS), rpc: "https://dead.invalid" },
    });
    const { rpcUrls } = await evmTokenService("testnet", "base-sepolia");
    expect(rpcUrls.slice(0, pinned?.rpcUrls.length)).toEqual(pinned?.rpcUrls);
    expect(rpcUrls).toContain("https://dead.invalid");
  });

  it("are recorded for every confirmed EVM chain", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      for (const [id, chain] of Object.entries(PINNED_DEPLOYMENTS[network])) {
        if (chain.gasService === undefined) continue; // Stellar
        expect(chain.rpcUrls.length, `${network}/${id}`).toBeGreaterThan(0);
        for (const url of chain.rpcUrls) expect(url, `${network}/${id}`).toMatch(/^https:\/\//);
      }
    }
  });
});
