/**
 * Talking to the sponsor service, which is the only server in the product.
 *
 * It exists because sponsorship needs a funded signer and a funded signer cannot
 * live in a browser. Everything it can do is three calls: build a preparation
 * for the user to sign, submit the signed result at its own expense, and
 * trigger the delivery of an attested transfer. Nothing here touches user funds.
 *
 * The URL is configuration, so an integrator points this at a sponsor they run
 * with their own keys, and our limits are never silently theirs.
 */

export const SPONSOR_URL: string =
  import.meta.env.VITE_MAVNA_SPONSOR_URL ?? "http://localhost:8787";

interface SponsorError {
  readonly error: string;
  readonly retryable: boolean;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SPONSOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as T | SponsorError;
  if (!response.ok) {
    // The server writes its errors for people, so they pass through as said.
    throw new Error((parsed as SponsorError).error ?? "The sponsor did not answer.");
  }
  return parsed as T;
}

/** The unsigned preparation, for the user's wallet. */
export function requestPreparation(
  destination: string,
  sourceChainId: string,
): Promise<{ xdr: string; sponsor: string }> {
  return post("/prepare", { destination, assets: ["USDC"], sourceChainId });
}

/** The user has signed; the sponsor countersigns, pays and submits. */
export function submitPreparation(signedXdr: string): Promise<{ txHash: string; ledger: number }> {
  return post("/submit", { signedXdr });
}

export type SponsorDelivery =
  | { kind: "delivered"; txHash: string; ledger: number }
  | { kind: "already-delivered" }
  | { kind: "recipient-not-ready"; detail: string }
  | { kind: "not-attested-yet" };

/** Trigger the mint for an attested burn. Retrying is always safe. */
export function requestDelivery(txHash: string, domain: number): Promise<SponsorDelivery> {
  return post("/deliver", { txHash, domain });
}

/** Whether a sponsor is reachable at all, for saying so before it matters. */
export async function sponsorIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${SPONSOR_URL}/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
