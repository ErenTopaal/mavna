import { AxelarAdapter } from "@mavna/adapter-axelar";
import {
  CctpAdapter,
  EVM_DEPLOYMENTS,
  type NativeCurrency,
  NON_EVM_CHAINS,
} from "@mavna/adapter-cctp";
import { LayerZeroAdapter } from "@mavna/adapter-layerzero";
import type { BridgeAdapter, Asset as MavnaAsset, NetworkId, RouteRanking } from "@mavna/core";
import {
  type CircuitBreaker,
  createCircuitBreaker,
  parseDisabledSources,
  type SwapAttachment,
} from "@mavna/routing";
import { createNetworkConfig, RpcClient } from "@mavna/stellar";
import { createSwapVenues, SdexProvider, type SwapVenues } from "@mavna/swap";
import type { IntegratorFeeConfig } from "./config.js";
import { createSponsorClient, type SponsorClient } from "./sponsor.js";
import { createStellarWallet, type StellarWalletApi } from "./stellar-wallet.js";

/**
 * The SDK, assembled from configuration instead of from the environment.
 *
 * Everything the app used to reach for as a module-level singleton in `mavna.ts`
 * is built here, once, from a resolved config object. That is what lets the same
 * code be the app (config from the environment) and the widget (config from an
 * integrator's props): the network, the endpoints, the rails, the ranking and an
 * optional integrator fee all arrive as data rather than being read from
 * `import.meta.env` deep inside the graph.
 */

/** What sending from an EVM chain needs, or why it cannot be signed here yet. */
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

export type SourceDetail = EvmSource | OtherSource;

