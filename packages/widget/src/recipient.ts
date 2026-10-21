import { classifyAddress } from "@mavna/stellar";

/**
 * The account that signs for a recipient: itself, or for a muxed address the
 * account it wraps, which holds the balance. A contract has none, and an
 * address that is not one has none either.
 */
export function signerOf(destination: string): string | undefined {
  try {
    const classified = classifyAddress(destination);
    return classified.kind === "account" || classified.kind === "muxed"
      ? classified.trustlineHolder
      : undefined;
  } catch {
    // not an address at all: every rail declines it with its own reason
    return undefined;
  }
}

/** Whether a recipient is a contract, which holds a balance but signs nothing from a wallet. */
export function isContract(destination: string): boolean {
  try {
    return classifyAddress(destination).kind === "contract";
  } catch {
    return false;
  }
}
