import {
  COMPOSE_RECEIVED,
  composeMessageHash,
  readArrivalConfig,
  readComposeQueue,
} from "@mavna/adapter-layerzero";
import { MavnaError } from "@mavna/core";
import { AccountNotFound, type NetworkConfig, type RpcClient } from "@mavna/stellar";
import {
  Address,
  authorizeEntry,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc as rpc_,
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
 * once. Nothing it is sent can change where the money goes, because the
 * recipient is inside the message the user signed on the source chain and the
 * endpoint checks the message against its own hash.
 *
 * What a message can do is name tokens, and a token is code. Two keys keep that
 * code away from the sponsor's money: the executor that `lz_compose` asks to
 * authorize is a separate key holding only its minimum balance, and the funded
 * key only pays the fee as the transaction's source. The executor signs one
 * authorization, and only after the simulation shows it covers exactly this
 * `lz_compose` and nothing nested under it.
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
  /** Pays the fee as the transaction's source. Operational; never logged. */
  readonly payerSecret: string;
  /**
   * Named as `lz_compose`'s executor and signs only that authorization. A
   * separate key holding only the minimum balance, so nothing a token could
   * make it authorize is worth taking.
   */
  readonly executorSecret: string;
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

/**
 * Refuse unless the simulation asks for exactly one authorization: the
 * executor's, by its own signature, for `lz_compose` on the configured contract
 * with these arguments, and nothing nested under it. A token named in the
 * message can only reach the executor's authority as a sub-invocation, so this
 * is the line it cannot cross.
 */
export function assertOnlyExecutorCompose(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  expected: { readonly executor: string; readonly contract: string; readonly args: xdr.ScVal[] },
): void {
  const refuse = (): never => {
    throw new ComposeRefused(
      "Finishing this conversion would authorize more than the conversion itself, so it is " +
        "refused.",
    );
  };
  if (entries.length !== 1) refuse();
  const entry = entries[0] as xdr.SorobanAuthorizationEntry;
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") refuse();
  if (Address.fromScAddress(credentials.address().address()).toString() !== expected.executor) {
    refuse();
  }
  const root = entry.rootInvocation();
  if (root.subInvocations().length !== 0) refuse();
  const fn = root.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") refuse();
  const call = fn.contractFn();
  if (Address.fromScAddress(call.contractAddress()).toString() !== expected.contract) refuse();
  if (call.functionName().toString() !== "lz_compose") refuse();
  const got = call.args().map((a) => a.toXDR("base64"));
  const want = expected.args.map((a) => a.toXDR("base64"));
  if (got.length !== want.length || got.some((a, i) => a !== want[i])) refuse();
}

export class Composer {
  // # rather than private, so neither secret survives a JSON.stringify
  #payer: Keypair;
  #executor: Keypair;
  private readonly options: Omit<ComposerOptions, "payerSecret" | "executorSecret">;

  constructor(options: ComposerOptions) {
    this.#payer = Keypair.fromSecret(options.payerSecret);
    this.#executor = Keypair.fromSecret(options.executorSecret);
    if (this.#payer.publicKey() === this.#executor.publicKey()) {
      throw new Error(
        "The compose executor must be a separate key from the one that pays, so a token in " +
          "a message can never reach the sponsor's funds.",
      );
    }
    const { payerSecret: _payer, executorSecret: _executor, ...rest } = options;
    this.options = rest;
  }

  /** The executor's address. Safe to log. */
  get executorAddress(): string {
    return this.#executor.publicKey();
  }

  /**
   * The executor must exist on the ledger to sign an authorization. Created on
   * first use with the minimum balance and nothing else.
   */
  private async ensureExecutor(): Promise<void> {
    const { rpc } = this.options;
    try {
      await rpc.loadAccount(this.#executor.publicKey());
      return;
    } catch (cause) {
      if (!(cause instanceof AccountNotFound)) throw cause;
    }
    await rpc.submit("compose executor account", async () => {
      const tx = new TransactionBuilder(await rpc.loadAccount(this.#payer.publicKey()), {
        fee: "1000",
        networkPassphrase: this.options.network.passphrase,
      })
        .addOperation(
          Operation.createAccount({
            destination: this.#executor.publicKey(),
            startingBalance: EXECUTOR_STARTING_XLM,
          }),
        )
        .setTimeout(120)
        .build();
      tx.sign(this.#payer);
      return tx;
    });
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

    await this.ensureExecutor();
    const executor = this.#executor.publicKey();
    const args = [
      new Address(executor).toScVal(),
      new Address(from).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(guid, "hex")),
      nativeToScVal(index, { type: "u32" }),
      xdr.ScVal.scvBytes(Buffer.from(message.slice(2), "hex")),
      xdr.ScVal.scvBytes(Buffer.alloc(0)),
      nativeToScVal(0n, { type: "i128" }),
    ];
    const payer = this.#payer.publicKey();
    const call = (auth: xdr.SorobanAuthorizationEntry[]) =>
      Operation.invokeContractFunction({ contract, function: "lz_compose", args, auth });
    const transaction = async (op: xdr.Operation): Promise<Transaction> =>
      new TransactionBuilder(await rpc.loadAccount(payer), {
        fee: "1000000",
        networkPassphrase: network.passphrase,
      })
        .addOperation(op)
        .setTimeout(120)
        .build();

    const build = async (): Promise<Transaction> => {
      // what the run would ask to be authorized, read before anyone signs anything
      const recording = await transaction(call([]));
      const simulation = await rpc.read("compose simulation", async () => {
        const answer = await rpc.server.simulateTransaction(recording);
        return { value: answer, ledger: answer.latestLedger };
      });
      if (rpc_.Api.isSimulationError(simulation)) {
        throw new MavnaError(`The conversion would fail: ${simulation.error.split("\n")[0]}`, {
          retryable: true,
        });
      }
      const entries = simulation.result?.auth ?? [];
      assertOnlyExecutorCompose(entries, { executor, contract, args });

      const signed = await authorizeEntry(
        entries[0] as xdr.SorobanAuthorizationEntry,
        this.#executor,
        simulation.latestLedger + 60,
        network.passphrase,
      );
      // simulated again with the signed entry in place, so the run is checked
      // against exactly what was authorized and nothing is recorded anew
      const prepared = await rpc.prepare(await transaction(call([signed])));
      const op = prepared.operations[0] as Operation.InvokeHostFunction;
      const auth = op.auth ?? [];
      if (auth.length !== 1 || auth[0]?.toXDR("base64") !== signed.toXDR("base64")) {
        throw new ComposeRefused("The prepared conversion changed what it authorizes; refused.");
      }
      prepared.sign(this.#payer);
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

/** The executor's minimum balance, which is all it ever holds. */
const EXECUTOR_STARTING_XLM = "1";

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
