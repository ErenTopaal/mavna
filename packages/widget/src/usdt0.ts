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
import type { Asset, NetworkId } from "@mavna/core";
import type { SwapAttachment } from "@mavna/routing";
import { Networks, Asset as StellarAsset } from "@stellar/stellar-sdk";

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

/** The contract id an asset trades under on Stellar: its asset contract. */
function contractOf(network: NetworkId, id: string): string {
  const passphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  if (id === "native") return StellarAsset.native().contractId(passphrase);
  const [code, issuer] = id.split(":");
  if (code === undefined || issuer === undefined) return id;
  return new StellarAsset(code, issuer).contractId(passphrase);
}

/**
 * Converting what LayerZero delivers (USDT0) into what the user wants. Keyed
 * by token contracts, since that is how both the venues and the Arrival
 * Contract name them; the plain route converts with the user's own signature,
 * and the race also asks LayerZero for a conversion on arrival with it.
 */
export function usdt0SwapFor(
  network: NetworkId,
  provider: SwapAttachment["provider"],
  usdt0: Asset,
  wanted: Asset,
): SwapAttachment {
  return {
    provider,
    delivered: usdt0,
    deliveredContract: contractOf(network, usdt0.id),
    wanted,
    wantedContract: contractOf(network, wanted.id),
  };
}
