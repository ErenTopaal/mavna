import { MavnaError, type NetworkId } from "@mavna/core";
import { requestJson } from "./http.js";

/**
 * Where Axelar's contracts are, read from Axelar rather than from memory.
 *
 * The same rule as `discovery.ts` and for the same reason: the addresses written
 * into this project's specification were dead when checked. So nothing here is a
 * constant except the URL of Axelar's own published configuration, which is the
 * file their deployment tooling itself reads.
 *
 * Two things this file exists to stop, both measured rather than imagined:
 *
 * The token service is NOT at one deterministic address. It is at
 * `0xB5FB...9e3C` on every mainnet chain and on most testnet ones, and on
 * monad-3, memento-demo and arc-8 it is somewhere else entirely. Assuming the
 * usual address would send a transfer to a contract that is not there.
 *
 * The token service VERSION differs between chains at the same address, because
 * the proxy stays put while implementations are upgraded underneath it. That
 * matters: 2.1.x and 2.2.0 answer the trust question through different functions,
 * so the version decides which one to ask.
 */

const CONFIG_URL: Readonly<Record<NetworkId, string>> = {
  testnet:
    "https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/main/axelar-chains-config/info/testnet.json",
  mainnet:
    "https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/main/axelar-chains-config/info/mainnet.json",
};

export interface NativeCurrency {
  readonly symbol: string;
  readonly decimals: number;
}

export interface AxelarChain {
  /**
   * The name Axelar's APIs speak: the chain registry, the message search and the
   * fee estimators. Always lower case.
   */
  readonly id: string;
  /**
   * The name Axelar's CONTRACTS speak, which is NOT always the same string.
   *
   * Nine chains carry a capitalised form here, and on mainnet two of them are
   * Ethereum and Avalanche. Asking Stellar's token service about "ethereum"
   * returns false while "Ethereum" returns true, so using the API name against a
   * contract silently declines the two largest routes this rail has. Measured
   * across every mainnet chain, not inferred.
   */
  readonly axelarId: string;
  readonly name: string;
  /** "evm", "stellar", "svm", "sui", "xrpl". Decides what can be built for it. */
  readonly family: string;
  /** The EVM chain id a wallet needs to switch networks. Absent off EVM. */
  readonly evmChainId: number | undefined;
  readonly rpcUrl: string | undefined;
  readonly explorerUrl: string | undefined;
  readonly nativeCurrency: NativeCurrency | undefined;
  readonly interchainTokenService: string | undefined;
  readonly gasService: string | undefined;
  /** The token service version, e.g. "2.1.1". Absent when Axelar does not say. */
  readonly interchainTokenServiceVersion: string | undefined;
}

interface RawChain {
  readonly name?: string;
  readonly axelarId?: string;
  readonly chainId?: number;
  readonly chainType?: string;
  readonly rpc?: string;
  readonly tokenSymbol?: string;
  readonly decimals?: number;
  readonly explorer?: { url?: string };
  readonly contracts?: {
    readonly InterchainTokenService?: { address?: string; version?: string };
    readonly AxelarGasService?: { address?: string };
  };
}

const cache = new Map<NetworkId, Promise<ReadonlyMap<string, AxelarChain>>>();

/**
 * Every chain Axelar publishes for this network, keyed by Axelar's identifier.
 *
 * Cached per process. The configuration changes when Axelar redeploys, which is
 * not something that happens between two quotes, and re-fetching a 250 kB file
 * on every quote would blow the racing timeout on its own.
 */
export function loadChains(network: NetworkId): Promise<ReadonlyMap<string, AxelarChain>> {
  const existing = cache.get(network);
  if (existing !== undefined) return existing;

  const loading = fetchChains(network).catch((cause: unknown) => {
    // A failed load must not poison the cache, or one bad minute disables the
    // rail for the lifetime of the process.
    cache.delete(network);
    throw cause;
  });
  cache.set(network, loading);
  return loading;
}

