/*
 * Where USDT0 can be sent from.
 *
 * USDT0 travels only over LayerZero, so the chains a user can pick for it are
 * that rail's own source chains, narrowed by the same allow and deny lists an
 * integrator sets for USDC. Some of them (Berachain, Flare, Rootstock, X Layer)
 * are chains Circle does not reach, so what a wallet needs to switch to them
 * comes from the LayerZero table too.
 */
import { EVM_SOURCES } from "@mavna/adapter-layerzero";
import type { NetworkId } from "@mavna/core";

export interface ChainFilter {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export function usdt0ChainsFor(
  network: NetworkId,
  filter: ChainFilter | undefined,
): ReadonlyArray<{ id: string; name: string }> {
  const allow = filter?.allow;
  const deny = filter?.deny;
  return Object.entries(EVM_SOURCES[network])
    .map(([id, chain]) => ({ id, name: chain.name }))
    .filter(
      (c) =>
        (allow === undefined || allow.includes(c.id)) &&
        (deny === undefined || !deny.includes(c.id)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a wallet needs to send from a chain only LayerZero carries, or undefined. */
export function layerZeroSourceDetail(
  network: NetworkId,
  chainId: string,
):
  | {
      readonly kind: "evm";
      readonly evmChainId: number;
      readonly name: string;
      readonly nativeCurrency: { name: string; symbol: string; decimals: number };
    }
  | undefined {
  const source = EVM_SOURCES[network][chainId];
  if (source === undefined) return undefined;
  return {
    kind: "evm",
    evmChainId: source.evmChainId,
    name: source.name,
    nativeCurrency: { ...source.nativeCurrency },
  };
}
