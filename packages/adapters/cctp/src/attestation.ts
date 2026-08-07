import { MavnaError, type NetworkId } from "@mavna/core";
import { IRIS_BASE_URL } from "./config.js";

/**
 * Circle's attestation service: the thing that witnesses a burn on the source
 * chain and signs a receipt authorising the mint on Stellar.
 *
 * Public, no key, no signup. Rate limited at 40 requests a second, and exceeding
 * it blocks ALL requests for five minutes, so the poller is deliberately unhurried.
 */

/** Two format traps that cost an afternoon each if you get them wrong. */
export const HASH_FORMAT = {
  /** For Stellar, the transaction hash is passed WITHOUT a 0x prefix. */
  stellarTxHashHasNoPrefix: true,
  /** But the nonce is passed WITH one. */
  nonceHasPrefix: true,
} as const;

export type AttestationStatus = "pending_confirmations" | "complete";

export interface Attestation {
  readonly status: AttestationStatus;
  /** The raw message bytes, hex. Present once complete. */
  readonly message: string | undefined;
  /** The signed attestation, hex. Present once complete. */
  readonly attestation: string | undefined;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  /** Why it is taking longer than usual, when Circle says. */
  readonly delayReason: string | null;
  /**
   * The final recipient, read out of the hook data.
   *
   * Circle's own documentation claims every address field comes back null when
   * Stellar is involved. That is an overstatement: only the STELLAR-SIDE fields
   * are null, and which ones those are depends on direction. Rather than depend
   * on their decoded fields at all, this is parsed from the raw message.
   */
  readonly hookData: string | undefined;
  /**
   * What Circle attested was burned, in its canonical six decimals.
   *
   * Carried because a delivery cannot be confirmed without it. The recipient's
   * balance alone cannot tell an arrival from money they already had: a user who
   * holds any USDC would be told their transfer was done the moment it was
   * attested, and one who holds none would sit at pending forever.
   */
  readonly amount: string | undefined;
}

export class AttestationService {
  private readonly baseUrl: string;

  constructor(network: NetworkId, baseUrl?: string) {
    // Overridable because the requirements say every external endpoint must be
    // pointable at infrastructure the integrator controls, and this one is the
    // sole price source for every quote on this rail.
    this.baseUrl = baseUrl ?? IRIS_BASE_URL(network);
  }

  /**
   * Look up the attestation for a burn.
   *
   * `sourceDomain` is Circle's own identifier for the chain the burn happened on,
   * which is NOT a chain id and must never be confused with one.
   */
  async byTransaction(sourceDomain: number, txHash: string): Promise<readonly Attestation[]> {
    // Stellar hashes go WITHOUT the prefix; EVM hashes carry it. Sending the
    // wrong form returns a 404 that looks exactly like "no such transfer".
    const hash = sourceDomain === 27 ? txHash.replace(/^0x/, "") : txHash;
    return this.fetchMessages(`?transactionHash=${hash}`, sourceDomain);
  }

  async byNonce(sourceDomain: number, nonce: string): Promise<readonly Attestation[]> {
    const withPrefix = nonce.startsWith("0x") ? nonce : `0x${nonce}`;
    return this.fetchMessages(`?nonce=${withPrefix}`, sourceDomain);
  }

  private async fetchMessages(
    query: string,
    sourceDomain: number,
  ): Promise<readonly Attestation[]> {
    const url = `${this.baseUrl}/v2/messages/${sourceDomain}${query}`;
    const response = await fetch(url);

    if (response.status === 404) {
      // Not an error. The service has not seen the burn yet, which is the normal
      // state for the first minutes of every transfer.
      return [];
    }
    if (response.status === 429) {
      throw new MavnaError(
        "Circle's attestation service is rate limiting us. It blocks all requests " +
          "for five minutes once tripped, so back off rather than retrying.",
        { retryable: true },
      );
    }
    if (!response.ok) {
      throw new MavnaError(`Circle's attestation service returned ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as { messages?: unknown[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.map((raw) => toAttestation(raw));
  }

  /**
   * What a transfer costs, from the live service.
   *
   * Two thresholds exist and only two: 1000 is the fast path and 2000 the
   * standard one. Anything below 1000 is treated as 1000 and anything above as
   * 2000, so there is no point offering a slider.
   */
  async fees(
    sourceDomain: number,
    destinationDomain: number,
  ): Promise<readonly { finalityThreshold: number; minimumFee: number }[]> {
    const response = await fetch(
      `${this.baseUrl}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
    );
    // An unroutable pair comes back as a 400 carrying Circle's own explanation,
    // which is more useful than the status code and is worth surfacing verbatim.
    if (response.status === 400) {
      const detail = await response
        .json()
        .then((b: unknown) => (b as { error?: string }).error)
        .catch(() => undefined);
      throw new MavnaError(
        `Circle does not route from domain ${sourceDomain} to ${destinationDomain}` +
          (detail === undefined ? "." : `: ${detail}`),
        { retryable: false },
      );
    }
    if (!response.ok) {
      throw new MavnaError(`Fee lookup failed with ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new MavnaError(
        `Circle returned an unexpected shape for ${sourceDomain} to ${destinationDomain}.`,
        { retryable: false },
      );
    }
    return body as { finalityThreshold: number; minimumFee: number }[];
  }
}

function toAttestation(raw: unknown): Attestation {
  const row = raw as Record<string, unknown>;
  const decoded = (row.decodedMessage ?? {}) as Record<string, unknown>;
  const body = (decoded.decodedMessageBody ?? {}) as Record<string, unknown>;

  const status = row.status === "complete" ? "complete" : "pending_confirmations";

  return {
    status,
    message: typeof row.message === "string" && row.message !== "0x" ? row.message : undefined,
    attestation:
      typeof row.attestation === "string" && row.attestation !== "PENDING"
        ? row.attestation
        : undefined,
    sourceDomain: Number(decoded.sourceDomain ?? -1),
    destinationDomain: Number(decoded.destinationDomain ?? -1),
    delayReason: (row.delayReason as string | null) ?? null,
    hookData: typeof body.hookData === "string" ? body.hookData : undefined,
    amount: typeof body.amount === "string" && /^\d+$/.test(body.amount) ? body.amount : undefined,
  };
}