/** Drops the cached configuration, so the next load fetches again. */
export function forgetChains(): void {
  cache.clear();
}

async function fetchChains(network: NetworkId): Promise<ReadonlyMap<string, AxelarChain>> {
  const reply = await requestJson("Axelar's deployment configuration", CONFIG_URL[network]);
  if (!reply.ok) {
    throw new MavnaError(
      `Could not read Axelar's published deployment configuration (HTTP ${reply.status}).`,
      { retryable: reply.status >= 500 || reply.status === 429 },
    );
  }

  const body = (reply.body ?? {}) as { chains?: Record<string, RawChain> };
  const raw = body.chains;
  if (raw === undefined || typeof raw !== "object") {
    throw new MavnaError("Axelar's deployment configuration had no chains in it.", {
      retryable: false,
    });
  }

  const chains = new Map<string, AxelarChain>();
  for (const [key, chain] of Object.entries(raw)) {
    // Keyed by the configuration's own key, which is what every Axelar API
    // answers to. The contract-facing name is carried alongside rather than
    // used as the key, because the two differ on nine chains.
    const id = key;
    const symbol = chain.tokenSymbol;
    const decimals = chain.decimals;
    chains.set(id, {
      id,
      axelarId: chain.axelarId ?? key,
      name: chain.name ?? id,
      family: chain.chainType ?? "unknown",
      evmChainId: typeof chain.chainId === "number" ? chain.chainId : undefined,
      rpcUrl: chain.rpc,
      explorerUrl: chain.explorer?.url,
      nativeCurrency:
        symbol === undefined || decimals === undefined ? undefined : { symbol, decimals },
      interchainTokenService: chain.contracts?.InterchainTokenService?.address,
      gasService: chain.contracts?.AxelarGasService?.address,
      interchainTokenServiceVersion: chain.contracts?.InterchainTokenService?.version,
    });
  }

  if (chains.size === 0) {
    throw new MavnaError("Axelar's deployment configuration listed no chains at all.", {
      retryable: true,
    });
  }
  return chains;
}

/**
 * One chain, or a refusal that names it. Never a guess.
 *
 * Accepts either of a chain's two names, so a caller holding the one a contract
 * gave it does not have to know which kind it is holding.
 */
export async function chainConfig(network: NetworkId, id: string): Promise<AxelarChain> {
  const chains = await loadChains(network);
  const chain = chains.get(id) ?? [...chains.values()].find((row) => row.axelarId === id);
  if (chain === undefined) {
    throw new MavnaError(
      `Axelar publishes no deployment for "${id}" on ${network}. Names here are ` +
        "versioned and rotate, so a name that used to work is not evidence it still does.",
      { retryable: false },
    );
  }
  return chain;
}

/**
 * The token service on an EVM chain, or a refusal.
 *
 * Separate from `chainConfig` because a chain existing and a chain having a token
 * service are different facts, and several published chains have no service at
 * all. Building against a missing address is how a transfer goes nowhere.
 */
export async function evmTokenService(
  network: NetworkId,
  id: string,
): Promise<{ chain: AxelarChain; address: string; rpcUrl: string }> {
  const chain = await chainConfig(network, id);
  if (chain.family !== "evm") {
    throw new MavnaError(
      `${chain.name} is a ${chain.family} chain. This adapter builds the sending side ` +
        "on EVM only.",
      { retryable: false },
    );
  }
  if (chain.interchainTokenService === undefined) {
    throw new MavnaError(`Axelar has no token service deployed on ${chain.name}.`, {
      retryable: false,
    });
  }
  if (chain.rpcUrl === undefined) {
    throw new MavnaError(
      `Axelar publishes no node URL for ${chain.name}, so the token service there ` +
        "cannot be questioned before quoting.",
      { retryable: false },
    );
  }
  return { chain, address: chain.interchainTokenService, rpcUrl: chain.rpcUrl };
}
