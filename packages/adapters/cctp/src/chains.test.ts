import type { NetworkId } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { EVM_DEPLOYMENTS } from "./chains.js";

/**
 * The chain id is what a wallet is asked to switch to, so a wrong one makes a
 * quoted route impossible to send. The sweep that writes chains.ts asks each
 * node for eth_chainId and refuses a row that disagrees; these pin the result so
 * a hand edit or an older sweep cannot put a wrong id back.
 */

const networks: NetworkId[] = ["testnet", "mainnet"];

describe("the EVM chain ids handed to wallets", () => {
  it("is never shared by two rows on one network", () => {
    for (const network of networks) {
      const ids = Object.values(EVM_DEPLOYMENTS[network]).map((d) => d.evmChainId);
      expect(new Set(ids).size, network).toBe(ids.length);
    }
  });

  it("names Pharos mainnet and X Layer testnet by the ids their nodes answer", () => {
    // eth_chainId on rpc.pharos.xyz answered 0x688 and on testrpc.xlayer.tech
    // 0x7a0, both read on 20 October 2026. 688688 is no chain the registry knows, and
    // 195 is the retired X Layer testnet.
    expect(EVM_DEPLOYMENTS.mainnet.pharos?.evmChainId).toBe(1672);
    expect(EVM_DEPLOYMENTS.testnet["x-layer-sepolia"]?.evmChainId).toBe(1952);
  });

  it("carries no row the chain registry lists as retired", () => {
    for (const network of networks) {
      for (const [id, deployment] of Object.entries(EVM_DEPLOYMENTS[network])) {
        expect(deployment.name, `${network}/${id}`).not.toMatch(/deprecated/i);
      }
    }
  });
});
