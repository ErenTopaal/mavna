import type { NetworkId } from "@mavna/core";

/**
 * The chains this rail can be paid from.
 *
 * EVM only, because the deposit is an ordinary ERC-20 transfer and that is the
 * one kind of transaction a wallet here can sign. 1Click lists far more chains
 * than these, and a chain missing here is one nobody could execute a deposit on,
 * not one 1Click lacks.
 *
 * Keys are 1Click's own blockchain codes from `/v0/tokens`. Chain ids match the
 * ones the other rails use, so a user asking for "arbitrum" sees every rail that
 * can carry it rather than only the one whose vocabulary happened to match.
 *
 * The RPC URLs are only read from when a transfer has to be found again from its
 * transaction alone. Each answered `eth_chainId` with `evmChainId` on 19 October
 * 2026; anything that did not was left out.
 */
export interface OriginChain {
  /** 1Click's code for the chain, which is how its token list names it. */
  readonly code: string;
  readonly chainId: string;
  readonly name: string;
  readonly evmChainId: number;
  readonly rpc: readonly string[];
  readonly explorer: string;
}

const MAINNET: readonly OriginChain[] = [
  {
    code: "eth",
    chainId: "ethereum",
    name: "Ethereum",
    evmChainId: 1,
    rpc: ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth"],
    explorer: "https://etherscan.io",
  },
  {
    code: "arb",
    chainId: "arbitrum",
    name: "Arbitrum One",
    evmChainId: 42161,
    rpc: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
    explorer: "https://arbiscan.io",
  },
  {
    code: "base",
    chainId: "base",
    name: "Base",
    evmChainId: 8453,
    rpc: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    explorer: "https://basescan.org",
  },
  {
    code: "op",
    chainId: "optimism",
    name: "OP Mainnet",
    evmChainId: 10,
    rpc: ["https://mainnet.optimism.io", "https://1rpc.io/op"],
    explorer: "https://optimistic.etherscan.io",
  },
  {
    code: "pol",
    chainId: "polygon",
    name: "Polygon",
    evmChainId: 137,
    rpc: ["https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
    explorer: "https://polygonscan.com",
  },
  {
    code: "avax",
    chainId: "avalanche",
    name: "Avalanche",
    evmChainId: 43114,
    rpc: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
    explorer: "https://snowscan.xyz",
  },
  {
    code: "bsc",
    chainId: "bsc",
    name: "BNB Smart Chain",
    evmChainId: 56,
    rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"],
    explorer: "https://bscscan.com",
  },
  {
    code: "gnosis",
    chainId: "gnosis",
    name: "Gnosis",
    evmChainId: 100,
    rpc: ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com"],
    explorer: "https://gnosisscan.io",
  },
  {
    code: "bera",
    chainId: "bera",
    name: "Berachain",
    evmChainId: 80094,
    rpc: ["https://berachain-rpc.publicnode.com", "https://berachain.drpc.org"],
    explorer: "https://berascan.com",
  },
  {
    code: "monad",
    chainId: "monad",
    name: "Monad",
    evmChainId: 143,
    rpc: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"],
    explorer: "https://monadvision.com",
  },
  {
    code: "xlayer",
    chainId: "x-layer",
    name: "X Layer",
    evmChainId: 196,
    rpc: ["https://xlayerrpc.okx.com", "https://xlayer.drpc.org"],
    explorer: "https://www.oklink.com/xlayer",
  },
  {
    code: "plasma",
    chainId: "plasma",
    name: "Plasma",
    evmChainId: 9745,
    rpc: ["https://rpc.plasma.to"],
    explorer: "https://plasmascan.to",
  },
  {
    code: "scroll",
    chainId: "scroll",
    name: "Scroll",
    evmChainId: 534352,
    rpc: ["https://rpc.scroll.io", "https://scroll-rpc.publicnode.com"],
    explorer: "https://scrollscan.com",
  },
];

/**
 * 1Click runs on mainnet only. There is no test deployment to point at, so the
 * test network has no origin chains rather than mainnet's under another name.
 */
export const ORIGIN_CHAINS: Readonly<Record<NetworkId, readonly OriginChain[]>> = {
  mainnet: MAINNET,
  testnet: [],
};

export function originChain(network: NetworkId, chainId: string): OriginChain | undefined {
  return ORIGIN_CHAINS[network].find((chain) => chain.chainId === chainId);
}

export function originChainByCode(network: NetworkId, code: string): OriginChain | undefined {
  return ORIGIN_CHAINS[network].find((chain) => chain.code === code);
}

/** 1Click's code for Stellar in its token list. */
export const STELLAR_CODE = "stellar";
