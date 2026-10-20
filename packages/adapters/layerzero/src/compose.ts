import type { ComposeArrival } from "@mavna/core";
import { MavnaError } from "@mavna/core";
import type { RpcClient } from "@mavna/stellar";
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  bytesToHex,
  concatHex,
  encodePacked,
  hexToBytes,
  isHex,
  keccak256,
  numberToHex,
} from "viem";
import { sdkBytes } from "./oft.js";

/**
 * Sending to the Mavna Arrival Contract, and reading what it did.
 *
 * The contract (contracts/arrival) is LayerZero's composer on Stellar. The OFT
 * credits it and queues the compose message on the endpoint; whoever runs
 * `lz_compose` next makes it convert and pass the result on. Everything the
 * contract does is decided by the message the user signs on the source chain,
 * so this file is mostly that message, written and read back.
 */

/** OptionsBuilder.TYPE_3, ExecutorOptions.WORKER_ID and OPTION_TYPE_LZCOMPOSE. */
const OPTIONS_TYPE_3 = 3;
const EXECUTOR_WORKER_ID = 1;
const OPTION_TYPE_LZRECEIVE = 1;
const OPTION_TYPE_LZCOMPOSE = 3;

/** Mavna compose message v1. Kept in step with contracts/arrival/src/codec.rs. */
const MESSAGE_VERSION = 1;
const KIND_ACCOUNT = 0;
const KIND_CONTRACT = 1;

/** The longest path the contract converts along, and the most tokens per hop. */
export const MAX_HOPS = 4;
export const MAX_HOP_TOKENS = 3;

/** What the endpoint leaves in a compose slot once it has been run. */
export const COMPOSE_RECEIVED: `0x${string}` = `0x${"00".repeat(31)}01`;

const hex = (bytes: Uint8Array): `0x${string}` => bytesToHex(bytes);

function addressBytes(address: string): { kind: number; bytes: `0x${string}` } {
  if (StrKey.isValidEd25519PublicKey(address)) {
    return { kind: KIND_ACCOUNT, bytes: hex(StrKey.decodeEd25519PublicKey(address)) };
  }
  if (StrKey.isValidContract(address)) {
    return { kind: KIND_CONTRACT, bytes: hex(StrKey.decodeContract(address)) };
  }
  throw new MavnaError(
    `${address} is neither a Stellar account nor a contract, so the Arrival Contract cannot ` +
      "send to it.",
    { retryable: false },
  );
}

function contractBytes(contract: string): `0x${string}` {
  if (!StrKey.isValidContract(contract)) {
    throw new MavnaError(`${contract} is not a Stellar contract id.`, { retryable: false });
  }
  return hex(StrKey.decodeContract(contract));
}

/**
 * The instructions the Arrival Contract follows, as the user signs them.
 *
 * Layout, big-endian: version u8 | recipient kind u8 | recipient 32 |
 * wanted 32 | min_out i128 | fee_bps u16 | fee recipient kind u8 |
 * fee recipient 32 | hop count u8 | hops (token count u8 | tokens 32 each |
 * pool index 32 | token out 32).
 */
