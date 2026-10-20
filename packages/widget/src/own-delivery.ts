import {
  AttestationService,
  buildDelivery,
  CCTP_CONTRACTS,
  deliveryFailureOf,
} from "@mavna/adapter-cctp";
import { Address, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Engine } from "./engine";

/**
 * Delivering a Circle transfer on Stellar from the receiving account itself.
 *
 * With reserves funded by the account (`MAVNA_RESERVE_FUNDING=self`) the
 * sponsor may hold no XLM at all, so it cannot pay `mint_and_forward`. The
 * receiving account signs and pays for it instead, from its own XLM.
 */

/**
 * The inclusion fee bid for the delivery, in stroops. The resource fee comes
 * from simulation on top of it. A testnet delivery was charged 69,257 stroops
 * in total, with a resource fee of 82,612 at most.
 */
export const OWN_DELIVERY_INCLUSION_FEE_STROOPS = 100_000;

/**
 * The most the account is asked to have spare for the delivery, in stroops,
 * and the most a prepared delivery may cost before it is refused unsigned.
 * Several times the measured cost, so a busier network still fits.
 */
export const OWN_DELIVERY_FEE_BUDGET_STROOPS = 1_000_000n;

/** The fee the sponsor bids on a self-funded trustline, in stroops. */
export const OWN_TRUSTLINE_FEE_STROOPS = 1_000n;

export type OwnDelivery =
  | { readonly kind: "delivered"; readonly txHash: string; readonly ledger: number }
  | { readonly kind: "already-delivered" }
  | { readonly kind: "not-attested-yet" }
  | { readonly kind: "recipient-not-ready"; readonly detail: string }
  /** Simulated dearer than the budget, so it was not signed and stays deliverable. */
  | { readonly kind: "too-costly"; readonly feeStroops: bigint }
  /** It would authorize more than the delivery, so it was not signed. */
  | { readonly kind: "refused"; readonly detail: string };

/**
 * Deliver one attested burn on Stellar, signed and paid by `payer`.
 *
 * The same `mint_and_forward` the sponsor submits: the recipient is fixed in
 * Circle's attested message, so whoever pays cannot redirect it. Circle's
 * transmitter refuses a used nonce, so asking twice never mints twice.
 */
export async function deliverOwn(
  engine: Pick<Engine, "network" | "rpc" | "stellar" | "stellarNetwork">,
  burnHash: string,
  domain: number,
  payer: string,
  attestations: AttestationService = new AttestationService(engine.network),
): Promise<OwnDelivery> {
  const found = await attestations.byTransaction(domain, burnHash);
  const ready = found.find(
    (a) => a.status === "complete" && a.message !== undefined && a.attestation !== undefined,
  );
  if (ready?.message === undefined || ready.attestation === undefined) {
    return { kind: "not-attested-yet" };
  }

  const unsigned = buildDelivery({
    network: engine.stellarNetwork,
    networkId: engine.network,
    payerAccount: await engine.rpc.loadAccount(payer),
    messageHex: ready.message,
    attestationHex: ready.attestation,
    feeStroops: String(OWN_DELIVERY_INCLUSION_FEE_STROOPS),
  });

  let prepared: Transaction;
  try {
    // simulated first: a recipient that cannot hold USDC, or a delivery that
    // already landed, shows up here before anything is signed or spent
    prepared = await engine.rpc.prepare(unsigned);
  } catch (cause) {
    return refused(cause);
  }
  // The payer's signature covers whatever the simulation recorded. Circle's
  // forwarder asks for nothing today; anything beyond the payer's own root call
  // to it would be the payer's authority spent on someone else's code.
  if (!authorizesOnlyDelivery(prepared, payer, CCTP_CONTRACTS[engine.network].cctpForwarder)) {
    return {
      kind: "refused",
      detail:
        "Delivering this would authorize more than the delivery itself, so it was not signed. " +
        "The funds are safe on Circle's side and still deliverable.",
    };
  }
  const fee = BigInt(prepared.fee);
  if (fee > OWN_DELIVERY_FEE_BUDGET_STROOPS) return { kind: "too-costly", feeStroops: fee };

  const signed = TransactionBuilder.fromXDR(
    await engine.stellar.sign(prepared.toXDR(), payer),
    engine.stellarNetwork.passphrase,
  );
  try {
    const result = await engine.rpc.submit("cctp delivery", async () => signed, {
      presigned: true,
    });
    return { kind: "delivered", txHash: result.txHash, ledger: result.ledger };
  } catch (cause) {
    return refused(cause);
  }
}

function authorizesOnlyDelivery(prepared: Transaction, payer: string, forwarder: string): boolean {
  const op = prepared.operations[0];
  if (prepared.operations.length !== 1 || op?.type !== "invokeHostFunction") return false;
  return (op.auth ?? []).every((entry) => {
    const credentials = entry.credentials();
    const own =
      credentials.switch().name === "sorobanCredentialsSourceAccount" ||
      (credentials.switch().name === "sorobanCredentialsAddress" &&
        Address.fromScAddress(credentials.address().address()).toString() === payer);
    const root = entry.rootInvocation();
    const fn = root.function();
    return (
      own &&
      root.subInvocations().length === 0 &&
      fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn" &&
      Address.fromScAddress(fn.contractFn().contractAddress()).toString() === forwarder &&
      fn.contractFn().functionName().toString() === "mint_and_forward"
    );
  });
}

function refused(cause: unknown): OwnDelivery {
  const failure = deliveryFailureOf(cause instanceof Error ? cause.message : String(cause));
  if (failure === "already-delivered") return { kind: "already-delivered" };
  if (failure === "recipient-not-ready") {
    return {
      kind: "recipient-not-ready",
      detail:
        "The recipient cannot hold USDC yet. Nothing was consumed and the funds " +
        "are still deliverable once their account is ready.",
    };
  }
  throw cause;
}
