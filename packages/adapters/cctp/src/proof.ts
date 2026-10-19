import { MavnaError, type NetworkId } from "@mavna/core";
import { type RpcClient, underlyingAccountOfMuxed, xlmToStroops } from "@mavna/stellar";
import { Address, nativeToScVal, type rpc, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CCTP_CONTRACTS } from "./config.js";
import { fromHex } from "./hook.js";

/**
 * Proof that Circle's forwarder delivered one particular CCTP message on Stellar.
 *
 * Read from the delivery itself, never from the recipient's balance: a balance
 * cannot tell this transfer's arrival from money that was already there.
 *
 * What a `mint_and_forward` emits, read off a real testnet delivery: the
 * forwarder's own event carries only amount, recipient and token, nothing tying
 * it to a message. In the same operation the message transmitter emits
 * `message_received` with the caller and the message nonce as topics and the
 * source domain in its data. That event names the message, and the forwarder's
 * event beside it says what was forwarded and to whom.
 */

/** The fields of a CCTP v2 message header that identify it on the receiving side. */
export interface MessageIdentity {
  readonly nonce: Uint8Array;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
}

export interface Delivery {
  readonly txHash: string;
  readonly ledger: number;
  /** In Stellar's seven decimals, as the forwarder moved it. */
  readonly amount: bigint;
  readonly recipient: string;
}

/** A Horizon operation record, as much of it as the proof reads. */
export interface HorizonOperation {
  readonly id: string;
  readonly type: string;
  readonly transaction_hash: string;
  readonly transaction_successful?: boolean;
  readonly parameters?: readonly { readonly type: string; readonly value: string }[];
  readonly asset_balance_changes?:
    | readonly {
        readonly type?: string;
        readonly from?: string;
        readonly to?: string;
        readonly asset_code?: string;
        readonly asset_issuer?: string;
        readonly amount?: string;
      }[]
    | null;
}

// version (4), source domain (4), destination domain (4), nonce (32)
const NONCE_OFFSET = 12;
const NONCE_END = 44;