export function encodeArrivalMessage(recipient: string, compose: ComposeArrival): `0x${string}` {
  const to = addressBytes(recipient);
  const minOut = BigInt(compose.minOut);
  if (minOut <= 0n || minOut >= 2n ** 127n) {
    throw new MavnaError("The minimum to receive must be a positive amount.", {
      retryable: false,
    });
  }
  const bps = compose.fee?.bps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new MavnaError(`An integrator fee of ${bps} basis points cannot be carried.`, {
      retryable: false,
    });
  }
  // with no fee the contract never pays the fee recipient, so the recipient
  // stands in rather than an address nobody chose
  const feeTo = addressBytes(compose.fee?.recipient ?? recipient);
  if (compose.path.length === 0 || compose.path.length > MAX_HOPS) {
    throw new MavnaError(`A conversion needs between one and ${MAX_HOPS} pool hops.`, {
      retryable: false,
    });
  }

  const parts: `0x${string}`[] = [
    encodePacked(
      ["uint8", "uint8", "bytes32", "bytes32", "uint128", "uint16", "uint8", "bytes32", "uint8"],
      [
        MESSAGE_VERSION,
        to.kind,
        to.bytes,
        contractBytes(compose.wantedContract),
        minOut,
        bps,
        feeTo.kind,
        feeTo.bytes,
        compose.path.length,
      ],
    ),
  ];
  for (const hop of compose.path) {
    if (
      hop.tokens.length < 2 ||
      hop.tokens.length > MAX_HOP_TOKENS ||
      !/^[0-9a-f]{64}$/.test(hop.poolIndex)
    ) {
      throw new MavnaError("A pool hop in this conversion is not one the venue can run.", {
        retryable: false,
      });
    }
    parts.push(
      numberToHex(hop.tokens.length, { size: 1 }),
      ...hop.tokens.map(contractBytes),
      `0x${hop.poolIndex}`,
      contractBytes(hop.tokenOut),
    );
  }
  return concatHex(parts);
}

/** The recipient named in a Mavna compose message, or undefined if it is not one. */
export function arrivalRecipientOf(composeMsg: string): string | undefined {
  const raw = messageBytes(composeMsg);
  if (raw === undefined || raw.length < 34 || raw[0] !== MESSAGE_VERSION) return undefined;
  const payload = sdkBytes(raw.subarray(2, 34));
  if (raw[1] === KIND_ACCOUNT) return StrKey.encodeEd25519PublicKey(payload);
  if (raw[1] === KIND_CONTRACT) return StrKey.encodeContract(payload);
  return undefined;
}

/** The wanted asset's contract id in a Mavna compose message. */
export function arrivalWantedOf(composeMsg: string): string | undefined {
  const raw = messageBytes(composeMsg);
  if (raw === undefined || raw.length < 66 || raw[0] !== MESSAGE_VERSION) return undefined;
  return StrKey.encodeContract(sdkBytes(raw.subarray(34, 66)));
}

/** A compose message's bytes, or undefined when it is not hex at all. */
function messageBytes(composeMsg: string): Uint8Array | undefined {
  const value = composeMsg.startsWith("0x") ? composeMsg : `0x${composeMsg}`;
  return isHex(value) ? hexToBytes(value) : undefined;
}

/** An OFT message that carries a compose: what the OFT credits and what it queues. */
export interface OftComposePayload {
  readonly sendTo: `0x${string}`;
  readonly amountSd: bigint;
  /** The source-chain sender, which the OFT passes on as `compose_from`. */
  readonly composeFrom: `0x${string}`;
  readonly composeMsg: `0x${string}`;
}

/**
 * The compose half of an OFT message (OFTMsgCodec): recipient 32 | amount u64 |
 * compose from 32 | compose message. Undefined when there is no compose half.
 */
export function decodeOftComposePayload(payload: string): OftComposePayload | undefined {
  const h = payload.replace(/^0x/, "");
  if (h.length <= 144) return undefined;
  return {
    sendTo: `0x${h.slice(0, 64)}`,
    amountSd: BigInt(`0x${h.slice(64, 80)}`),
    composeFrom: `0x${h.slice(80, 144)}`,
    composeMsg: `0x${h.slice(144)}`,
  };
}

/**
 * What the Stellar OFT queues for the composer (oft_compose_msg_codec.rs):
 * nonce u64 | src_eid u32 | amount_ld i128 | compose_from 32 | compose_msg.
 * The amount is sixteen bytes here, not the thirty-two the EVM codec uses.
 */