/** The resolved configuration an engine is built from. */
export interface EngineConfig {
  readonly network: NetworkId;
  /** Stellar RPC endpoint. EVM reads go through the connected wallet, never here. */
  readonly rpcUrl: string;
  readonly sponsorUrl: string;
  /**
   * Rails an operator has taken out of rotation, in the `parseDisabledSources`
   * format (e.g. `cctp:Circle is degraded right now`). Undefined disables none.
   */
  readonly disabledSources: string | undefined;
  readonly ranking: RouteRanking;
  /** Taken from what the user receives; absent unless an integrator sets one. */
  readonly integratorFee: IntegratorFeeConfig | undefined;
  /** Chains the picker offers, filtered over the network's real chain list. */
  readonly chains?:
    | { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
    | undefined;
  /** The rails to race. Defaults to all three. */
  readonly rails?: readonly ("Circle" | "Axelar" | "LayerZero")[] | undefined;
  /** A host-provided Stellar signer, replacing the built-in wallet kit. */
  readonly stellar?: StellarWalletApi | undefined;
  /** The localStorage key for transfer history, namespaced by keyPrefix. */
  readonly historyKey: string;
}

export interface Engine {
  readonly network: NetworkId;
  readonly rpc: RpcClient;
  readonly breaker: CircuitBreaker;
  /**
   * cctp, axelar, layerzero, raced together. A route is built, tracked and
   * looked up through the adapter that quoted it (see `adapterFor`), never
   * through a named one, so there is no Circle handle here to reach for.
   */
  readonly adapters: readonly BridgeAdapter[];
  readonly sdex: SdexProvider;
  readonly usdcOnStellar: MavnaAsset;
  readonly xlmOnStellar: MavnaAsset;
  readonly xlmSwap: SwapAttachment;
  /**
   * The swap leg's venues in v2 order (Soroswap through this sponsor's proxy,
   * SushiSwap for USDT0 pairs, Aquarius), which quote and build the conversion.
   */
  readonly swapVenues: SwapVenues;
  readonly usdcIssuer: string;
  readonly sourceChains: ReadonlyArray<{ id: string; name: string }>;
  readonly stellarChainId: string;
  readonly defaultSourceChain: string;
  readonly ranking: RouteRanking;
  readonly integratorFee: IntegratorFeeConfig | undefined;
  readonly sponsor: SponsorClient;
  readonly stellar: StellarWalletApi;
  /** The localStorage key for this widget's transfer history. */
  readonly historyKey: string;
  /** Circle's domain for a chain, which is what a delivery is keyed on. */
  sourceDomain(chainId: string): number;
  sourceChainDetail(chainId: string): SourceDetail;
  /** The USDC contract address on a source chain, for reading a balance. */
  sourceUsdc(chainId: string): string | undefined;
}

const STELLAR_USDC_ISSUER: Readonly<Record<NetworkId, string>> = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

export function createEngine(config: EngineConfig): Engine {
  if (config.integratorFee !== undefined) {
    // Once per engine, at construction, so a re-quote does not repeat it.
    console.warn(
      "Mavna: the configured integrator fee is not applied. No collector exists for these routes yet, so no fee is shown or taken.",
    );
  }
  const { network } = config;
  const netConfig = createNetworkConfig({ id: network, rpcUrl: config.rpcUrl });
  const rpc = new RpcClient({ url: netConfig.rpcUrl });

  const breaker = createCircuitBreaker(() => parseDisabledSources(config.disabledSources));

  const cctp = new CctpAdapter({
    network,
    rpc,
    baseReserveStroops: netConfig.baseReserveStroops,
  });
  const axelar = new AxelarAdapter({
    network,
    rpc,
    baseReserveStroops: netConfig.baseReserveStroops,
  });
  const layerzero = new LayerZeroAdapter({
    network,
    rpc,
    baseReserveStroops: netConfig.baseReserveStroops,
  });

  const stellarChainId = network === "mainnet" ? "stellar" : "stellar-testnet";
  const usdcIssuer = STELLAR_USDC_ISSUER[network];

  const usdcOnStellar: MavnaAsset = {
    chainId: stellarChainId,
    id: `USDC:${usdcIssuer}`,
    symbol: "USDC",
    decimals: 7,
    curatedBy: "Circle",
  };
  const xlmOnStellar: MavnaAsset = {
    chainId: stellarChainId,
    id: "native",
    symbol: "XLM",
    decimals: 7,
    curatedBy: "Stellar",
  };

  const sdex = new SdexProvider(network);
  const swapVenues = createSwapVenues({
    network,
    soroswapProxyUrl: config.sponsorUrl,
    rpcUrl: netConfig.rpcUrl,
  });
  const xlmSwap: SwapAttachment = {
    provider: swapVenues,
    delivered: usdcOnStellar,
    deliveredContract: usdcOnStellar.id,
    wanted: xlmOnStellar,
    wantedContract: "native",
  };

  // Both families, not just the EVM one: the adapters quote Solana and Starknet
  // too, so leaving them off the picker would understate what the engine can do.
  const allChains: ReadonlyArray<{ id: string; name: string }> = [
    ...Object.entries(EVM_DEPLOYMENTS[network]).map(([id, chain]) => ({ id, name: chain.name })),
    ...Object.entries(NON_EVM_CHAINS[network]).map(([id, chain]) => ({ id, name: chain.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  // An integrator can narrow the picker; the filter is over the real list, so it
  // can only remove chains, never invent one.
  const allow = config.chains?.allow;
  const deny = config.chains?.deny;
  const sourceChains = allChains.filter(
    (c) =>
      (allow === undefined || allow.includes(c.id)) && (deny === undefined || !deny.includes(c.id)),
  );

  // Ethereum is where most people hold USDC and where the test funds are, so it
  // is the default when present rather than whatever sorts earliest.
  const preferred = network === "mainnet" ? "ethereum" : "ethereum-sepolia";
  const defaultSourceChain = sourceChains.some((c) => c.id === preferred)
    ? preferred
    : (sourceChains[0]?.id ?? "");

  // The rails to race. An integrator can offer a subset; the default is all three.
  const railToSource: Readonly<Record<string, string>> = {
    Circle: "cctp",
    Axelar: "axelar",
    LayerZero: "layerzero",
  };
  const allAdapters: readonly BridgeAdapter[] = [cctp, axelar, layerzero];
  const adapters =
    config.rails === undefined
      ? allAdapters
      : allAdapters.filter((a) => config.rails?.some((r) => railToSource[r] === a.id));

  return {
    network,
    rpc,
    breaker,
    adapters,
    sdex,
    usdcOnStellar,
    xlmOnStellar,
    xlmSwap,
    swapVenues,
    usdcIssuer,
    sourceChains,
    stellarChainId,
    defaultSourceChain,
    ranking: config.ranking,
    integratorFee: config.integratorFee,
    sponsor: createSponsorClient(config.sponsorUrl),
    // A host can bring its own Stellar signer; otherwise the built-in wallet kit.
    stellar: config.stellar ?? createStellarWallet(network),
    historyKey: config.historyKey,
    sourceDomain(chainId) {
      return (
        EVM_DEPLOYMENTS[network][chainId]?.domain ?? NON_EVM_CHAINS[network][chainId]?.domain ?? 0
      );
    },
    sourceChainDetail(chainId) {
      const evm = EVM_DEPLOYMENTS[network][chainId];
      if (evm !== undefined) {
        return {
          kind: "evm",
          evmChainId: evm.evmChainId,
          name: evm.name,
          nativeCurrency: evm.nativeCurrency,
        };
      }
      const other = NON_EVM_CHAINS[network][chainId];
      return { kind: "other", name: other?.name ?? chainId, family: other?.family ?? "unknown" };
    },
    sourceUsdc(chainId) {
      return EVM_DEPLOYMENTS[network][chainId]?.usdc;
    },
  };
}
