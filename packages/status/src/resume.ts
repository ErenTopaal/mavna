import { MavnaError, type TransferHandle } from "@mavna/core";

/**
 * Finding a transfer again.
 *
 * Closing the tab must not lose the transfer, and recovery must need only what
 * the user already has. Never an account, never a session, never something they
 * were told to save.
 *
 * This is the largest single differentiator available. The most mature product in
 * this category REFUSES a deposit address as a lookup key: its own type requires
 * either a transaction hash or an internal task id, and its resume path is gated
 * on the wallet being reconnected, so a reload without reconnecting resumes
 * nothing at all. On Stellar a deposit address plus memo is the natural shape,
 * and a user who closed the tab has their destination address if they have
 * nothing else.
 */

/** Anything a user might still have. Any ONE of these is enough. */
export type LookupKey =
  | { readonly kind: "source-tx"; readonly value: string }
  | { readonly kind: "deposit-address"; readonly value: string }
  | { readonly kind: "destination-address"; readonly value: string };

export function parseLookupKey(input: string): LookupKey {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new MavnaError("Enter a transaction, a deposit address, or the address you sent to.", {
      retryable: false,
    });
  }

  // Deliberately permissive about form. A user pasting something from a wallet or
  // an explorer should not have to know which of the three they have.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { kind: "source-tx", value: trimmed };
  }
  if (/^[GMC][A-Z2-7]{55,}$/.test(trimmed)) {
    // A Stellar address could be either end. Both are tried, so it does not matter.
    return { kind: "destination-address", value: trimmed };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { kind: "deposit-address", value: trimmed };
  }
  // Starknet explorers print a hash without its leading zeros, and Solana
  // signatures are base58. CCTP finds a burn from either.
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    return { kind: "source-tx", value: trimmed };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(trimmed)) {
    return { kind: "source-tx", value: trimmed };
  }

  throw new MavnaError(
    "That does not look like a transaction or an address. Paste the transaction " +
      "from the chain you sent from, or the address you sent to.",
    { retryable: false },
  );
}

export function toHandle(key: LookupKey, sourceChainId?: string): TransferHandle {
  return {
    sourceTxHash: key.kind === "source-tx" ? key.value : undefined,
    depositAddress: key.kind === "deposit-address" ? key.value : undefined,
    destinationAddress: key.kind === "destination-address" ? key.value : undefined,
    // Usually absent, and that is the point. Someone recovering a transfer has
    // whatever they still have; an adapter that spans many chains searches them
    // all rather than making the user remember which one they sent from.
    sourceChainId,
  };
}

/** Whether a handle carries anything at all to search on. */
export function isSearchable(handle: TransferHandle): boolean {
  return (
    handle.sourceTxHash !== undefined ||
    handle.depositAddress !== undefined ||
    handle.destinationAddress !== undefined
  );
}

/**
 * Where an in-flight transfer is remembered locally.
 *
 * Local memory is a convenience, never the source of truth. Everything must be
 * recoverable from the chain using a lookup key alone, because a user on a
 * different device has no local memory at all and the functional requirements
 * say they must either find their transfer or be told plainly that they cannot.
 */
export interface TransferStore {
  remember(id: string, handle: TransferHandle): Promise<void>;
  forget(id: string): Promise<void>;
  all(): Promise<readonly { id: string; handle: TransferHandle }[]>;
}

export class InMemoryTransferStore implements TransferStore {
  private readonly entries = new Map<string, TransferHandle>();

  async remember(id: string, handle: TransferHandle): Promise<void> {
    this.entries.set(id, handle);
  }

  async forget(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async all(): Promise<readonly { id: string; handle: TransferHandle }[]> {
    return [...this.entries].map(([id, handle]) => ({ id, handle }));
  }
}

/**
 * Resumption must NOT be gated on a wallet connection.
 *
 * The prior art's resume path is conditional on the wallet being connected, so a
 * reload without reconnecting silently resumes nothing while appearing to work.
 * Watching a transfer needs no signature; only acting on it does. Those are
 * separate concerns and conflating them strands users who simply reopened a tab.
 */
export const RESUMPTION_DOES_NOT_REQUIRE_A_WALLET = true;
