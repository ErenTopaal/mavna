import { AxelarAdapter } from "@mavna/adapter-axelar";
import {
  CctpAdapter,
  EVM_DEPLOYMENTS,
  type NativeCurrency,
  NON_EVM_CHAINS,
} from "@mavna/adapter-cctp";
import { LayerZeroAdapter } from "@mavna/adapter-layerzero";
import type { BridgeAdapter, Asset as MavnaAsset, NetworkId } from "@mavna/core";
import {
  type CircuitBreaker,
  createCircuitBreaker,
  parseDisabledSources,
  type SwapAttachment,
} from "@mavna/routing";
import {
  createNetworkConfig,
  PUBLIC_MAINNET_RPC_URLS,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
} from "@mavna/stellar";
import { SdexProvider } from "@mavna/swap";

/**
 * The SDK, assembled once for the app.
 *
 * The network is read from the environment rather than inferred, because a
 * product that moves money must never be ambiguous about which one it is on and
 * a default would eventually be wrong in the worst possible direction.
 */
export const NETWORK: NetworkId =
  import.meta.env.VITE_MAVNA_NETWORK === "mainnet" ? "mainnet" : "testnet";

/**
 * The endpoint, defaulted per network rather than per build.
 *
 * This used to fall back to the testnet endpoint whatever the network was set
 * to, so selecting mainnet without also setting a URL produced a mainnet
 * configuration pointed at the test network: mainnet contract addresses, mainnet
 * asset issuers, and a node that has never heard of either. Nothing about that
 * announces itself; it reads as a chain that has lost your account.
 *
 * The foundation runs no public main-network node, so the mainnet default is a
 * third party's. That is a real dependency rather than a detail, which is why the
 * app states which endpoint it is using rather than leaving it implicit, and why
 * an operator is expected to set their own before there is real money involved.
 */
export const RPC_URL: string =
  import.meta.env.VITE_STELLAR_RPC_URL ??
  (NETWORK === "mainnet" ? (PUBLIC_MAINNET_RPC_URLS[0] ?? "") : PUBLIC_TESTNET_RPC_URL);

/** True when nobody chose the endpoint, which is worth saying out loud on mainnet. */
export const RPC_IS_A_DEFAULT: boolean = import.meta.env.VITE_STELLAR_RPC_URL === undefined;

const config = createNetworkConfig({ id: NETWORK, rpcUrl: RPC_URL });

export const rpc: RpcClient = new RpcClient({ url: config.rpcUrl });

/**
 * Sources an operator has taken out of rotation, read from configuration.
 *
 * Set `VITE_MAVNA_DISABLED_SOURCES` to something like
 * `cctp:Circle is degraded right now` and the next quote declines that rail with
 * that sentence instead of routing money through it. Required by the security
 * rules, which ask for a way to stop using a degraded third party that does not
 * wait for a release.
 *
 * In this app the value is baked in at build time, so acting on it is a redeploy
 * of static files rather than a code change. A server-rendered host reads the
 * same list per request; the breaker takes a function precisely so it can.
 */
export const breaker: CircuitBreaker = createCircuitBreaker(() =>
  parseDisabledSources(import.meta.env.VITE_MAVNA_DISABLED_SOURCES),
);

export const cctp: CctpAdapter = new CctpAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

export const axelar: AxelarAdapter = new AxelarAdapter({ network: NETWORK, rpc });

export const layerzero: LayerZeroAdapter = new LayerZeroAdapter({
  network: NETWORK,
  rpc,
  baseReserveStroops: config.baseReserveStroops,
});

/**
 * Every rail, raced together.
 *
 * All three are asked at once and whatever answers is shown, which is the whole
 * point of the routing engine: a slow rail costs its own route and nothing else,
 * and a rail that declines says why rather than quietly not appearing.
 *
 * On testnet two of the three will usually decline, and that is the honest
 * picture rather than a fault. Circle is the only rail that can move a
 * stablecoin there; Axelar's Stellar testnet has one load-test token registered
 * and nothing else; LayerZero's registry carries no testnet at all. The
 * comparison this product exists to show is a mainnet comparison, and the
 * interface says so by naming the reason each time.
 */
export const ADAPTERS: readonly BridgeAdapter[] = [cctp, axelar, layerzero];

/** The issuer is part of the identity; a bare code never is. */
export const STELLAR_USDC_ISSUER: string =
  NETWORK === "mainnet"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const USDC_ON_STELLAR: MavnaAsset = {
  chainId: NETWORK === "mainnet" ? "stellar" : "stellar-testnet",
  id: `USDC:${STELLAR_USDC_ISSUER}`,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

export const XLM_ON_STELLAR: MavnaAsset = {
  chainId: NETWORK === "mainnet" ? "stellar" : "stellar-testnet",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

/**
 * Stellar's own exchange, for arriving in an asset the bridges do not deliver.
 *
 * The one venue executable on both networks with nothing but the network
 * itself: Soroswap indexes no testnet, and Aquarius executes through a router
 * contract that is its own integration. Quoting and execution both live-proven
 * against the real orderbook.
 */
export const sdex: SdexProvider = new SdexProvider(NETWORK);

/** The pieces raceAdapters needs to attach the conversion leg. */
export const XLM_SWAP: SwapAttachment = {
  provider: sdex,
  delivered: USDC_ON_STELLAR,
  deliveredContract: USDC_ON_STELLAR.id,
  wanted: XLM_ON_STELLAR,
  wantedContract: "native",
};

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

/** Circle's domain for a chain, which is what a delivery is keyed on. */
export function sourceDomain(chainId: string): number {
  return EVM_DEPLOYMENTS[NETWORK][chainId]?.domain ?? NON_EVM_CHAINS[NETWORK][chainId]?.domain ?? 0;
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
