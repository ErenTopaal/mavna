/**
 * Talking to the sponsor service, which is the only server in the product.
 *
 * It exists because sponsorship needs a funded signer and a funded signer cannot
 * live in a browser. Everything it can do is three calls: build a preparation
 * for the user to sign, submit the signed result at its own expense, and
 * trigger the delivery of an attested transfer. Nothing here touches user funds.
 *
 * The URL is configuration, so an integrator points this at a sponsor they run
 * with their own keys, and our limits are never silently theirs. `createSponsorClient`
 * binds the base URL once and returns the calls, rather than reading a module-level
 * constant, so a widget an integrator configures reaches their sponsor and not ours.
 */

interface SponsorError {
  readonly error: string;
  readonly retryable: boolean;
}

export type SponsorDelivery =
  | { kind: "delivered"; txHash: string; ledger: number }
  | { kind: "already-delivered" }
  | { kind: "recipient-not-ready"; detail: string }
  | { kind: "not-attested-yet" };

export interface SponsorClient {
  /** The unsigned preparation, for the user's wallet. */
  requestPreparation(
    destination: string,
    sourceChainId: string,
  ): Promise<{ xdr: string; sponsor: string }>;
  /** The user has signed; the sponsor countersigns, pays and submits. */
  submitPreparation(signedXdr: string): Promise<{ txHash: string; ledger: number }>;
  /** The unsigned settlement, built on a channel the sponsor runs. */
  requestSettlement(
    destination: string,
    sourceChainId: string,
  ): Promise<{ xdr: string; channel: string }>;
  /** The user has signed; the sponsor holds it until their money lands. */
  commitSettlement(destination: string, signedXdr: string): Promise<{ held: boolean }>;
  /** Trigger the mint for an attested burn. Retrying is always safe. */
  requestDelivery(
    txHash: string,
    domain: number,
    destination?: string,
  ): Promise<SponsorDelivery & { settled?: boolean; settlementTxHash?: string }>;
  /** Whether a sponsor is reachable at all, for saying so before it matters. */
  sponsorIsUp(): Promise<boolean>;
}

export function createSponsorClient(baseUrl: string): SponsorClient {
  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
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

  return {
    requestPreparation(destination, sourceChainId) {
      return post("/prepare", { destination, assets: ["USDC"], sourceChainId });
    },
    submitPreparation(signedXdr) {
      return post("/submit", { signedXdr });
    },
    requestSettlement(destination, sourceChainId) {
      return post("/settlement", { destination, sourceChainId });
    },
    commitSettlement(destination, signedXdr) {
      return post("/settlement/commit", { destination, signedXdr });
    },
    requestDelivery(txHash, domain, destination) {
      return post("/deliver", { txHash, domain, destination });
    },
    async sponsorIsUp() {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(4_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