export function identifyMessage(messageHex: string): MessageIdentity {
  const bytes = fromHex(messageHex);
  if (bytes.length < NONCE_END) {
    throw new MavnaError(
      `A CCTP message is at least ${NONCE_END} bytes; this is ${bytes.length}.`,
      {
        retryable: false,
      },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    nonce: bytes.slice(NONCE_OFFSET, NONCE_END),
    sourceDomain: view.getUint32(4, false),
    destinationDomain: view.getUint32(8, false),
  };
}

/**
 * The delivery of this message among a set of RPC events, if it is there.
 *
 * Needs both events from the same operation: the transmitter's receipt, called
 * by the forwarder, naming this nonce and source domain; and the forwarder's
 * `mint_and_forward` of USDC beside it. The receipt alone would prove a mint to
 * the forwarder, not that anything reached the recipient.
 */
export function deliveredByEvent(
  events: readonly rpc.Api.EventResponse[],
  message: MessageIdentity,
  network: NetworkId,
): Delivery | undefined {
  const { messageTransmitter, cctpForwarder, usdcContract } = CCTP_CONTRACTS[network];

  const receipt = events.find(
    (event) =>
      event.inSuccessfulContractCall &&
      event.contractId?.contractId() === messageTransmitter &&
      isReceiptOf(event, message, cctpForwarder),
  );
  if (receipt === undefined) return undefined;

  for (const event of events) {
    if (
      !event.inSuccessfulContractCall ||
      event.txHash !== receipt.txHash ||
      event.operationIndex !== receipt.operationIndex ||
      event.contractId?.contractId() !== cctpForwarder ||
      symbolOf(event.topic[0]) !== "mint_and_forward"
    ) {
      continue;
    }
    const data = scValToNative(event.value) as Record<string, unknown>;
    if (
      data.token !== usdcContract ||
      typeof data.amount !== "bigint" ||
      typeof data.forward_recipient !== "string"
    ) {
      continue;
    }
    return {
      txHash: event.txHash,
      ledger: event.ledger,
      amount: data.amount,
      recipient: data.forward_recipient,
    };
  }
  return undefined;
}

/**
 * The delivery of this message among an account's Horizon operations, for when
 * it is older than RPC keeps events.
 *
 * Matches the forwarder call whose message argument is these exact bytes, and
 * reads the amount from the USDC the forwarder moved in that operation.
 */
export function deliveredByOperation(
  operations: readonly HorizonOperation[],
  messageHex: string,
  network: NetworkId,
): Delivery | undefined {
  const wanted = fromHex(messageHex);
  for (const operation of operations) {
    const call = forwarderCall(operation, network);
    if (call !== undefined && sameBytes(call.message, wanted)) return call.delivery;
  }
  return undefined;
}

/**
 * The most recent forwarder delivery to this account among its operations.
 *
 * Only ever informational. Without the message there is no telling which
 * transfer it was, so it must not be read as the delivery of any particular one.
 */
export function latestDeliveryTo(
  operations: readonly HorizonOperation[],
  account: string,
  network: NetworkId,
): Delivery | undefined {
  for (const operation of operations) {
    const call = forwarderCall(operation, network);
    // The account's history also lists deliveries it paid for on someone
    // else's behalf, which are not arrivals.
    if (call !== undefined && call.delivery.recipient === account) return call.delivery;
  }
  return undefined;
}

/**
 * The classic account whose Horizon history shows a delivery to this address.
 * Undefined for a contract, which Horizon does not keep an account history for.
 */
export function horizonAccountFor(address: string): string | undefined {
  if (StrKey.isValidEd25519PublicKey(address)) return address;
  if (StrKey.isValidMed25519PublicKey(address)) return underlyingAccountOfMuxed(address);
  return undefined;
}

export interface DeliveryProofOptions {
  readonly rpc: RpcClient;
  readonly horizonUrl: string;
  readonly network: NetworkId;
}

/** RPC returns a page per window of ledgers scanned; retention is about twelve. */
const MAX_EVENT_PAGES = 64;
/** The forwarder's events in a single ledger. Far more than any ledger has held. */
const FORWARDS_PER_LEDGER = 200;
/**
 * The load-balanced nodes disagree slightly about their oldest ledger, and asking
 * one for a ledger it has already dropped is an error. A minute inside it avoids
 * that, and Horizon covers everything before the start.
 */
const RETENTION_MARGIN = 12;
const HORIZON_PAGE = 200;
/**
 * How far back through an account's older history to look. Deliveries are
 * usually recent and most accounts have far fewer operations than this; one that
 * has more and an older delivery reads as pending, never as done.
 */
const MAX_HORIZON_PAGES = 10;

export class DeliveryProof {
  private readonly rpc: RpcClient;
  private readonly horizonUrl: string;
  private readonly network: NetworkId;

  constructor(options: DeliveryProofOptions) {
    this.rpc = options.rpc;
    this.horizonUrl = options.horizonUrl;
    this.network = options.network;
  }

  /**
   * Where and how much this message delivered, or undefined if no delivery can
   * be found.
   *
   * Circle's attestation carries no timestamp, so there is no ledger to start
   * from: RPC is searched across its whole retention window, and Horizon, keyed
   * on the recipient, covers whatever is older.
   */
  async find(messageHex: string, recipient: string | undefined): Promise<Delivery | undefined> {
    const message = identifyMessage(messageHex);
    const health = await this.rpc.server.getHealth();
    const start = health.oldestLedger + RETENTION_MARGIN;

    const recent = await this.searchEvents(message, start);
    if (recent !== undefined) return recent;

    const account = recipient === undefined ? undefined : horizonAccountFor(recipient);
    if (account === undefined) return undefined;
    return this.searchHorizon(messageHex, account, start);
  }

  private async searchEvents(
    message: MessageIdentity,
    startLedger: number,
  ): Promise<Delivery | undefined> {
    const { messageTransmitter, cctpForwarder } = CCTP_CONTRACTS[this.network];
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [messageTransmitter],
        topics: [
          [
            xdr.ScVal.scvSymbol("message_received").toXDR("base64"),
            new Address(cctpForwarder).toScVal().toXDR("base64"),
            nativeToScVal(message.nonce).toXDR("base64"),
            "*",
          ],
        ],
      },
    ];

    let request: rpc.Api.GetEventsRequest = { startLedger, filters, limit: 10 };
    let scannedTo = startLedger - 1;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const response = await this.events(request);
      const receipt = response.events.find((event) => isReceiptOf(event, message, cctpForwarder));
      if (receipt !== undefined) return this.forwardedWith(receipt, message);

      // The cursor is a TOID, whose high 32 bits are the ledger the scan reached.
      const reached = Number(BigInt(response.cursor.split("-")[0] ?? "0") >> 32n);
      if (reached >= response.latestLedger) return undefined;
      if (reached <= scannedTo) {
        throw new MavnaError(`Stellar RPC stopped advancing through events at ledger ${reached}.`, {
          retryable: true,
        });
      }
      scannedTo = reached;
      request = { cursor: response.cursor, filters, limit: 10 };
    }
    throw new MavnaError(
      `Stellar RPC needed more than ${MAX_EVENT_PAGES} pages to cover its retention window.`,
      { retryable: true },
    );
  }

  /** The forwarder's event in the receipt's ledger, which the proof needs beside it. */
  private async forwardedWith(
    receipt: rpc.Api.EventResponse,
    message: MessageIdentity,
  ): Promise<Delivery> {
    const { cctpForwarder } = CCTP_CONTRACTS[this.network];
    const response = await this.events({
      startLedger: receipt.ledger,
      endLedger: receipt.ledger + 1,
      filters: [
        {
          type: "contract",
          contractIds: [cctpForwarder],
          topics: [[xdr.ScVal.scvSymbol("mint_and_forward").toXDR("base64")]],
        },
      ],
      limit: FORWARDS_PER_LEDGER,
    });

    const delivery = deliveredByEvent([receipt, ...response.events], message, this.network);
    if (delivery === undefined) {
      // The transmitter recorded the message as received by the forwarder, so
      // the forward happened in that same call. Not finding it means this code
      // or the contract's events have changed, and pending would hide that.
      throw new MavnaError(
        `The message was received in ${receipt.txHash}, but the forwarder's event ` +
          "for it could not be found.",
        { retryable: false },
      );
    }
    return delivery;
  }

  private events(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.rpc.read("forwarder events", async () => {
      const response = await this.rpc.server.getEvents(request);
      return { value: response, ledger: response.latestLedger };
    });
  }

  private async searchHorizon(
    messageHex: string,
    account: string,
    beforeLedger: number,
  ): Promise<Delivery | undefined> {
    // Descending from a paging token at the start of RPC's window: exactly the
    // history RPC could not show.
    let url: string | undefined =
      `${this.horizonUrl}/accounts/${account}/operations?order=desc&limit=${HORIZON_PAGE}` +
      `&cursor=${BigInt(beforeLedger) << 32n}`;

    for (let page = 0; page < MAX_HORIZON_PAGES && url !== undefined; page++) {
      const body = await horizonOperations(url);
      if (body === undefined) return undefined;
      const records = body._embedded?.records ?? [];
      const delivery = deliveredByOperation(records, messageHex, this.network);
      if (delivery !== undefined) return delivery;
      if (records.length < HORIZON_PAGE) return undefined;
      url = body._links?.next?.href;
    }
    return undefined;
  }
}

