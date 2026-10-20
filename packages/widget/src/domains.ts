import { EVM_DEPLOYMENTS, NON_EVM_CHAINS } from "@mavna/adapter-cctp";
import type { NetworkId } from "@mavna/core";

/** The chain lists an integrator narrows the picker with. */
export interface ChainFilter {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/**
 * The chains USDC can be sent from on a network, narrowed by the integrator's
 * lists. Both families, not just EVM: the adapters quote Solana and Starknet
 * too. The filter only removes chains, never invents one.
 */
export function usdcSourceChains(
  network: NetworkId,
  chains: ChainFilter | undefined,
): ReadonlyArray<{ id: string; name: string }> {
  const all = [
    ...Object.entries(EVM_DEPLOYMENTS[network]).map(([id, chain]) => ({ id, name: chain.name })),
    ...Object.entries(NON_EVM_CHAINS[network]).map(([id, chain]) => ({ id, name: chain.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const { allow, deny } = chains ?? {};
  return all.filter(
    (c) =>
      (allow === undefined || allow.includes(c.id)) && (deny === undefined || !deny.includes(c.id)),
  );
}

/**
 * Circle's domain for a source chain, which is what a delivery is keyed on.
 * A chain Circle does not serve here has none; guessing one would ask Circle
 * about some other chain's burn and report it as not attested yet, forever.
 */
export function circleDomain(network: NetworkId, chainId: string): number {
  const domain =
    EVM_DEPLOYMENTS[network][chainId]?.domain ?? NON_EVM_CHAINS[network][chainId]?.domain;
  if (domain === undefined) {
    throw new Error(`Circle does not serve ${chainId} on ${network}, so it has no domain here.`);
  }
  return domain;
}
