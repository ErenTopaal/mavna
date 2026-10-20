import { fromHex } from "@mavna/adapter-cctp";
import {
  COMPOSE_RECEIVED,
  composeMessageHash,
  readArrivalConfig,
  readComposeQueue,
} from "@mavna/adapter-layerzero";
import { type ComposeFinish, MavnaError } from "@mavna/core";
import { readAccountEntry, spareStroops, stroopsToXlm } from "@mavna/stellar";
import {
  Address,
  nativeToScVal,
  Operation,
  rpc as rpcApi,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import type { SponsorCompose } from "./sponsor";

/**
 * Finishing an overdue conversion on arrival from Activity.
 *
 * `lz_compose` is permissionless: the endpoint lets the Arrival Contract run
 * only the exact bytes the OFT queued, once, and the recipient is inside them.
 * With reserves funded by the account (`MAVNA_RESERVE_FUNDING=self`) the
 * sponsor pays for nothing, so the connected Stellar wallet runs it, as both
 * the transaction's source and the compose's executor, paying from its own XLM.
 * Otherwise the sponsor's `/compose` does.
 */
export async function finishCompose(
  engine: Pick<
    Engine,
    "network" | "rpc" | "stellar" | "stellarNetwork" | "arrivalContract" | "sponsorTerms"
  > & { readonly sponsor: Pick<Engine["sponsor"], "requestCompose"> },
  finish: ComposeFinish,
): Promise<FinishAnswer> {
  const terms = await engine.sponsorTerms();
  if (terms.reserveFunding !== "self") return engine.sponsor.requestCompose(finish);
  return composeOwn(engine, finish, await engine.stellar.connect());
}

/**
 * The sponsor's answer, or, when the account runs it itself, the run priced
 * from its simulation and waiting for the user to agree: `finish` asks the
 * wallet to sign exactly the transaction that was priced.
 */
export type FinishAnswer =
  | SponsorCompose
  | {
      readonly kind: "priced";
      /** The most the run can charge, from the prepared transaction. */
      readonly feeStroops: bigint;
      readonly finish: () => Promise<SponsorCompose>;
    };

// the endpoint's ComposeNotFound: someone ran it between our read and our write
const COMPOSE_NOT_FOUND = /Error\(Contract, #3\)/;
// the inclusion bid; simulation adds the resource fee on top
const COMPOSE_INCLUSION_FEE_STROOPS = 100_000;

async function composeOwn(
  engine: Pick<Engine, "rpc" | "stellar" | "stellarNetwork" | "arrivalContract">,
  finish: ComposeFinish,
  payer: string,
): Promise<FinishAnswer> {
  const { rpc, stellarNetwork } = engine;
  const contract = finish.contract;
  if (engine.arrivalContract === undefined || contract !== engine.arrivalContract) {
    throw new MavnaError(
      `${contract} is not the Arrival Contract this app uses, so it will not run it.`,
      { retryable: false },
    );
  }
  const config = await readArrivalConfig(rpc, contract);
  if (!config.ofts.some(([oft]) => oft === finish.from)) {
    throw new MavnaError("That token is not one the Arrival Contract accepts.", {
      retryable: false,
    });
  }
  const message = finish.message as `0x${string}`;
  const slot = await readComposeQueue(rpc, stellarNetwork.passphrase, {
    endpoint: config.endpoint,
    from: finish.from,
    to: contract,
    guid: finish.guid,
    index: finish.index,
  });
  if (slot === undefined) return { kind: "not-queued" };
  if (slot === COMPOSE_RECEIVED) return { kind: "already-composed" };
  if (slot !== composeMessageHash(message)) {
    throw new MavnaError("That is not the message waiting for this transfer.", {
      retryable: false,
    });
  }

  // bytes go through nativeToScVal, which wraps them in the SDK's own Buffer;
  // a browser has no global one
  const args = [
    new Address(payer).toScVal(),
    new Address(finish.from).toScVal(),
    nativeToScVal(fromHex(finish.guid), { type: "bytes" }),
    nativeToScVal(finish.index, { type: "u32" }),
    nativeToScVal(fromHex(message), { type: "bytes" }),
    nativeToScVal(new Uint8Array(0), { type: "bytes" }),
    nativeToScVal(0n, { type: "i128" }),
  ];
  const build = async (auth: xdr.SorobanAuthorizationEntry[]): Promise<Transaction> =>
    new TransactionBuilder(await rpc.loadAccount(payer), {
      fee: String(COMPOSE_INCLUSION_FEE_STROOPS),
      networkPassphrase: stellarNetwork.passphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({ contract, function: "lz_compose", args, auth }),
      )
      .setTimeout(120)
      .build();

  // What the run asks the wallet to authorize, read before it signs anything.
  // A token named in the message is code; anything nested under the compose
  // would be the wallet's authority spent on it, so only the bare compose passes.
  const recording = await build([]);
  const simulation = await rpc.read("compose simulation", async () => {
    const answer = await rpc.server.simulateTransaction(recording);
    return { value: answer, ledger: answer.latestLedger };
  });
  if (rpcApi.Api.isSimulationError(simulation)) {
    if (COMPOSE_NOT_FOUND.test(simulation.error)) return { kind: "already-composed" };
    throw new MavnaError(`The conversion would fail: ${simulation.error.split("\n")[0]}`, {
      retryable: true,
    });
  }
  const entries = simulation.result?.auth ?? [];
  assertOnlyOwnCompose(entries, { payer, contract, args });

  const prepared = await rpc.prepare(await build(entries));
  const op = prepared.operations[0] as Operation.InvokeHostFunction;
  const kept = op.auth ?? [];
  if (kept.length !== 1 || kept[0]?.toXdr("base64") !== entries[0]?.toXdr("base64")) {
    throw new MavnaError(
      "The prepared conversion changed what it authorizes, so it was not signed.",
      {
        retryable: false,
      },
    );
  }
  const entry = await readAccountEntry(rpc, payer);
  const spare = entry === undefined ? 0n : spareStroops(entry, stellarNetwork.baseReserveStroops);
  if (BigInt(prepared.fee) > spare) {
    throw new MavnaError(
      `Running the conversion costs up to ${stroopsToXlm(BigInt(prepared.fee))} XLM, and this ` +
        `account has ${stroopsToXlm(spare > 0n ? spare : 0n)} XLM to spare. Add XLM to it, then ` +
        "finish it again. The funds wait safely in the meantime.",
      { retryable: false },
    );
  }
  return {
    kind: "priced",
    feeStroops: BigInt(prepared.fee),
    finish: async () => {
      const signed = TransactionBuilder.fromXdr(
        await engine.stellar.sign(prepared.toXdr(), payer),
        stellarNetwork.passphrase,
      );
      try {
        const result = await rpc.submit("compose finish", async () => signed as Transaction, {
          presigned: true,
        });
        return { kind: "composed", txHash: result.txHash, ledger: result.ledger };
      } catch (cause) {
        if (cause instanceof Error && COMPOSE_NOT_FOUND.test(cause.message)) {
          return { kind: "already-composed" };
        }
        throw cause;
      }
    },
  };
}

/**
 * Exactly one authorization, the wallet's own as the transaction's source, for
 * `lz_compose` on the configured contract with these arguments, with nothing
 * under it.
 */
function assertOnlyOwnCompose(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  expected: { readonly payer: string; readonly contract: string; readonly args: xdr.ScVal[] },
): void {
  const refuse = (): never => {
    throw new MavnaError(
      "Finishing this conversion would authorize more than the conversion itself, so it was " +
        "not signed.",
      { retryable: false },
    );
  };
  if (entries.length !== 1) refuse();
  const entry = entries[0] as xdr.SorobanAuthorizationEntry;
  const credentials = entry.credentials;
  // the same signature over an address, in either encoding the network records;
  // one that carries delegates hands the authority to others, so it is refused
  const signer =
    credentials.type === "sorobanCredentialsAddress"
      ? credentials.address.address
      : credentials.type === "sorobanCredentialsAddressV2"
        ? credentials.addressV2.address
        : undefined;
  if (signer !== undefined) {
    if (Address.fromScAddress(signer).toString() !== expected.payer) refuse();
  } else if (credentials.type !== "sorobanCredentialsSourceAccount") refuse();
  const root = entry.rootInvocation;
  if (root.subInvocations.length !== 0) refuse();
  const fn = root.function;
  const call = fn.type === "sorobanAuthorizedFunctionTypeContractFn" ? fn.contractFn : refuse();
  if (Address.fromScAddress(call.contractAddress).toString() !== expected.contract) refuse();
  if (call.functionName.toString() !== "lz_compose") refuse();
  const got = call.args.map((a) => a.toXdr("base64"));
  const want = expected.args.map((a) => a.toXdr("base64"));
  if (got.length !== want.length || got.some((a, i) => a !== want[i])) refuse();
}
