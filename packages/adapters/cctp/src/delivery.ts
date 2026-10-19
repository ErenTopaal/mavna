import { MavnaError } from "@mavna/core";
import type { NetworkConfig } from "@mavna/stellar";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { Contract, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { CCTP_CONTRACTS } from "./config.js";
import { fromHex } from "./hook.js";

/**
 * Delivering the mint on Stellar.
 *
 * Circle runs an off-chain forwarding service that does this for you on other
 * chains. It does not serve Stellar and structurally cannot, because it refuses
 * to forward whenever `destinationCaller` is set and Stellar requires it set.
 * So this step is ours to perform and ours to pay for.
 *
 * The call is `mint_and_forward` on Circle's forwarder, which calls
 * `receive_message` on the message transmitter to mint USDC to itself and then
 * transfers it to the recipient named in the hook data. It is one atomic unit:
 * if the recipient cannot hold USDC the whole thing reverts, the replay record
 * is rolled back with it, and the message stays deliverable. A user who arrives
 * unprepared is therefore stuck waiting, never robbed, and every design layered
 * on top of this must preserve that.
 */

export interface DeliveryInputs {
  readonly network: NetworkConfig;
  readonly networkId: "testnet" | "mainnet";
  /** Whoever submits and pays. Never the user, who may hold no XLM at all. */
  readonly payerAccount: Account;
  /** Raw CCTP message bytes, hex, from the attestation service. */
  readonly messageHex: string;
  /** Circle's signed attestation, hex. */
  readonly attestationHex: string;
  readonly feeStroops?: string;
}

/**
 * Build the delivery. Returns it unsigned: this package never signs and never
 * submits, which is what makes the non-custodial claim checkable by reading.
 */
export function buildDelivery(inputs: DeliveryInputs): Transaction {
  const { network, networkId, payerAccount, messageHex, attestationHex } = inputs;

  const message = fromHex(messageHex);
  const attestation = fromHex(attestationHex);

  if (message.length === 0) {
    throw new MavnaError("Refusing to deliver an empty CCTP message.", { retryable: false });
  }
  if (attestation.length === 0) {
    throw new MavnaError(
      "Refusing to deliver without an attestation. Circle has not signed this burn yet.",
      { retryable: true },
    );
  }

  const forwarder = new Contract(CCTP_CONTRACTS[networkId].cctpForwarder);

  return new TransactionBuilder(payerAccount, {
    fee: inputs.feeStroops ?? "10000000",
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      forwarder.call(
        "mint_and_forward",
        xdr.ScVal.scvBytes(Buffer.from(message)),
        xdr.ScVal.scvBytes(Buffer.from(attestation)),
      ),
    )
    .setTimeout(300)
    .build();
}

/**
 * What a refused delivery means, read from the simulation or submission error,
 * or undefined when it is an ordinary failure.
 *
 * `recipient-not-ready`: Circle's contract error for a recipient with no USDC
 * trustline, `Error(Contract, #13)` with diagnostic "trustline entry is missing
 * for account", reproduced on testnet. The whole invocation reverts with its
 * replay record, so the message stays deliverable.
 *
 * `already-delivered`: 6908 is `NonceAlreadyUsed` in the transmitter's own error
 * enum (`message-transmitter-v2/src/lib.rs`), which is what delivering a landed
 * message again looks like.
 */
export function deliveryFailureOf(
  text: string,
): "recipient-not-ready" | "already-delivered" | undefined {
  if (/#13\b|trustline entry is missing/i.test(text)) return "recipient-not-ready";
  if (/#\s*6908\b|nonce already used/i.test(text)) return "already-delivered";
  return undefined;
}

/**
 * Convert an amount between Circle's canonical six decimals and Stellar's seven.
 *
 * CCTP message amounts are ALWAYS in six-decimal units regardless of direction,
 * while Stellar's USDC uses seven. Outbound, the seventh decimal is silently
 * dropped as dust and stays in the sender's account. Inbound, the integer is
 * scaled by ten.
 *
 * Every conversion is integer arithmetic. Any floating point on an amount is a
 * defect, and this is the exact boundary where someone would be tempted.
 */
export function canonicalToLocal(canonicalBaseUnits: string): string {
  assertIntegerString(canonicalBaseUnits);
  return (BigInt(canonicalBaseUnits) * 10n).toString();
}

export function localToCanonical(localBaseUnits: string): {
  readonly canonical: string;
  /** What the seventh decimal drops. Stays with the sender rather than vanishing. */
  readonly dust: string;
} {
  assertIntegerString(localBaseUnits);
  const local = BigInt(localBaseUnits);
  return { canonical: (local / 10n).toString(), dust: (local % 10n).toString() };
}

/**
 * `max_fee` is in LOCAL seven-decimal units when calling Stellar's contract.
 *
 * Circle's own repository contradicts itself here: their published TypeScript
 * example documents six-decimal canonical units, while the contract's doc comments
 * and its code both say local. The contract wins, because it is what executes:
 * `deposit.rs` calls `to_canonical_amount(max_fee, ...)`, converting FROM local.
 * Following the example understates the fee tenfold.
 */
export const MAX_FEE_IS_IN_LOCAL_DECIMALS = true;

function assertIntegerString(value: string): void {
  if (!/^\d+$/.test(value)) {
    throw new MavnaError(`Amount must be integer base units, got: ${value}`, { retryable: false });
  }
}
