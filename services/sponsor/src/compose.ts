import {
  COMPOSE_RECEIVED,
  composeMessageHash,
  readArrivalConfig,
  readComposeQueue,
} from "@mavna/adapter-layerzero";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import {
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Finishing a conversion on arrival that LayerZero's executor has not run.
 *
 * Completing a compose is permissionless: the endpoint only lets the Arrival
 * Contract run a message the allowlisted OFT queued, with exactly those bytes,
 * once. So this signs as nobody's agent. The sponsor pays the fee and names
 * itself as the executor, and nothing it is sent can change where the money
 * goes, because the recipient is inside the message the user signed on the
 * source chain and the endpoint checks the message against its own hash.
 */

export type ComposeOutcome =
  | { readonly kind: "composed"; readonly txHash: string; readonly ledger: number }
  /** Run already, by LayerZero's executor or anyone else. A success from the user's side. */
  | { readonly kind: "already-composed" }
  /** The endpoint holds nothing for this message yet; it has not been delivered. */
  | { readonly kind: "not-queued" };

export interface ComposeRequest {
  /** The OFT that queued it. */
  readonly from: string;
  /** 64 hex characters. */
  readonly guid: string;
  readonly index: number;
  /** The queued message, hex. */
  readonly message: string;
}

export interface ComposerOptions {
  readonly rpc: RpcClient;
  readonly network: NetworkConfig;
  /** The Arrival Contract this sponsor finishes for, and no other. */
  readonly contract: string;
  /** Pays and signs as the executor. Operational; never logged. */
  readonly payerSecret: string;
}

/** A refusal caused by the request itself, safe to show the caller. */
export class ComposeRefused extends MavnaError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "ComposeRefused";
  }
}

// a Mavna compose message is a few hundred bytes; anything far past that is not one
const MAX_MESSAGE_BYTES = 4096;
// the endpoint's ComposeNotFound, raised when someone ran it between our read and our write
const COMPOSE_NOT_FOUND = /Error\(Contract, #3\)/;

export class Composer {
  // # rather than private, so the secret never survives a JSON.stringify
  #keypair: Keypair;
  private readonly options: Omit<ComposerOptions, "payerSecret">;

  constructor(options: ComposerOptions) {
    this.#keypair = Keypair.fromSecret(options.payerSecret);
    const { payerSecret: _discarded, ...rest } = options;
    this.options = rest;
  }

  async finish(request: ComposeRequest): Promise<ComposeOutcome> {
    const { from, guid, index, message } = parse(request);
    const { rpc, network, contract } = this.options;

    const config = await readArrivalConfig(rpc, contract);
    if (!config.ofts.some(([oft]) => oft === from)) {
      throw new ComposeRefused("That token is not one the Arrival Contract accepts.");
    }

    const slot = await readComposeQueue(rpc, network.passphrase, {
      endpoint: config.endpoint,
      from,
      to: contract,
      guid,
      index,
    });
    if (slot === undefined) return { kind: "not-queued" };
    if (slot === COMPOSE_RECEIVED) return { kind: "already-composed" };
    if (slot !== composeMessageHash(message)) {
      throw new ComposeRefused("That is not the message waiting for this transfer.");
    }

    const executor = this.#keypair.publicKey();
    const build = async (): Promise<Transaction> => {
      const account = await rpc.loadAccount(executor);
      const unsigned = new TransactionBuilder(account, {
        fee: "1000000",
        networkPassphrase: network.passphrase,
      })
        .addOperation(
          new Contract(contract).call(
            "lz_compose",
            new Address(executor).toScVal(),
            new Address(from).toScVal(),
            xdr.ScVal.scvBytes(Buffer.from(guid, "hex")),
            nativeToScVal(index, { type: "u32" }),
            xdr.ScVal.scvBytes(Buffer.from(message.slice(2), "hex")),
            xdr.ScVal.scvBytes(Buffer.alloc(0)),
            nativeToScVal(0n, { type: "i128" }),
          ),
        )
        .setTimeout(120)
        .build();
      // simulated first: a run that would fail is never paid for
      const prepared = await rpc.prepare(unsigned);
      prepared.sign(this.#keypair);
      return prepared;
    };

    try {
      const result = await rpc.submit("compose finish", build);
      return { kind: "composed", txHash: result.txHash, ledger: result.ledger };
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (COMPOSE_NOT_FOUND.test(text)) return { kind: "already-composed" };
      throw cause instanceof MavnaError
        ? cause
        : new MavnaError(`The conversion could not be finished: ${text}`, { retryable: true });
    }
  }
}

function parse(request: ComposeRequest): {
  from: string;
  guid: string;
  index: number;
  message: `0x${string}`;
} {
  const { from, guid, index, message } = request as Partial<Record<keyof ComposeRequest, unknown>>;
  if (
    typeof from !== "string" ||
    !(StrKey.isValidContract(from) || StrKey.isValidEd25519PublicKey(from))
  ) {
    throw new ComposeRefused("Say which token contract queued the conversion.");
  }
  if (typeof guid !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(guid)) {
    throw new ComposeRefused("Say which LayerZero message to finish.");
  }
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 65_535) {
    throw new ComposeRefused("That is not a compose index.");
  }
  if (
    typeof message !== "string" ||
    !/^(0x)?(?:[0-9a-fA-F]{2})+$/.test(message) ||
    message.replace(/^0x/, "").length > MAX_MESSAGE_BYTES * 2
  ) {
    throw new ComposeRefused("That is not a compose message.");
  }
  return {
    from,
    guid: guid.replace(/^0x/, "").toLowerCase(),
    index,
    message: `0x${message.replace(/^0x/, "").toLowerCase()}`,
  };
}
