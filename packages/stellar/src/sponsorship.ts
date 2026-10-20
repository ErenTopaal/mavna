import { MavnaError } from "@mavna/core";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { Asset, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { classifyAddress } from "./address.js";
import type { NetworkConfig } from "./network.js";

/**
 * Building the two transactions sponsorship needs. Neither signs anything: these
 * return unsigned transactions and the caller supplies signatures, because the
 * SDK must never be in a position to move anyone's funds.
 *
 * The mechanism: the sponsor sponsors the reserves of the account and its
 * trustlines inside one preparation, and is repaid by a settlement the user signs
 * in advance. Changing it changes what the sponsor can lose.
 */

export interface PreparationInputs {
  readonly network: NetworkConfig;
  /** Funded account that carries the reserve. Must be the transaction source. */
  readonly sponsorAccount: Account;
  /** The arriving user. May not exist on-chain yet. */
  readonly userAddress: string;
  /** True when the account has to be created as well as given a trustline. */
  readonly createAccount: boolean;
  /** Assets the account must be able to hold. One or two; never more. */
  readonly assets: readonly Asset[];
  readonly feeStroops?: string;
}

/**
 * At most two permissions per preparation, and only for the assets in the quote
 * being executed. This bounds what one preparation can cost the sponsor; it does
 * not stop a second preparation for the same account, which only the sponsor's
 * own caps limit.
 */
const MAX_SPONSORED_ASSETS = 2;

/**
 * Build the transaction that makes an account able to receive.
 *
 * Ordering is not negotiable: this must land before funds arrive. Value arriving
 * at an unprepared account is rejected as a whole unit, which loses nothing but
 * lands nothing either.
 *
 * Signed by the sponsor AND the user: the sponsor sources the transaction and pays,
 * the user signs the operations that create obligations on their own account.
 */
export function buildPreparation(inputs: PreparationInputs): Transaction {
  const { network, sponsorAccount, userAddress, createAccount, assets } = inputs;

  const classified = classifyAddress(userAddress);
  if (!classified.needsTrustline) {
    throw new MavnaError(`A ${classified.kind} address needs no preparation; do not sponsor one.`, {
      retryable: false,
    });
  }
  if (assets.length === 0) {
    throw new MavnaError("Preparation needs at least one asset.", { retryable: false });
  }
  if (assets.length > MAX_SPONSORED_ASSETS) {
    throw new MavnaError(
      `Refusing to sponsor ${assets.length} trustlines; the limit is ${MAX_SPONSORED_ASSETS}.`,
      { retryable: false },
    );
  }

  // A muxed address is a wrapper. The account entry and the trustlines belong to
  // the account underneath it, so that is what gets prepared.
  const holder = classified.trustlineHolder ?? userAddress;

  const builder = new TransactionBuilder(sponsorAccount, {
    fee: inputs.feeStroops ?? "1000000",
    networkPassphrase: network.passphrase,
  }).addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: holder }));

  if (createAccount) {
    // Zero starting balance: the user is given the ability to receive, not funds.
    builder.addOperation(Operation.createAccount({ destination: holder, startingBalance: "0" }));
  }

  for (const asset of assets) {
    builder.addOperation(Operation.changeTrust({ asset, source: holder }));
  }

  builder.addOperation(Operation.endSponsoringFutureReserves({ source: holder }));

  return builder.setTimeout(300).build();
}

export interface SettlementInputs {
  readonly network: NetworkConfig;
  /**
   * Account carrying the sequence number for this settlement. A dedicated channel,
   * because a pre-signed transaction occupies its sequence number until it lands
   * or expires, so one channel serves exactly one in-flight settlement.
   */
  readonly channelAccount: Account;
  readonly sponsorAddress: string;
  readonly userAddress: string;
  /** The asset the user will pay from, which is what the bridge delivered. */
  readonly payingAsset: Asset;
  /**
   * Exactly the XLM the user must end up holding to absorb the reserve. Strict
   * receive, so price movement is absorbed by the maximum spend rather than
   * invalidating a signature collected before the transfer even started.
   */
  readonly xlmNeeded: string;
  /** Ceiling on what may be spent acquiring that XLM. */
  readonly maxSpend: string;
  /** Assets whose trustline sponsorship is being handed back. */
  readonly assets: readonly Asset[];
  readonly createdAccount: boolean;
  /** Must cover the worst bridge, not the median. Seconds. */
  readonly validForSeconds?: number;
  readonly feeStroops?: string;
}