export function encodeOftComposeMsg(inputs: {
  readonly nonce: bigint;
  readonly srcEid: number;
  readonly amountLd: bigint;
  readonly composeFrom: `0x${string}`;
  readonly composeMsg: `0x${string}`;
}): `0x${string}` {
  return concatHex([
    encodePacked(
      ["uint64", "uint32", "uint128", "bytes32"],
      [inputs.nonce, inputs.srcEid, inputs.amountLd, inputs.composeFrom],
    ),
    inputs.composeMsg,
  ]);
}

/** The executor option that pays for one `lzCompose` call at `index`. */
export function executorLzComposeOption(index: number, gas: bigint): `0x${string}` {
  if (gas <= 0n) {
    throw new MavnaError("An lzCompose option with no gas pays for no conversion.", {
      retryable: false,
    });
  }
  return encodePacked(
    ["uint8", "uint16", "uint8", "uint16", "uint128"],
    [EXECUTOR_WORKER_ID, 19, OPTION_TYPE_LZCOMPOSE, index, gas],
  );
}

/** The executor option types a TYPE_3 options blob carries, in order. */
export function executorOptionTypes(options: string): readonly number[] {
  const h = options.replace(/^0x/, "");
  if (h.length === 0) return [];
  if (h.length < 4 || Number.parseInt(h.slice(0, 4), 16) !== OPTIONS_TYPE_3) {
    throw new MavnaError("These executor options are not in the only format LayerZero accepts.", {
      retryable: false,
    });
  }
  const types: number[] = [];
  let at = 4;
  while (at < h.length) {
    const worker = Number.parseInt(h.slice(at, at + 2), 16);
    const size = Number.parseInt(h.slice(at + 2, at + 6), 16);
    if (Number.isNaN(size) || size < 1 || at + 6 + size * 2 > h.length) {
      throw new MavnaError("These executor options do not decode.", { retryable: false });
    }
    if (worker === EXECUTOR_WORKER_ID) types.push(Number.parseInt(h.slice(at + 6, at + 8), 16));
    at += 6 + size * 2;
  }
  return types;
}

/**
 * The extra options a compose send needs on top of what the OApp enforces for
 * SEND_AND_CALL, or undefined when nothing configured can pay for the compose.
 * USDT0 enforces both lzReceive and lzCompose there, so this is usually `0x`.
 */
export function composeExtraOptions(
  enforced: string,
  gas: { readonly lzReceive: bigint | undefined; readonly lzCompose: bigint | undefined },
): `0x${string}` | undefined {
  const types = executorOptionTypes(enforced);
  const hasReceive = types.includes(OPTION_TYPE_LZRECEIVE);
  if (types.includes(OPTION_TYPE_LZCOMPOSE) && hasReceive) return "0x";
  if (gas.lzCompose === undefined) return undefined;
  const parts: `0x${string}`[] = [encodePacked(["uint16"], [OPTIONS_TYPE_3])];
  if (!hasReceive) {
    if (gas.lzReceive === undefined) return undefined;
    parts.push(
      encodePacked(
        ["uint8", "uint16", "uint8", "uint128"],
        [EXECUTOR_WORKER_ID, 17, OPTION_TYPE_LZRECEIVE, gas.lzReceive],
      ),
    );
  }
  if (!types.includes(OPTION_TYPE_LZCOMPOSE)) parts.push(executorLzComposeOption(0, gas.lzCompose));
  return concatHex(parts);
}

/** What the Arrival Contract was built with. Fixed at deploy; nothing can change it. */
export interface ArrivalConfig {
  readonly endpoint: string;
  readonly router: string;
  readonly ofts: readonly (readonly [oft: string, token: string])[];
  /** What it converts into. */
  readonly wanted: readonly string[];
  /** What else a path may pass through. */
  readonly pathTokens: readonly string[];
}

/**
 * The contract's own configuration, read from its instance storage: one ledger
 * read, no simulation, and nothing the contract could answer differently.
 */
