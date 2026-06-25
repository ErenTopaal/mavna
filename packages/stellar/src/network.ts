import type { NetworkId } from "@mavna/core";
import { Networks } from "@stellar/stellar-sdk";

/**
 * Everything that differs between networks, resolved rather than hardcoded.
 *
 * No component may be meaningful on only one network, and there is no "testnet
 * mode" concept anywhere in this codebase. Flipping this object must yield a
 * coherent system on either network.
 */
export interface NetworkConfig {
  readonly id: NetworkId;
  readonly passphrase: string;
  readonly rpcUrl: string;
  /** Base reserve in stroops. Read from a ledger header rather than assumed. */
  readonly baseReserveStroops: number;
  readonly explorer: {
    readonly tx: (hash: string) => string;
    readonly account: (address: string) => string;
    readonly contract: (address: string) => string;
  };
}

const explorerFor = (network: "testnet" | "public") => ({
  tx: (hash: string): string => `https://stellar.expert/explorer/${network}/tx/${hash}`,
  account: (address: string): string =>
    `https://stellar.expert/explorer/${network}/account/${address}`,
  contract: (address: string): string =>
    `https://stellar.expert/explorer/${network}/contract/${address}`,
});

/**
 * The Stellar Development Foundation runs no public mainnet RPC. The Stellar CLI
 * ships mainnet with the literal URL "Bring Your Own", so a provider must be
 * supplied before this config can be built for mainnet.
 */
export function createNetworkConfig(input: {
  id: NetworkId;
  rpcUrl: string;
  baseReserveStroops?: number;
}): NetworkConfig {
  const isTestnet = input.id === "testnet";
  return {
    id: input.id,
    passphrase: isTestnet ? Networks.TESTNET : Networks.PUBLIC,
    rpcUrl: input.rpcUrl,
    // 0.5 XLM at the time of writing, confirmed from a ledger header on both
    // networks. Overridable because it is a network parameter, not a constant.
    baseReserveStroops: input.baseReserveStroops ?? 5_000_000,
    explorer: explorerFor(isTestnet ? "testnet" : "public"),
  };
}

/** The foundation's public testnet endpoint. Convenience only; still overridable. */
export const PUBLIC_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
