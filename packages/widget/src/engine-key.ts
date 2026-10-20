import type { EngineConfig } from "./engine";

// A host's own signer has no value to compare, only an identity.
const signers = new WeakMap<object, number>();
let nextSigner = 0;

function signerId(signer: object | undefined): string {
  if (signer === undefined) return "";
  let id = signers.get(signer);
  if (id === undefined) {
    nextSigner += 1;
    id = nextSigner;
    signers.set(signer, id);
  }
  return String(id);
}

/**
 * Every config value the engine is built from, as one string. The engine is
 * rebuilt exactly when this changes, so a field missing here is a change the
 * host makes that silently never takes effect.
 */
export function engineKeyOf(ec: EngineConfig): string {
  return JSON.stringify([
    ec.network,
    ec.rpcUrl,
    ec.sponsorUrl,
    ec.disabledSources ?? "",
    ec.ranking,
    ec.integratorFee === undefined ? "" : `${ec.integratorFee.bps}:${ec.integratorFee.recipient}`,
    ec.arrivalContract ?? "",
    ec.rails ?? null,
    ec.chains?.allow ?? null,
    ec.chains?.deny ?? null,
    ec.historyKey,
    signerId(ec.stellar),
  ]);
}
