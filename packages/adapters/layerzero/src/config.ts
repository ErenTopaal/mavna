import type { NetworkId } from "@mavna/core";

/**
 * Where LayerZero is, per network, and which chains this rail routes from.
 *
 * Almost nothing about LayerZero's deployment is written down here, and that is
 * deliberate. The project specification recorded three Stellar testnet addresses
 * as verified on-chain, and all three were superseded on 4 August 2026 when
 * LayerZero deployed a second, complete Stellar testnet stack and repointed its
 * registry at it. The old contracts are still on the ledger and still answer, so
 * a transcribed address does not fail, it quietly routes into a deployment
 * nobody is watching. That is the same trap Axelar set, so the same answer
 * applies: resolve at runtime, cross-check against the chain, and fail closed.
 *
 * What IS written down here is our own operational choice of RPC endpoint, and
 * our own names for chains. Neither is a LayerZero fact, so neither can rot in
 * the dangerous direction.
 */

/**
 * LayerZero's deployment registry.
 *
 * One URL for both networks: the payload carries testnet and mainnet together,
 * keyed by chain, so there is no per-network endpoint to get wrong.
 */
export const LAYERZERO_METADATA_URL = "https://metadata.layerzero-api.com/v1/metadata/deployments";

/**
 * LayerZero's OFT registry, which is where the token contracts come from.
 *
 * Published under `experiment/`, and it shows: it lists no Stellar deployment on
 * either network, not even USDT0's, which USDT0's own documentation publishes.
 * So it is used only to find CANDIDATE contracts on the EVM side. Whether any of
 * them actually reaches Stellar is settled by reading the chain, never by
 * trusting this file.
 */
export const LAYERZERO_OFT_REGISTRY_URL =
  "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list";

export interface StellarSide {
  /** How LayerZero keys Stellar in its registry. Not the same on both networks. */
  readonly chainKey: string;
  /**
   * LayerZero's endpoint id for Stellar. Expected, not trusted: discovery
   * asserts the registry agrees, and the endpoint contract's own storage is
   * asserted to agree in `scripts/verify-layerzero.mjs`.
   */
  readonly eid: number;
  /** What this codebase calls the chain. */
  readonly chainId: string;
  /** The path segment stellar.expert uses for this network. */
  readonly explorerPath: string;
}

export const STELLAR_SIDE: Readonly<Record<NetworkId, StellarSide>> = {
  testnet: {
    chainKey: "stellar-testnet",
    eid: 40600,
    chainId: "stellar-testnet",
    explorerPath: "testnet",
  },
  mainnet: {
    chainKey: "stellar-mainnet",
    eid: 30600,
    chainId: "stellar",
    explorerPath: "public",
  },
};

/**
 * Which tokens this rail offers, by the symbol LayerZero files them under.
 *
 * Mainnet is USDT0, which is the entire reason this rail exists: it is the only
 * route to native USDT on Stellar.
 *
 * Testnet is empty, and that is a finding rather than an omission. LayerZero's
 * OFT registry carries no testnet chains at all, on any chain, so there is
 * nothing to resolve a symbol against. Every OFT that is in fact peered to
 * Stellar testnet is a private deployment whose token cannot be obtained by
 * anyone but its owner. A caller who has their own OFT can name it directly
 * through `LayerZeroAdapterOptions.ofts`; inventing a default would be quoting a
 * route no user can take.
 */