export async function readArrivalConfig(
  rpcClient: RpcClient,
  contract: string,
): Promise<ArrivalConfig> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contract).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const entry = await rpcClient.read(`Arrival Contract ${contract}`, async () => {
    const response = await rpcClient.server.getLedgerEntries(key);
    return { value: response.entries[0], ledger: response.latestLedger };
  });
  if (entry === undefined) {
    throw new MavnaError(`There is no Arrival Contract at ${contract}, or it has been archived.`, {
      retryable: false,
    });
  }
  const storage = entry.val.contractData().val().instance().storage() ?? [];
  for (const item of storage) {
    const name = scValToNative(item.key()) as unknown;
    if (!Array.isArray(name) || name[0] !== "Config") continue;
    const config = scValToNative(item.val()) as {
      endpoint?: unknown;
      router?: unknown;
      ofts?: unknown;
      wanted?: unknown;
      path_tokens?: unknown;
    };
    const strings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      typeof config.endpoint === "string" &&
      typeof config.router === "string" &&
      strings(config.wanted) &&
      strings(config.path_tokens) &&
      Array.isArray(config.ofts) &&
      config.ofts.every(
        (pair: unknown) =>
          Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string",
      )
    ) {
      return {
        endpoint: config.endpoint,
        router: config.router,
        ofts: (config.ofts as [string, string][]).map(([oft, token]) => [oft, token] as const),
        wanted: config.wanted,
        pathTokens: config.path_tokens,
      };
    }
  }
  throw new MavnaError(`The contract at ${contract} does not look like a Mavna Arrival Contract.`, {
    retryable: false,
  });
}

/** Whether the contract accepts compose messages queued by `oft` crediting `token`. */
export function arrivalAccepts(
  config: ArrivalConfig,
  stellar: { readonly oft: string; readonly token: string; readonly endpoint: string },
): boolean {
  return (
    config.endpoint === stellar.endpoint &&
    config.ofts.some(([oft, token]) => oft === stellar.oft && token === stellar.token)
  );
}

/**
 * Whether the contract will convert along this path: the wanted asset and every
 * token a hop touches are on the lists it was built with, and the path is within
 * its caps. Anything else it delivers as it came, so no route is offered for it.
 */
export function arrivalConverts(
  config: ArrivalConfig,
  arriving: string,
  wanted: string,
  path: readonly { readonly tokens: readonly string[]; readonly tokenOut: string }[],
): boolean {
  if (!config.wanted.includes(wanted)) return false;
  if (path.length === 0 || path.length > MAX_HOPS) return false;
  const allowed = (t: string): boolean =>
    t === arriving || config.wanted.includes(t) || config.pathTokens.includes(t);
  return path.every(
    (hop) =>
      hop.tokens.length <= MAX_HOP_TOKENS && allowed(hop.tokenOut) && hop.tokens.every(allowed),
  );
}

/** A read-only contract call, simulated from a throwaway source that never signs. */
export async function simulateRead(
  rpcClient: RpcClient,
  passphrase: string,
  contract: string,
  method: string,
  args: xdr.ScVal[],
): Promise<xdr.ScVal> {
  const source = new Account(Keypair.random().publicKey(), "0");
  const transaction = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await rpcClient.read(`${method} on ${contract}`, async () => {
    const answer = await rpcClient.server.simulateTransaction(transaction);
    return { value: answer, ledger: answer.latestLedger };
  });
  if (rpc.Api.isSimulationError(simulation)) {
    throw new MavnaError(
      `${contract} would not answer ${method}: ${simulation.error.split("\n")[0] ?? "no reason"}`,
      { retryable: true },
    );
  }
  const value = simulation.result?.retval;
  if (value === undefined) {
    throw new MavnaError(`${contract} returned nothing from ${method}.`, { retryable: true });
  }
  return value;
}

/**
 * The endpoint's slot for one compose message: undefined when nothing was
 * queued, `COMPOSE_RECEIVED` once it has run, otherwise the keccak256 of the
 * message still waiting.
 */
