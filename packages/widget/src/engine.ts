import { AxelarAdapter } from "@mavna/adapter-axelar";
import {
  CctpAdapter,
  EVM_DEPLOYMENTS,
  type NativeCurrency,
  NON_EVM_CHAINS,
} from "@mavna/adapter-cctp";
import { LayerZeroAdapter } from "@mavna/adapter-layerzero";
import { NearIntentsAdapter } from "@mavna/adapter-near-intents";
import type { BridgeAdapter, Asset as MavnaAsset, NetworkId, RouteRanking } from "@mavna/core";
import {
  type CircuitBreaker,
  createCircuitBreaker,
  parseDisabledSources,
  type SwapAttachment,
} from "@mavna/routing";
import { createNetworkConfig, type NetworkConfig, RpcClient } from "@mavna/stellar";
import { AquariusProvider, createSwapVenues, SdexProvider, type SwapVenues } from "@mavna/swap";
import type { IntegratorFeeConfig } from "./config.js";
import { circleDomain, usdcSourceChains } from "./domains";
import { createSponsorClient, type SponsorClient, type SponsorTerms } from "./sponsor.js";
import { createStellarWallet, type StellarWalletApi } from "./stellar-wallet.js";
import { layerZeroSourceDetail, usdt0ChainsFor, usdt0SwapFor } from "./usdt0.js";

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
  /** The rails to race. Defaults to all of them. */
  readonly rails?: readonly ("Circle" | "Axelar" | "LayerZero" | "NEAR Intents")[] | undefined;
  /** A host-provided Stellar signer, replacing the built-in wallet kit. */
  readonly stellar?: StellarWalletApi | undefined;
  /** The localStorage key for transfer history, namespaced by keyPrefix. */
  readonly historyKey: string;
  /**
   * The Mavna Arrival Contract on this network. Set, it lets LayerZero offer
   * routes that convert on arrival; unset, none are offered.
   */
  readonly arrivalContract?: string | undefined;
}

export interface Engine {
  readonly network: NetworkId;
  readonly rpc: RpcClient;
  readonly breaker: CircuitBreaker;
  /**
   * cctp, axelar, layerzero, near-intents, raced together. A route is built, tracked and
   * looked up through the adapter that quoted it (see `adapterFor`), never
   * through a named one, so there is no Circle handle here to reach for.
   */
  readonly adapters: readonly BridgeAdapter[];
  readonly sdex: SdexProvider;
  readonly usdcOnStellar: MavnaAsset;
  readonly xlmOnStellar: MavnaAsset;
  readonly xlmSwap: SwapAttachment;
  /** Converting the USDT0 LayerZero delivers into `wanted`, through the same venues. */
  usdt0Swap(usdt0: MavnaAsset, wanted: MavnaAsset): SwapAttachment;
  /**
   * The swap leg's venues in v2 order (Soroswap through this sponsor's proxy,
   * SushiSwap for USDT0 pairs, Aquarius), which quote and build the conversion.
   */
  readonly swapVenues: SwapVenues;
  readonly usdcIssuer: string;
  /** The network's base reserve in stroops, for pricing what an account pays itself. */
  readonly baseReserveStroops: number;
  /** The Stellar network this engine runs on, for building what an account signs itself. */
  readonly stellarNetwork: NetworkConfig;
  /** The Arrival Contract this network converts through, if it has one. */
  readonly arrivalContract: string | undefined;
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
  /**
   * The sponsor's terms, asked once and kept. A failed ask is not kept, so the
   * next quote asks again rather than repeating an outage forever.
   */
  sponsorTerms(): Promise<SponsorTerms>;
  /** Chains USDT0 can be sent from, filtered by the same allow and deny lists. */
  readonly usdt0Chains: ReadonlyArray<{ id: string; name: string }>;
  /**
   * What sending USDT0 from a chain means, read from the LayerZero deployment:
   * the token the chain's OFT moves and the Stellar asset it lands as. Rejects
   * with the rail's own words when the chain has no route.
   */
  usdt0Assets(chainId: string): Promise<{ from: MavnaAsset; to: MavnaAsset }>;
}

const STELLAR_USDC_ISSUER: Readonly<Record<NetworkId, string>> = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

export function createEngine(config: EngineConfig): Engine {
  if (config.integratorFee !== undefined) {
    // Once per engine, at construction, so a re-quote does not repeat it.
    console.warn(
      "Mavna: the configured integrator fee is only taken on routes that convert on arrival, where the Arrival Contract collects it. No other route has a collector, so none is shown or taken there.",
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
    // Aquarius, because its router is the one the contract was built to call
    ...(config.arrivalContract === undefined
      ? {}
      : {
          arrival: { contract: config.arrivalContract, venue: new AquariusProvider(network) },
        }),
  });
  // No 1Click key here: anything in the widget's bundle is public, so it quotes
  // on 1Click's keyless schedule.
  const nearIntents = new NearIntentsAdapter({
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

  const sourceChains = usdcSourceChains(network, config.chains);
  const usdt0Chains = usdt0ChainsFor(network, config.chains);

  // Ethereum is where most people hold USDC and where the test funds are, so it
  // is the default when present rather than whatever sorts earliest.
  const preferred = network === "mainnet" ? "ethereum" : "ethereum-sepolia";
  const defaultSourceChain = sourceChains.some((c) => c.id === preferred)
    ? preferred
    : (sourceChains[0]?.id ?? "");

  // The rails to race. An integrator can offer a subset; the default is all of them.
  const railToSource: Readonly<Record<string, string>> = {
    Circle: "cctp",
    Axelar: "axelar",
    LayerZero: "layerzero",
    "NEAR Intents": "near-intents",
  };
  const allAdapters: readonly BridgeAdapter[] = [cctp, axelar, layerzero, nearIntents];
  const adapters =
    config.rails === undefined
      ? allAdapters
      : allAdapters.filter((a) => config.rails?.some((r) => railToSource[r] === a.id));

  const sponsor = createSponsorClient(config.sponsorUrl);
  let terms: Promise<SponsorTerms> | undefined;

  return {
    network,
    rpc,
    breaker,
    adapters,
    sdex,
    usdcOnStellar,
    xlmOnStellar,
    xlmSwap,
    usdt0Swap: (usdt0, wanted) => usdt0SwapFor(network, swapVenues, usdt0, wanted),
    swapVenues,
    usdcIssuer,
    baseReserveStroops: netConfig.baseReserveStroops,
    stellarNetwork: netConfig,
    arrivalContract: config.arrivalContract,
    sourceChains,
    stellarChainId,
    defaultSourceChain,
    ranking: config.ranking,
    integratorFee: config.integratorFee,
    sponsor,
    // A host can bring its own Stellar signer; otherwise the built-in wallet kit.
    stellar: config.stellar ?? createStellarWallet(network),
    historyKey: config.historyKey,
    sourceDomain(chainId) {
      return circleDomain(network, chainId);
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
      const layerzeroOnly = layerZeroSourceDetail(network, chainId);
      if (layerzeroOnly !== undefined) return layerzeroOnly;
      const other = NON_EVM_CHAINS[network][chainId];
      return { kind: "other", name: other?.name ?? chainId, family: other?.family ?? "unknown" };
    },
    sourceUsdc(chainId) {
      return EVM_DEPLOYMENTS[network][chainId]?.usdc;
    },
    sponsorTerms() {
      terms ??= sponsor.terms().catch((cause: unknown) => {
        terms = undefined;
        throw cause;
      });
      return terms;
    },
    usdt0Chains,
    usdt0Assets(chainId) {
      return layerzero.sendableAssets(chainId);
    },
  };
}
