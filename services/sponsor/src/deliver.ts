import { deliveryFailureOf } from "@mavna/adapter-cctp";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import { Keypair, type Transaction } from "@stellar/stellar-sdk";

/**
 * Performing the last mile of a CCTP transfer.
 *
 * Circle runs an off-chain forwarding service that does this step on every other
 * chain, and it does not serve Stellar. It structurally cannot: it refuses to
 * forward whenever `destinationCaller` is set, and Stellar requires it set. So
 * the mint has to be triggered and paid for by somebody, and that somebody is us.
 *
 * This lives in the sponsor service because it is the one place in the repository
 * permitted to hold a key. Nothing here signs a user's transfer: it signs a
 * delivery whose recipient is fixed inside Circle's attested message and cannot
 * be altered by anyone, including us. That is worth stating because "the service
 * submits a transaction that moves the user's money" is a sentence that should
 * make a reviewer stop, and the reason it is safe is the attestation, not trust.
 */

/** What a delivery attempt learned. Every outcome is named rather than thrown. */
export type DeliveryOutcome =
  | { readonly kind: "delivered"; readonly txHash: string; readonly ledger: number }
  | { readonly kind: "already-delivered" }
  | {
      /**
       * The recipient cannot hold USDC yet. Circle's contract reverts the whole
       * invocation including its own replay record, so the message stays
       * deliverable and this is a wait rather than a loss.
       */
      readonly kind: "recipient-not-ready";
      readonly detail: string;
    }
  | { readonly kind: "not-attested-yet" };

export interface DeliveryRequest {
  /** Raw CCTP message bytes as hex, from Circle's attestation service. */
  readonly messageHex: string;
  /** Circle's signature over that message, hex. `PENDING` until it is ready. */
  readonly attestationHex: string;
}

export interface DelivererOptions {
  readonly rpc: RpcClient;
  readonly network: NetworkConfig;
  readonly networkId: "testnet" | "mainnet";
  /**
   * The account that submits and pays, as a secret key.
   *
   * An operational secret: not in the repository, not in any client bundle, not
   * in a log line. It is read from the environment by the caller and handed over
   * here rather than being reached for globally, so a reader can see every place
   * it reaches.
   */
  readonly payerSecret: string;
  /**
   * Builds the unsigned delivery. Injected rather than imported so this service
   * carries no dependency on any particular rail: a second rail that needs a
   * paid final step supplies its own builder.
   */
  readonly buildDelivery: (inputs: {
    readonly network: NetworkConfig;
    readonly networkId: "testnet" | "mainnet";
    readonly payerAccount: Awaited<ReturnType<RpcClient["loadAccount"]>>;
    readonly messageHex: string;
    readonly attestationHex: string;
  }) => import("@stellar/stellar-sdk").Transaction;
}

/** Circle marks an unfinished attestation with this rather than omitting it. */
const NOT_YET_SIGNED = "PENDING";

export class Deliverer {
  /**
   * A genuinely private field, and the `#` is load-bearing rather than stylistic.
   *
   * A `private` property is only private to the type checker. It survives
   * `JSON.stringify`, which means it reaches any log line, error report or
   * telemetry payload that ever serialises this object. A test caught exactly
   * that leak here. `#` fields are invisible to serialisation, so the secret
   * cannot escape by accident.
   */
  #keypair: Keypair;
  /** Everything except the secret, which is deliberately not kept. */
  private readonly options: Omit<DelivererOptions, "payerSecret">;

  constructor(options: DelivererOptions) {
    // Fail at construction rather than at the moment a user's funds are waiting.
    this.#keypair = Keypair.fromSecret(options.payerSecret);
    const { payerSecret: _discarded, ...rest } = options;
    this.options = rest;
  }

  /** The public key that pays. Safe to log; the secret never is. */
  get payerAddress(): string {
    return this.#keypair.publicKey();
  }

  /**
   * Deliver one attested message.
   *
   * Idempotent by construction, because Circle's transmitter records a used
   * nonce: a second attempt on a delivered message fails rather than minting
   * twice. That is the property that makes retrying safe, and retrying has to be
   * safe here because the alternative to retrying is a stuck transfer.
   */
  async deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
    if (request.attestationHex === NOT_YET_SIGNED || request.attestationHex.length === 0) {
      return { kind: "not-attested-yet" };
    }

    // Built from the payer's sequence as it is now, and simulated before it is
    // signed. A transaction that will fail should never be submitted, and the
    // simulation is also where a not-ready recipient announces itself, before
    // any fee is spent.
    const build = async (): Promise<Transaction> => {
      const payerAccount = await this.options.rpc.loadAccount(this.#keypair.publicKey());
      const unsigned = this.options.buildDelivery({
        network: this.options.network,
        networkId: this.options.networkId,
        payerAccount,
        messageHex: request.messageHex,
        attestationHex: request.attestationHex,
      });
      return this.options.rpc.prepare(unsigned);
    };

    let prepared: Transaction | undefined;
    try {
      prepared = await build();
    } catch (cause) {
      return classify(cause);
    }

    try {
      // Every other transaction the payer signs moves the same sequence, so a
      // retry after a stale sequence is built and simulated again from a fresh
      // read. Resending the first envelope could only be refused the same way.
      const result = await this.options.rpc.submit("cctp delivery", async () => {
        const next = prepared ?? (await build());
        prepared = undefined;
        next.sign(this.#keypair);
        return next;
      });
      return { kind: "delivered", txHash: result.txHash, ledger: result.ledger };
    } catch (cause) {
      return classify(cause);
    }
  }
}

/**
 * Turn a failure into a named outcome.
 *
 * The distinction that matters is "this cannot be delivered yet" against "this
 * went wrong". Collapsing them is how a user who simply needs a trustline gets
 * told their transfer failed, and a user told their transfer failed retries,
 * which is how one payment becomes two.
 */
function classify(cause: unknown): DeliveryOutcome {
  const text = cause instanceof Error ? `${cause.message}` : String(cause);

  // Telling "not ready" from "failed" is what keeps a user who only needs a
  // trustline from being told their transfer failed and paying twice.
  const failure = deliveryFailureOf(text);
  if (failure === "recipient-not-ready") {
    return {
      kind: "recipient-not-ready",
      detail:
        "The recipient cannot hold USDC yet. Nothing was consumed and the funds " +
        "are still deliverable once their account is ready.",
    };
  }
  if (failure === "already-delivered") return { kind: "already-delivered" };

  throw cause instanceof MavnaError
    ? cause
    : new MavnaError(`The delivery could not be submitted: ${text}`, { retryable: true });
}