export async function readComposeQueue(
  rpcClient: RpcClient,
  passphrase: string,
  slot: {
    readonly endpoint: string;
    readonly from: string;
    readonly to: string;
    readonly guid: string;
    readonly index: number;
  },
): Promise<`0x${string}` | undefined> {
  const value = await simulateRead(rpcClient, passphrase, slot.endpoint, "compose_queue", [
    new Address(slot.from).toScVal(),
    new Address(slot.to).toScVal(),
    guidScVal(slot.guid),
    nativeToScVal(slot.index, { type: "u32" }),
  ]);
  if (value.switch().name === "scvVoid") return undefined;
  if (value.switch().name !== "scvBytes" || value.bytes().length !== 32) {
    throw new MavnaError("The endpoint answered compose_queue in a shape it does not use.", {
      retryable: false,
    });
  }
  return hex(value.bytes());
}

/** A guid as the endpoint and the Arrival Contract key it: 32 raw bytes. */
function guidScVal(guid: string): xdr.ScVal {
  return nativeToScVal(hexToBytes(guid.startsWith("0x") ? (guid as `0x${string}`) : `0x${guid}`), {
    type: "bytes",
  });
}

export function composeMessageHash(message: `0x${string}`): `0x${string}` {
  return keccak256(message);
}

/** The classic asset a Stellar asset contract wraps, as its own `name()` says. */
export async function readTokenName(
  rpcClient: RpcClient,
  passphrase: string,
  token: string,
): Promise<string> {
  const value = scValToNative(await simulateRead(rpcClient, passphrase, token, "name", []));
  if (typeof value !== "string") {
    throw new MavnaError(`The token at ${token} has no readable name.`, { retryable: false });
  }
  return value;
}

/** One `arrival` event, as the contract publishes it (contracts/arrival/src/events.rs). */
export interface ArrivalEvent {
  readonly txHash: string;
  readonly ledger: number;
  readonly closedAtUnix: number;
  readonly outcome: "converted" | "as_came";
  readonly recipient: string;
  /** The token contract the recipient was sent, and how much. */
  readonly asset: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly arrivedToken: string;
  readonly arrivedAmount: bigint;
  readonly unconverted: bigint;
}

/** RPC scans this many ledgers per getEvents call, whatever the limit says. */
const EVENT_SCAN_PAGES = 14;

/**
 * Find the contract's event for one message, from `fromLedger` forward.
 *
 * Proof of arrival comes from here and never from a balance: the event is
 * published by the contract in the same execution that moved the funds, keyed
 * by the message's guid, and nothing else can publish under its id.
 */
export async function findArrivalEvent(
  rpcClient: RpcClient,
  contract: string,
  guid: string,
  fromLedger: number | undefined,
): Promise<ArrivalEvent | undefined> {
  const health = await rpcClient.server.getHealth();
  let startLedger = Math.max(fromLedger ?? health.oldestLedger, health.oldestLedger);
  const topics = [
    [nativeToScVal("arrival", { type: "symbol" }).toXDR("base64"), guidScVal(guid).toXDR("base64")],
  ];
  let cursor: string | undefined;
  for (let page = 0; page < EVENT_SCAN_PAGES; page++) {
    const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [contract], topics }];
    const response =
      cursor === undefined
        ? await rpcClient.server.getEvents({ startLedger, filters, limit: 10 })
        : await rpcClient.server.getEvents({ cursor, filters, limit: 10 });
    const found = response.events[0];
    if (found !== undefined) return parseArrivalEvent(found);
    if (response.cursor === undefined || response.cursor === cursor) return undefined;
    // the cursor's high 32 bits are the ledger the scan reached
    const reached = Number(BigInt(response.cursor.split("-")[0] ?? "0") >> 32n);
    if (reached >= response.latestLedger) return undefined;
    cursor = response.cursor;
    startLedger = reached;
  }
  return undefined;
}

