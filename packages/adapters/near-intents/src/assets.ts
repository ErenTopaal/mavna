import type { Asset, NetworkId } from "@mavna/core";
import { StrKey } from "@stellar/stellar-sdk";
import type { OneClickToken } from "./api.js";
import { type OriginChain, STELLAR_CODE } from "./chains.js";

/**
 * What 1Click's token list means in this codebase's terms.
 *
 * 1Click names a Stellar asset by a symbol and, for an issued asset, the issuer
 * in `contractAddress`. That pair is the asset's identity on Stellar, and it is
 * the only thing compared: anyone can issue a token called USDC, so a symbol on
 * its own decides nothing.
 */

/** What a 1Click Stellar token is on Stellar itself, or undefined when that cannot be said. */
export function stellarIdentity(token: OneClickToken): string | undefined {
  if (token.blockchain !== STELLAR_CODE) return undefined;
  if (token.contractAddress === undefined) {
    // Only Stellar's own coin has no issuer. Anything else without one has no
    // identity that could be checked, so it is not offered at all.
    return token.symbol === "XLM" && token.decimals === 7 ? "native" : undefined;
  }
  // A classic asset code is one to twelve letters and digits. A symbol outside
  // that is not the code, and building an asset from it would name some other one.
  if (!/^[A-Za-z0-9]{1,12}$/.test(token.symbol)) return undefined;
  if (!StrKey.isValidEd25519PublicKey(token.contractAddress)) return undefined;
  return `${token.symbol}:${token.contractAddress}`;
}

export interface StellarDelivery {
  readonly token: OneClickToken;
  /** `CODE:ISSUER` or `native`. */
  readonly id: string;
}

/** Every Stellar asset 1Click delivers whose identity can be established. */
export function stellarDeliveries(tokens: readonly OneClickToken[]): readonly StellarDelivery[] {
  const out: StellarDelivery[] = [];
  for (const token of tokens) {
    const id = stellarIdentity(token);
    if (id !== undefined) out.push({ token, id });
  }
  return out;
}

/** The 1Click token for an EVM contract on a chain, matched by address and nothing else. */
export function originToken(
  tokens: readonly OneClickToken[],
  chain: OriginChain,
  contract: string,
): OneClickToken | undefined {
  const wanted = contract.toLowerCase();
  return tokens.find(
    (token) => token.blockchain === chain.code && token.contractAddress?.toLowerCase() === wanted,
  );
}

export function stellarChainId(network: NetworkId): string {
  return network === "mainnet" ? "stellar" : "stellar-testnet";
}

/** A Stellar asset as this codebase carries one. */
export function stellarAsset(network: NetworkId, delivery: StellarDelivery): Asset {
  return {
    chainId: stellarChainId(network),
    id: delivery.id,
    symbol: delivery.token.symbol,
    decimals: delivery.token.decimals,
    // The issuer vouches for an issued asset; Stellar itself for its own coin.
    curatedBy: delivery.id === "native" ? "Stellar" : undefined,
  };
}

/** An origin-chain token as this codebase carries one. */
export function originAsset(chain: OriginChain, token: OneClickToken): Asset {
  return {
    chainId: chain.chainId,
    id: (token.contractAddress ?? "").toLowerCase(),
    symbol: token.symbol,
    decimals: token.decimals,
    curatedBy: undefined,
  };
}
