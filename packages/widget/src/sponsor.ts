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

export interface SponsorSettle {
  settled: boolean;
  settlementTxHash?: string;
  settlementRetryable?: boolean;
  /** Present, and false, only when the sponsor holds no settlement for the account. */
  held?: false;
}

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
  ): Promise<
    SponsorDelivery & {
      settled?: boolean;
      settlementTxHash?: string;
      settlementRetryable?: boolean;
    }
  >;
  /**
   * Ask the sponsor to submit the settlement it holds for an account, which it
   * does only once the money the settlement spends from has arrived.
   *
   * Polled after funds land, so the server's two ordinary refusals are answers
   * and not failures: 404 (nothing held) resolves `held: false`, and 429 (asked
   * too often) resolves `settlementRetryable: true`. Anything else rejects.
   */
  settle(destination: string): Promise<SponsorSettle>;
  /** Whether a sponsor is reachable at all, for saying so before it matters. */
  sponsorIsUp(): Promise<boolean>;
}

export function createSponsorClient(baseUrl: string): SponsorClient {
  interface Answer {
    status: number;
    ok: boolean;
    body: unknown;
  }

  /**
   * One round trip, with the body read as text first. A proxy or gateway can
   * answer with HTML, and that must surface as the status, not as a JSON parse
   * error nobody can act on.
   */
  async function send(path: string, body: Record<string, unknown>): Promise<Answer> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`The sponsor answered ${response.status}.`);
    }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  function failure(answer: Answer): Error {
    // The server writes its errors for people, so they pass through as said.
    const said = (answer.body as Partial<SponsorError> | null)?.error;
    return new Error(said ?? `The sponsor answered ${answer.status}.`);
  }

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const answer = await send(path, body);
    if (!answer.ok) throw failure(answer);
    return answer.body as T;
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
    async requestDelivery(txHash, domain, destination) {
      const answer = await send("/deliver", { txHash, domain, destination });
      // Not attested yet (404) and recipient not ready (409) are the polling
      // loop's ordinary answers, so they come back as outcomes, not errors.
      if (answer.status === 404) return { kind: "not-attested-yet" };
      if (answer.status === 409 && (answer.body as { kind?: unknown } | null)?.kind) {
        return answer.body as SponsorDelivery;
      }
      if (!answer.ok) throw failure(answer);
      return answer.body as SponsorDelivery;
    },
    async settle(destination) {
      const answer = await send("/settle", { destination });
      if (answer.status === 404) return { settled: false, held: false };
      if (answer.status === 429) return { settled: false, settlementRetryable: true };
      if (!answer.ok) throw failure(answer);
      return answer.body as SponsorSettle;
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
