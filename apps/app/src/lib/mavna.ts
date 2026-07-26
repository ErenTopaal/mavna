import {
  CctpAdapter,
  EVM_DEPLOYMENTS,
  type NativeCurrency,
  NON_EVM_CHAINS,
} from "@mavna/adapter-cctp";
import type { NetworkId } from "@mavna/core";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";

/**
 * The SDK, assembled once for the app.
 *
 * The network is read from the environment rather than inferred, because a
 * product that moves money must never be ambiguous about which one it is on and
 * a default would eventually be wrong in the worst possible direction.
 */
export const NETWORK: NetworkId =
  import.meta.env.VITE_MAVNA_NETWORK === "mainnet" ? "mainnet" : "testnet";

const config = createNetworkConfig({
  id: NETWORK,
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL ?? PUBLIC_TESTNET_RPC_URL,
});

export const rpc: RpcClient = new RpcClient({ url: config.rpcUrl });

export const cctp: CctpAdapter = new CctpAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

/**
 * Every chain a user can send from, with the name its own registry gives it.
 *
 * Both families, not just the EVM one. Listing only the generated registry left
 * Solana and Starknet out of the picker while the adapter happily quoted them,
 * so the app understated what it could do by two chains.
 */
export const SOURCE_CHAINS: ReadonlyArray<{ id: string; name: string }> = [
  ...Object.entries(EVM_DEPLOYMENTS[NETWORK]).map(([id, chain]) => ({ id, name: chain.name })),
  ...Object.entries(NON_EVM_CHAINS[NETWORK]).map(([id, chain]) => ({ id, name: chain.name })),
].sort((a, b) => a.name.localeCompare(b.name));

export const STELLAR_CHAIN_ID = NETWORK === "mainnet" ? "stellar" : "stellar-testnet";

/**
 * What sending from a chain needs, or why it cannot be sent from here yet.
 *
 * The adapter quotes and builds for every family. This page can only sign for
 * EVM, because Solana and Starknet need their own wallet protocols, so it says
 * so at the point of choosing rather than after a quote the user cannot act on.
 */
export interface EvmSource {
  readonly kind: "evm";
  readonly evmChainId: number;
  readonly name: string;
  readonly nativeCurrency: NativeCurrency | undefined;
}

export interface OtherSource {
  readonly kind: "other";
  readonly name: string;
  readonly family: string;
}

export function sourceChainDetail(chainId: string): EvmSource | OtherSource {
  const evm = EVM_DEPLOYMENTS[NETWORK][chainId];
  if (evm !== undefined) {
    return {
      kind: "evm",
      evmChainId: evm.evmChainId,
      name: evm.name,
      nativeCurrency: evm.nativeCurrency,
    };
  }
  const other = NON_EVM_CHAINS[NETWORK][chainId];
  return { kind: "other", name: other?.name ?? chainId, family: other?.family ?? "unknown" };
}

/**
 * Where the form starts.
 *
 * Alphabetical order put "Amoy" first, which is nobody's expectation. Ethereum is
 * the chain most people hold USDC on and the one the test funds are on, so it is
 * the default when present rather than whatever happens to sort earliest.
 */
export const DEFAULT_SOURCE_CHAIN: string =
  (NETWORK === "mainnet" ? "ethereum" : "ethereum-sepolia") in EVM_DEPLOYMENTS[NETWORK]
    ? NETWORK === "mainnet"
      ? "ethereum"
      : "ethereum-sepolia"
    : (SOURCE_CHAINS[0]?.id ?? "");
