import type { NetworkId, QuoteRequest } from "@mavna/core";
import { deploymentFor } from "./chains.js";
import { nonEvmChainFor } from "./nonevm.js";
import { SOLANA_USDC } from "./solana.js";
import { STARKNET_DEPLOYMENTS } from "./starknet.js";

/**
 * The USDC a burn will actually spend on a source chain, and how to compare it.
 *
 * The burn is built from these addresses and never from the request, so the
 * request's asset has to be checked against them. A quote that names a token the
 * burn will not touch shows one asset and moves another.
 */
export interface SourceUsdc {
  readonly family: "evm" | "solana" | "starknet";
  readonly address: string;
}

export function sourceUsdcFor(network: NetworkId, chainId: string): SourceUsdc | undefined {
  const evm = deploymentFor(network, chainId);
  if (evm !== undefined) return { family: "evm", address: evm.usdc };
  const other = nonEvmChainFor(network, chainId);
  if (other?.family === "solana") return { family: "solana", address: SOLANA_USDC[network] };
  if (other?.family === "starknet") {
    return { family: "starknet", address: STARKNET_DEPLOYMENTS[network].usdc };
  }
  return undefined;
}

/** Starknet felts have no fixed width in text, so 0x05 and 0x5 are the same address. */
function normaliseFelt(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return `0x${hex === "" ? "0" : hex}`;
}

function sameSourceAddress(source: SourceUsdc, candidate: string): boolean {
  switch (source.family) {
    case "evm":
      return source.address.toLowerCase() === candidate.toLowerCase();
    case "starknet":
      return normaliseFelt(source.address) === normaliseFelt(candidate);
    // base58 is case-sensitive, so a case-folded match could be a different mint
    case "solana":
      return source.address === candidate;
  }
}

/**
 * Whether both ends of a request are the canonical USDC, by address and issuer.
 * The symbol is ignored on purpose: anyone can issue a token called USDC.
 */
export function assetsAreCanonical(
  request: QuoteRequest,
  sourceUsdc: SourceUsdc,
  stellarUsdcId: string,
): boolean {
  return (
    sameSourceAddress(sourceUsdc, request.from.id) &&
    sameSourceAddress(sourceUsdc, request.sends.asset.id) &&
    request.to.id === stellarUsdcId
  );
}