/** A whole day. Circle's standard transfer has no guaranteed ceiling. */
const DEFAULT_VALIDITY_SECONDS = 86_400;

/**
 * Build the settlement, which the user signs BEFORE any capital is committed.
 *
 * It acquires the XLM the user needs and hands the reserve obligation to them, as
 * one atomic unit. Atomicity is not strictly required, since the sponsor can hand
 * back its own claim alone, but bundling removes the race where the user moves the
 * XLM out in between, and it is free because all of these are classic operations.
 *
 * This is one transaction, for one amount, with a bounded life, signed while the
 * user is present. It is consent to a known act, not a standing permission over
 * their balance.
 */
export function buildSettlement(inputs: SettlementInputs): Transaction {
  const { network, channelAccount, sponsorAddress, userAddress, assets } = inputs;

  const classified = classifyAddress(userAddress);
  const holder = classified.trustlineHolder ?? userAddress;

  if (assets.length === 0) {
    throw new MavnaError("Settlement needs the assets whose sponsorship it releases.", {
      retryable: false,
    });
  }

  const builder = new TransactionBuilder(channelAccount, {
    fee: inputs.feeStroops ?? "1000000",
    networkPassphrase: network.passphrase,
  })
    // The user buys exactly the XLM they need, spending no more than the ceiling
    // they agreed to. Sourced to them, so this operation carries their consent.
    .addOperation(
      Operation.pathPaymentStrictReceive({
        source: holder,
        sendAsset: inputs.payingAsset,
        sendMax: inputs.maxSpend,
        destination: holder,
        destAsset: Asset.native(),
        destAmount: inputs.xlmNeeded,
        path: [],
      }),
    );

  // Releasing our own claim. Sourced to the sponsor and needing only the sponsor's
  // signature: this moves none of the user's assets, it relinquishes ours.
  for (const asset of assets) {
    builder.addOperation(
      Operation.revokeTrustlineSponsorship({
        account: holder,
        asset,
        source: sponsorAddress,
      }),
    );
  }

  if (inputs.createdAccount) {
    builder.addOperation(
      Operation.revokeAccountSponsorship({ account: holder, source: sponsorAddress }),
    );
  }

  return builder.setTimeout(inputs.validForSeconds ?? DEFAULT_VALIDITY_SECONDS).build();
}

/**
 * A pre-signed settlement gets exactly one attempt: a failure at the operation
 * level still consumes the channel's sequence number, killing the transaction.
 *
 * The ladder is the answer. Consecutive sequence numbers give a fixed number of
 * retries, and because they must be consumed in order, a permanent failure on one
 * rung leaves a gap the rest can never cross. That is why one channel serves one
 * settlement rather than many.
 */
export function buildSettlementLadder(
  inputs: SettlementInputs,
  rungs: number,
): readonly Transaction[] {
  if (rungs < 1) {
    throw new MavnaError("A settlement ladder needs at least one rung.", { retryable: false });
  }

  const base = BigInt(inputs.channelAccount.sequenceNumber());
  return Array.from({ length: rungs }, (_, index) =>
    buildSettlement({
      ...inputs,
      channelAccount: cloneAccountAtSequence(inputs.channelAccount, base + BigInt(index)),
    }),
  );
}

function cloneAccountAtSequence(account: Account, sequence: bigint): Account {
  // TransactionBuilder increments the sequence it is given, so a rung targeting
  // sequence N is built from an account object sitting at N-1.
  return {
    accountId: () => account.accountId(),
    sequenceNumber: () => sequence.toString(),
    incrementSequenceNumber: () => {},
  } as Account;
}
