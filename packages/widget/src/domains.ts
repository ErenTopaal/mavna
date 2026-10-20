import { EVM_DEPLOYMENTS, NON_EVM_CHAINS } from "@mavna/adapter-cctp";
import type { NetworkId } from "@mavna/core";

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
