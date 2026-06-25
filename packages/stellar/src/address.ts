import { MavnaError } from "@mavna/core";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The address forms Stellar actually has. They behave differently and the
 * differences matter for money: never infer what an address is from its shape.
 */
export type AddressKind =
  | "account" // G... an ordinary account
  | "muxed" // M... an account plus a sub-account id, used by custodians
  | "contract" // C... a smart contract
  | "claimable-balance" // B... not a payment destination
  | "liquidity-pool" // L... not a payment destination
  | "signed-payload" // P... a signer, not a destination
  | "secret"; // S... a private key. Must never appear in our system.

export interface ClassifiedAddress {
  readonly kind: AddressKind;
  readonly address: string;
  /** Whether value can be sent here at all. */
  readonly canReceive: boolean;
  /**
   * Whether holding a non-native asset here requires a trustline first.
   * Contracts store balances in contract storage instead, so they do not.
   */
  readonly needsTrustline: boolean;
  /**
   * The underlying account a trustline would live on. For a muxed address the
   * trustline belongs to the account it wraps, not to the muxed form itself.
   */
  readonly trustlineHolder: string | undefined;
}

/**
 * Classify an address, or throw. Callers get a total answer or an error, never a
 * guess, because every ambiguity here ends in misdirected funds.
 */
export function classifyAddress(address: string): ClassifiedAddress {
  if (typeof address !== "string" || address.length === 0) {
    throw new MavnaError("Address is empty.", { retryable: false });
  }

  // Checked first and rejected loudly. A secret key reaching this function means
  // something upstream is handling keys that should never have them.
  if (StrKey.isValidEd25519SecretSeed(address)) {
    throw new MavnaError("Refusing to handle a secret key.", { retryable: false });
  }

  if (StrKey.isValidEd25519PublicKey(address)) {
    return {
      kind: "account",
      address,
      canReceive: true,
      needsTrustline: true,
      trustlineHolder: address,
    };
  }

  if (StrKey.isValidMed25519PublicKey(address)) {
    return {
      kind: "muxed",
      address,
      canReceive: true,
      needsTrustline: true,
      trustlineHolder: underlyingAccountOfMuxed(address),
    };
  }

  if (StrKey.isValidContract(address)) {
    return {
      kind: "contract",
      address,
      canReceive: true,
      // Contract balances live in contract storage, so no trustline and no reserve.
      needsTrustline: false,
      trustlineHolder: undefined,
    };
  }

  if (StrKey.isValidClaimableBalance(address)) {
    return notADestination("claimable-balance", address);
  }
  if (StrKey.isValidLiquidityPool(address)) {
    return notADestination("liquidity-pool", address);
  }
  if (StrKey.isValidSignedPayload(address)) {
    return notADestination("signed-payload", address);
  }

  throw new MavnaError(`Not a Stellar address: ${truncate(address)}`, { retryable: false });
}

function notADestination(kind: AddressKind, address: string): ClassifiedAddress {
  return { kind, address, canReceive: false, needsTrustline: false, trustlineHolder: undefined };
}

/**
 * A muxed address encodes an underlying account plus a 64-bit id. The trustline,
 * the reserve and the balance all belong to that underlying account.
 */
export function underlyingAccountOfMuxed(muxed: string): string {
  if (!StrKey.isValidMed25519PublicKey(muxed)) {
    throw new MavnaError(`Not a muxed address: ${truncate(muxed)}`, { retryable: false });
  }
  // The M-form is the 32-byte ed25519 key followed by an 8-byte id.
  const raw = StrKey.decodeMed25519PublicKey(muxed);
  return StrKey.encodeEd25519PublicKey(raw.subarray(0, 32));
}

/**
 * Assert an address can receive value, throwing with a reason it can be shown to
 * a user if it cannot.
 */
export function assertCanReceive(address: string): ClassifiedAddress {
  const classified = classifyAddress(address);
  if (!classified.canReceive) {
    throw new MavnaError(`A ${classified.kind} address cannot receive a payment.`, {
      retryable: false,
    });
  }
  return classified;
}

/**
 * Whether a destination needs a memo to identify the real recipient behind it.
 *
 * A muxed address carries that id in the address itself, which is why it exists.
 * A bare account belonging to a custodian needs a memo instead, and there is no
 * way to tell that from the address: it comes from the account's own published
 * configuration (SEP-29). Callers must resolve it, never assume it.
 */
export function memoIsEncodedInAddress(address: string): boolean {
  return classifyAddress(address).kind === "muxed";
}

function truncate(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}
