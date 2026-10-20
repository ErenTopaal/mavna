/**
 * Talking to the sponsor service, which is the only server in the product.
 *
 * It exists because sponsorship needs a funded signer and a funded signer cannot
 * live in a browser. It builds what the user signs (a preparation, a held
 * settlement), submits what they signed at its own expense, delivers attested
 * Circle transfers, takes its repayment, and finishes overdue conversions on
 * arrival. Nothing here touches user funds.
 *
 * The URL is configuration, so an integrator points this at a sponsor they run
 * with their own keys, and our limits are never silently theirs. `createSponsorClient`
 * binds the base URL once and returns the calls, rather than reading a module-level
 * constant, so a widget an integrator configures reaches their sponsor and not ours.
 */

interface SponsorError {
  readonly error: string;
  readonly retryable: boolean;
  readonly prepareAgain?: boolean;
}

/** A refusal the sponsor answered, with what it said about trying again. */
export class SponsorRefusal extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** The preparation can never land; a new one, signed again, can. */
  readonly prepareAgain: boolean;

  constructor(message: string, status: number, retryable: boolean, prepareAgain: boolean) {
    super(message);
    this.name = "SponsorRefusal";
    this.status = status;
    this.retryable = retryable;
    this.prepareAgain = prepareAgain;
  }
}

export type SponsorDelivery =
  | { kind: "delivered"; txHash: string; ledger: number }
  | { kind: "already-delivered" }
  | { kind: "recipient-not-ready"; detail: string }
  | { kind: "not-attested-yet" };

/** What finishing a conversion on arrival came to. */
export type SponsorCompose =
  | { kind: "composed"; txHash: string; ledger: number }
  | { kind: "already-composed" }
  | { kind: "not-queued" };

export interface SponsorSettle {
  settled: boolean;
  settlementTxHash?: string;
  settlementRetryable?: boolean;
  /** Present, and false, only when the sponsor holds no settlement for the account. */
  held?: false;
}

/**
 * What a sponsor will and will not do, from its /health. Quoting needs both:
 * whether an account that does not exist yet can be served at all, and the
 * smallest Circle transfer the sponsor pays to deliver.
 */
export interface SponsorTerms {
  readonly network: string;
  /**
   * `sponsor`: the sponsor fronts a new account's reserve and is repaid from
   * what arrives. `self`: the account pays its own reserve from its own XLM, so
   * an address that does not exist yet cannot be served.
   */
  readonly reserveFunding: "sponsor" | "self";
  /** In USDC base units at six decimals. Zero means no minimum. */
  readonly minDeliveryBaseUnits: bigint;
}

export interface SponsorClient {
  /**
   * The unsigned preparation, for the user's wallet. Sponsored, it names the
   * sponsor; self-funded, it is the account's own trustline and says so.
   */
  requestPreparation(
    destination: string,
    sourceChainId: string,
    /** The curated name of the trustline to open; USDC unless the account pays for it. */
    asset?: "USDC" | "USDT0",
  ): Promise<{ xdr: string; sponsor?: string; selfFunded?: boolean }>;
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
  /** The sponsor's terms. Rejects when it cannot be reached or read. */
  terms(): Promise<SponsorTerms>;
  /**
   * Run an overdue conversion on arrival. Safe to repeat: the chain runs it
   * once, and every later ask comes back `already-composed`.
   */
  requestCompose(finish: {
    readonly from: string;
    readonly guid: string;
    readonly index: number;
    readonly message: string;
  }): Promise<SponsorCompose>;
  /** Whether a sponsor is reachable at all, for saying so before it matters. */
  sponsorIsUp(): Promise<boolean>;
}

/**
 * How long one call to the sponsor is waited for. /deliver submits a mint and
 * waits for its ledger, which takes seconds; a sponsor silent for a minute is
 * not coming back on this call, and the caller's own retry asks again.
 */
const SPONSOR_PATIENCE_MS = 60_000;

export function createSponsorClient(
  baseUrl: string,
  options: { readonly timeoutMs?: number } = {},
): SponsorClient {
  const patience = options.timeoutMs ?? SPONSOR_PATIENCE_MS;
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
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(patience),
      });
      text = await response.text();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new Error("The sponsor did not answer in time.");
      }
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`The sponsor answered ${response.status}.`);
    }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  function failure(answer: Answer): SponsorRefusal {
    // The server writes its errors for people, so they pass through as said.
    const body = answer.body as Partial<SponsorError> | null;
    return new SponsorRefusal(
      body?.error ?? `The sponsor answered ${answer.status}.`,
      answer.status,
      body?.retryable === true,
      body?.prepareAgain === true,
    );
  }

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const answer = await send(path, body);
    if (!answer.ok) throw failure(answer);
    return answer.body as T;
  }

  return {
    requestPreparation(destination, sourceChainId, asset = "USDC") {
      return post("/prepare", { destination, assets: [asset], sourceChainId });
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
    async requestCompose(finish) {
      const answer = await send("/compose", {
        from: finish.from,
        guid: finish.guid,
        index: finish.index,
        message: finish.message,
      });
      // a 404 with an outcome is "nothing queued yet"; one without is a sponsor
      // that finishes no conversions, which is a failure to say
      if (answer.status === 404 && (answer.body as { kind?: unknown } | null)?.kind) {
        return answer.body as SponsorCompose;
      }
      if (!answer.ok) throw failure(answer);
      return answer.body as SponsorCompose;
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
    async terms() {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`The sponsor answered ${response.status}.`);
      const body = (await response.json()) as {
        network?: unknown;
        reserveFunding?: unknown;
        minDeliveryBaseUnits?: unknown;
      };
      // A sponsor from before these fields fronted every reserve and had no
      // minimum, so their absence says exactly that. A value that is present
      // and unreadable says nothing, and is refused.
      const funding = body.reserveFunding ?? "sponsor";
      if (funding !== "sponsor" && funding !== "self") {
        throw new Error("The sponsor named a reserve funding this page does not know.");
      }
      const minimum = body.minDeliveryBaseUnits ?? "0";
      if (typeof minimum !== "string" || !/^\d+$/.test(minimum)) {
        throw new Error("The sponsor named a minimum delivery this page cannot read.");
      }
      if (typeof body.network !== "string") {
        throw new Error("The sponsor did not say which network it runs on.");
      }
      return {
        network: body.network,
        reserveFunding: funding,
        minDeliveryBaseUnits: BigInt(minimum),
      };
    },
  };
}