export const ROUTED_SYMBOLS: Readonly<Record<NetworkId, readonly string[]>> = {
  testnet: [],
  mainnet: ["USDT0"],
};

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface EvmSource {
  /** LayerZero's key for this chain in its registry. Frequently not our name. */
  readonly layerZeroKey: string;
  readonly name: string;
  /** What a wallet needs in order to switch networks. */
  readonly evmChainId: number;
  /**
   * What the LayerZero fee is actually paid in. Carried rather than assumed,
   * because this rail's fee is charged in the source chain's own gas token and
   * telling someone paying in BERA that they are paying ETH is the one kind of
   * small lie this product cannot afford.
   */
  readonly nativeCurrency: NativeCurrency;
  /**
   * Somewhere to ask. Every URL here answered `eth_chainId` with `evmChainId`
   * when this table was written; anything that did not was left out.
   *
   * More than one on purpose. LayerZero's own registry lists an OP Sepolia
   * endpoint under Ethereum Sepolia, and reading a LayerZero endpoint through it
   * returns a confident, wrong answer rather than an error, because the endpoint
   * contract is deployed at the same address on both chains. So the reader
   * checks the chain id before it believes anything, and needs somewhere else to
   * go when a URL turns out to be serving a different chain.
   */
  readonly rpc: readonly string[];
  readonly explorer: string | undefined;
  /**
   * How long a block takes here, in milliseconds.
   *
   * Carried because it is half of the only honest delivery estimate available.
   * A LayerZero message is not verified until the DVNs have seen the source
   * chain reach the confirmation depth the application configured, and USDT0
   * asks for 65 confirmations on the Stellar pathway. Sixty-five blocks is under
   * fifteen seconds on Arbitrum and nearly twelve minutes on Ethereum, so a
   * single flat estimate would be wrong by an order of magnitude on one of them.
   *
   * Mainnet figures are LayerZero's own `chainDetails.averageBlockTime`. The
   * three testnets have none published, so these were measured directly, over
   * the 500 blocks before 12 August 2026.
   */
  readonly averageBlockMs: number;
}

/**
 * The chains this rail can send from.
 *
 * Chain ids match the ones the CCTP rail already uses wherever the two overlap.
 * They are the vocabulary the router and the app speak, and two rails naming the
 * same chain differently would mean a user asking for "ethereum" silently sees
 * only one of them.
 *
 * Membership is not a claim that a transfer works, only that the chain is worth
 * asking. Every quote re-derives the endpoint, the OFT, the peer and the DVN
 * configuration from these chains and declines when any of it is missing.
 *
 * Corn (LayerZero key `mp1`, chain id 21000000) carries USDT0 and supports the
 * Stellar pathway, but every public RPC in LayerZero's registry for it was
 * unreachable. It is absent rather than listed with an endpoint that does not
 * answer, since an unreachable chain reads exactly like a chain with no
 * deployment.
 */