function parseArrivalEvent(event: rpc.Api.EventResponse): ArrivalEvent {
  const data = scValToNative(event.value) as Record<string, unknown>;
  const text = (k: string): string => {
    const v = data[k];
    if (typeof v !== "string") {
      throw new MavnaError(`The Arrival Contract's event has no readable ${k}.`, {
        retryable: false,
      });
    }
    return v;
  };
  const amount = (k: string): bigint => {
    const v = data[k];
    if (typeof v !== "bigint") {
      throw new MavnaError(`The Arrival Contract's event has no readable ${k}.`, {
        retryable: false,
      });
    }
    return v;
  };
  const outcome = text("outcome");
  if (outcome !== "converted" && outcome !== "as_came") {
    throw new MavnaError(`The Arrival Contract reported an outcome this app does not know.`, {
      retryable: false,
    });
  }
  return {
    txHash: event.txHash,
    ledger: event.ledger,
    closedAtUnix: Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000),
    outcome,
    recipient: text("recipient"),
    asset: text("asset"),
    amount: amount("amount"),
    fee: amount("fee"),
    arrivedToken: text("arrived_token"),
    arrivedAmount: amount("arrived_amount"),
    unconverted: amount("unconverted"),
  };
}

/**
 * The contract's own TTL policy (contracts/arrival lib.rs): every arrival
 * renews its instance and code to 30 days once either has less than 15 left.
 */
export const ARRIVAL_TTL_THRESHOLD: number = 17_280 * 15;
export const ARRIVAL_TTL_EXTEND_TO: number = 17_280 * 30;

/**
 * What the next `lz_compose` would pay in rent to renew the contract's storage,
 * in stroops: nothing while both the instance and its code have at least half
 * their 30 days left, otherwise the simulated cost of renewing what has less.
 *
 * This is almost all of what a finish can cost. A run that renews the wasm
 * code entry paid 30.7 XLM on testnet, nearly all of it rent, while runs in
 * between paid a few hundredths of an XLM.
 */
export async function estimateFinishRent(
  rpcClient: RpcClient,
  passphrase: string,
  contract: string,
): Promise<bigint> {
  const instance = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contract).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const read = (key: xdr.LedgerKey, label: string) =>
    rpcClient.read(label, async () => {
      const response = await rpcClient.server.getLedgerEntries(key);
      return {
        value: { entry: response.entries[0], latest: response.latestLedger },
        ledger: response.latestLedger,
      };
    });
  const held = await read(instance, `Arrival Contract ${contract}`);
  if (held.entry === undefined) {
    throw new MavnaError(`There is no Arrival Contract at ${contract}, or it has been archived.`, {
      retryable: false,
    });
  }
  const code = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: held.entry.val.contractData().val().instance().executable().wasmHash(),
    }),
  );
  const codeHeld = await read(code, `Arrival Contract code ${contract}`);
  const due = [
    [instance, held.entry.liveUntilLedgerSeq, held.latest],
    [code, codeHeld.entry?.liveUntilLedgerSeq, codeHeld.latest],
  ]
    .filter(
      ([, until, latest]) =>
        (until as number | undefined) === undefined ||
        (until as number) - (latest as number) < ARRIVAL_TTL_THRESHOLD,
    )
    .map(([key]) => key as xdr.LedgerKey);
  if (due.length === 0) return 0n;

  const renewal = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.extendFootprintTtl({ extendTo: ARRIVAL_TTL_EXTEND_TO }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(due).build())
    .setTimeout(30)
    .build();
  const simulation = await rpcClient.read("renewal simulation", async () => {
    const answer = await rpcClient.server.simulateTransaction(renewal);
    return { value: answer, ledger: answer.latestLedger };
  });
  if (rpc.Api.isSimulationError(simulation)) {
    throw new MavnaError(
      `The contract's storage renewal could not be priced: ${simulation.error.split("\n")[0] ?? ""}`,
      { retryable: true },
    );
  }
  return BigInt(simulation.minResourceFee);
}