export interface HorizonOperationsPage {
  readonly _embedded?: { readonly records?: readonly HorizonOperation[] };
  readonly _links?: { readonly next?: { readonly href?: string } };
}

/** One page of an account's operations, or undefined when the account does not exist. */
export async function horizonOperations(url: string): Promise<HorizonOperationsPage | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new MavnaError(`Horizon returned ${response.status} for the account's operations.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  return (await response.json()) as HorizonOperationsPage;
}

function isReceiptOf(
  event: rpc.Api.EventResponse,
  message: MessageIdentity,
  forwarder: string,
): boolean {
  const [name, caller, nonce] = event.topic;
  if (symbolOf(name) !== "message_received" || caller === undefined || nonce === undefined) {
    return false;
  }
  if (scValToNative(caller) !== forwarder) return false;
  const received = scValToNative(nonce);
  if (!(received instanceof Uint8Array) || !sameBytes(received, message.nonce)) return false;
  const data = scValToNative(event.value) as Record<string, unknown>;
  return data.source_domain === message.sourceDomain;
}

/** A successful `mint_and_forward` on Circle's forwarder, with its message and what it moved. */
function forwarderCall(
  operation: HorizonOperation,
  network: NetworkId,
): { readonly message: Uint8Array; readonly delivery: Delivery } | undefined {
  const { cctpForwarder, usdcIssuer } = CCTP_CONTRACTS[network];
  if (operation.type !== "invoke_host_function" || operation.transaction_successful !== true) {
    return undefined;
  }
  const [contract, fn, message] = (operation.parameters ?? []).map((p) =>
    scValToNative(xdr.ScVal.fromXDR(p.value, "base64")),
  );
  if (contract !== cctpForwarder || fn !== "mint_and_forward" || !(message instanceof Uint8Array)) {
    return undefined;
  }

  const forwarded = (operation.asset_balance_changes ?? []).find(
    (change) =>
      change.type === "transfer" &&
      change.from === cctpForwarder &&
      change.asset_code === "USDC" &&
      change.asset_issuer === usdcIssuer,
  );
  if (forwarded?.to === undefined || forwarded.amount === undefined) return undefined;

  return {
    message,
    delivery: {
      txHash: operation.transaction_hash,
      // Horizon ids are TOIDs, with the ledger in the high 32 bits.
      ledger: Number(BigInt(operation.id) >> 32n),
      // Horizon prints every asset in seven decimals, so the XLM parser is exact here.
      amount: xlmToStroops(forwarded.amount),
      recipient: forwarded.to,
    },
  };
}

function symbolOf(value: xdr.ScVal | undefined): string | undefined {
  return value?.switch().name === "scvSymbol" ? value.sym().toString() : undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