export const EVM_SOURCES: Readonly<Record<NetworkId, Readonly<Record<string, EvmSource>>>> = {
  testnet: {
    // The three testnets whose endpoint reports the Stellar pathway as
    // supported. The other seven checked (Base Sepolia, OP Sepolia, Fuji, Amoy,
    // Holesky among them) answer `isSupportedEid(40600)` with false and have no
    // default send library for it, so they are not asked.
    "ethereum-sepolia": {
      layerZeroKey: "sepolia-testnet",
      name: "Ethereum Sepolia",
      evmChainId: 11155111,
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://sepolia.gateway.tenderly.co", "https://ethereum-sepolia-rpc.publicnode.com"],
      explorer: "https://sepolia.etherscan.io",
      averageBlockMs: 12312,
    },
    "arbitrum-sepolia": {
      layerZeroKey: "arbitrum-sepolia",
      name: "Arbitrum Sepolia",
      evmChainId: 421614,
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://arbitrum-sepolia.drpc.org", "https://arbitrum-sepolia-rpc.publicnode.com"],
      explorer: "https://sepolia.arbiscan.io",
      averageBlockMs: 260,
    },
    "bsc-testnet": {
      layerZeroKey: "bsc-testnet",
      name: "BNB Smart Chain Testnet",
      evmChainId: 97,
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpc: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"],
      explorer: "https://testnet.bscscan.com",
      averageBlockMs: 450,
    },
  },
  mainnet: {
    ethereum: {
      layerZeroKey: "ethereum",
      name: "Ethereum",
      evmChainId: 1,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth"],
      explorer: "https://etherscan.io",
      averageBlockMs: 10800,
    },
    arbitrum: {
      layerZeroKey: "arbitrum",
      name: "Arbitrum One",
      evmChainId: 42161,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
      explorer: "https://arbiscan.io",
      averageBlockMs: 200,
    },
    optimism: {
      layerZeroKey: "optimism",
      name: "OP Mainnet",
      evmChainId: 10,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://mainnet.optimism.io", "https://1rpc.io/op"],
      explorer: "https://optimistic.etherscan.io",
      averageBlockMs: 1800,
    },
    polygon: {
      layerZeroKey: "polygon",
      name: "Polygon",
      evmChainId: 137,
      nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
      rpc: ["https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
      explorer: "https://polygonscan.com",
      averageBlockMs: 2000,
    },
    ink: {
      layerZeroKey: "ink",
      name: "Ink",
      evmChainId: 57073,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://rpc-gel.inkonchain.com", "https://ink.drpc.org"],
      explorer: "https://explorer.inkonchain.com",
      averageBlockMs: 900,
    },
    unichain: {
      layerZeroKey: "unichain",
      name: "Unichain",
      evmChainId: 130,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: ["https://mainnet.unichain.org", "https://unichain.drpc.org"],
      explorer: "https://uniscan.xyz",
      averageBlockMs: 900,
    },
    sei: {
      layerZeroKey: "sei",
      name: "Sei Network",
      evmChainId: 1329,
      nativeCurrency: { name: "Sei", symbol: "SEI", decimals: 18 },
      rpc: ["https://evm-rpc.sei-apis.com", "https://sei.drpc.org"],
      explorer: "https://seiscan.io",
      averageBlockMs: 500,
    },
    hyperevm: {
      layerZeroKey: "hyperliquid",
      name: "Hyperliquid EVM",
      evmChainId: 999,
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpc: ["https://rpc.hyperliquid.xyz/evm", "https://hyperliquid.drpc.org"],
      explorer: "https://hyperevmscan.io",
      averageBlockMs: 1000,
    },
    "x-layer": {
      layerZeroKey: "xlayer",
      name: "X Layer",
      evmChainId: 196,
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpc: ["https://xlayerrpc.okx.com", "https://xlayer.drpc.org"],
      explorer: "https://www.oklink.com/xlayer",
      averageBlockMs: 1000,
    },
    bera: {
      layerZeroKey: "bera",
      name: "Berachain",
      evmChainId: 80094,
      nativeCurrency: { name: "BERA", symbol: "BERA", decimals: 18 },
      rpc: ["https://berachain-rpc.publicnode.com", "https://berachain.drpc.org"],
      explorer: "https://berascan.com",
      averageBlockMs: 1800,
    },
    flare: {
      layerZeroKey: "flare",
      name: "Flare",
      evmChainId: 14,
      nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
      rpc: ["https://flare-api.flare.network/ext/C/rpc", "https://rpc.ankr.com/flare"],
      explorer: "https://flarescan.com",
      averageBlockMs: 2100,
    },
    rootstock: {
      layerZeroKey: "rootstock",
      name: "Rootstock",
      evmChainId: 30,
      nativeCurrency: { name: "Smart Bitcoin", symbol: "RBTC", decimals: 18 },
      rpc: ["https://public-node.rsk.co", "https://mycrypto.rsk.co"],
      explorer: "https://explorer.rootstock.io",
      averageBlockMs: 20500,
    },
  },
};

/** Stellar's own decimals. Seven on both networks, and not negotiable. */
export const STELLAR_DECIMALS = 7;

export function sourceFor(network: NetworkId, chainId: string): EvmSource | undefined {
  return EVM_SOURCES[network][chainId];
}

/** Every chain this rail is willing to ask about, on this network. */
export function sourceChainsFor(network: NetworkId): readonly string[] {
  return Object.keys(EVM_SOURCES[network]);
}

/** Our chain id for one of LayerZero's keys, or undefined if we do not route it. */
export function chainIdForLayerZeroKey(network: NetworkId, key: string): string | undefined {
  for (const [chainId, source] of Object.entries(EVM_SOURCES[network])) {
    if (source.layerZeroKey === key) return chainId;
  }
  return undefined;
}

/**
 * A transaction's page on a block explorer, or an empty string where the chain
 * publishes none. Callers render no link rather than a broken one.
 */
export function explorerTxUrl(network: NetworkId, chainId: string, hash: string): string {
  const explorer = EVM_SOURCES[network][chainId]?.explorer;
  if (explorer === undefined) return "";
  return `${explorer.replace(/\/$/, "")}/tx/${hash}`;
}

export function stellarExplorerTxUrl(network: NetworkId, hash: string): string {
  return `https://stellar.expert/explorer/${STELLAR_SIDE[network].explorerPath}/tx/${hash}`;
}

/**
 * A base-unit integer as a person would read it.
 *
 * Used in the sentence a user is shown before signing. A signature is consent,
 * and consent needs the amount to be one the signer recognises as the amount
 * they typed. String arithmetic throughout, because a float here would round the
 * very figure being agreed to.
 */
export function readableAmount(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const negative = baseUnits < 0n;
  const value = negative ? -baseUnits : baseUnits;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}
