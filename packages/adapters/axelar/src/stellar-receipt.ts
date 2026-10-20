import { MavnaError } from "@mavna/core";
import type { RpcClient } from "@mavna/stellar";
import { rpc, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { requestJson } from "./http.js";

/**
 * What a hub-to-Stellar message delivered, read from the Stellar transaction
 * that executed it.
 *
 * Axelar's record of that leg is only used to find the transaction. Its own
 * amount and decimals are not dependable: on mainnet the WETH leg carries no
 * amount at all, and the BCB leg says six decimals for a token with seven. The
 * transaction is what moved the money, so it is what is read:
 *
 *   - the gateway's `message_executed`, naming this message id and the token
 *     service, so the transaction is the one that carried this message;
 *   - the token service's `interchain_transfer_received`, naming the token id,
 *     the recipient and the amount, in the token's own units on Stellar;
 *   - the token's own `mint` or `transfer` to that recipient for that amount,
 *     so the token contract agrees with the service about what it paid out.
 *
 * Anything missing or disagreeing is an error, never a done.
 */

export interface StellarReceipt {
  /** Lower-case hex, no prefix, as the token service emits it. */
  readonly tokenId: string;
  readonly recipient: string;
  readonly amount: bigint;
}

interface DecodedEvent {
  readonly contract: string;
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

export async function readStellarReceipt(params: {
  readonly client: RpcClient;
  readonly txHash: string;
  /** The ledger Axelar says it landed in, when it says. */
  readonly ledger: number | undefined;
  /** When Axelar says it landed, in unix seconds, when it says. */
  readonly atUnix: number | undefined;
  readonly gateway: string;
  readonly tokenService: string;
  readonly messageId: string;
}): Promise<StellarReceipt & { readonly events: readonly DecodedEvent[] }> {
  let tx: rpc.Api.GetTransactionResponse;
  try {
    tx = await params.client.server.getTransaction(params.txHash);
  } catch (cause) {
    if (cause instanceof MavnaError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MavnaError(`Stellar RPC could not be reached: ${detail}`, { retryable: true, cause });
  }

  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    // Older than what the node keeps is a permanent gap; anything newer is a
    // node that has not caught up yet.
    const aged =
      (params.ledger !== undefined && params.ledger < tx.oldestLedger) ||
      (params.atUnix !== undefined && params.atUnix < Number(tx.oldestLedgerCloseTime));
    if (aged) throw new ReceiptAged();
    throw new MavnaError(
      "Axelar reports this transfer delivered, and Stellar has not shown the transaction " +
        "yet. Checking again shortly.",
      { retryable: true },
    );
  }
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new MavnaError(
      `The Stellar transaction Axelar names for this delivery did not succeed (${tx.status}).`,
      { retryable: false },
    );
  }

  const events = (tx.events?.contractEventsXdr ?? []).flat().map(decode);

  const executed = events.some((event) => {
    if (event.contract !== params.gateway || event.topics[0] !== "message_executed") return false;
    const message = event.topics[1] as { message_id?: unknown; contract_address?: unknown };
    return (
      message?.message_id === params.messageId && message?.contract_address === params.tokenService
    );
  });
  if (!executed) {
    throw new MavnaError(
      "The Stellar transaction Axelar names did not execute this message, so it is not " +
        "evidence that this transfer arrived.",
      { retryable: false },
    );
  }

  const received = events.filter(
    (event) =>
      event.contract === params.tokenService && event.topics[0] === "interchain_transfer_received",
  );
  if (received.length !== 1) {
    throw new MavnaError(
      `The delivery transaction carries ${received.length} token receipts where one was ` +
        "expected, so what arrived for this transfer cannot be told apart.",
      { retryable: false },
    );
  }
  const [, , tokenId, , recipient, amount] = received[0]?.topics ?? [];
  if (
    !(tokenId instanceof Uint8Array) ||
    typeof recipient !== "string" ||
    typeof amount !== "bigint" ||
    amount <= 0n
  ) {
    throw new MavnaError("The token service's receipt on Stellar is not in the shape expected.", {
      retryable: false,
    });
  }

  return { tokenId: hex(tokenId), recipient, amount, events };
}

/**
 * Whether the token contract itself paid this recipient this amount in the
 * delivery: a mint (a token the service deployed) or a transfer out of its
 * token manager (a token linked to an existing Stellar asset).
 */
export function tokenPaid(
  events: readonly DecodedEvent[],
  token: string,
  recipient: string,
  amount: bigint,
): boolean {
  return events.some((event) => {
    if (event.contract !== token) return false;
    const [name] = event.topics;
    const to =
      name === "mint" ? event.topics[1] : name === "transfer" ? event.topics[2] : undefined;
    if (to !== recipient) return false;
    const paid =
      typeof event.data === "bigint"
        ? event.data
        : (event.data as { amount?: unknown } | null)?.amount;
    return paid === amount;
  });
}

function decode(event: xdr.ContractEvent): DecodedEvent {
  const id = event.contractId?.value;
  const body = event.body.v0;
  return {
    contract: id === undefined ? "" : StrKey.encodeContract(id),
    topics: body.topics.map((topic) => scValToNative(topic)),
    data: scValToNative(body.data),
  };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * The Stellar node no longer keeps the delivery transaction. Public RPC keeps
 * days of history, so every delivery reaches this eventually; Horizon, which
 * keeps it all, is asked instead.
 */
export class ReceiptAged extends MavnaError {
  constructor() {
    super(
      "Axelar reports this transfer delivered, and the Stellar node no longer keeps the " +
        "transaction that delivered it.",
      { retryable: false },
    );
    this.name = "ReceiptAged";
  }
}

/** One entry of Horizon's `asset_balance_changes`, as it answers. */
export interface HorizonBalanceChange {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly type: string;
  readonly from?: string;
  readonly to?: string;
  readonly amount: string;
}

interface HorizonOperation {
  readonly type: string;
  readonly transaction_successful: boolean;
  readonly parameters?: readonly { readonly value: string; readonly type: string }[];
  readonly asset_balance_changes?: readonly HorizonBalanceChange[] | null;
}

/**
 * The same delivery read from Horizon, which keeps every transaction but no
 * contract events.
 *
 * What Horizon does keep is the call itself and, for a Stellar asset's
 * contract, the balance changes it made. The call has to be the token
 * service's `execute` of this message, and it has to have succeeded; the
 * message it carried is the hub's own ABI payload, which names the token id,
 * the recipient and the amount. A caller then checks that against the balance
 * change, which only a Stellar asset produces.
 */
export async function readHorizonExecution(params: {
  readonly horizonUrl: string;
  readonly txHash: string;
  readonly tokenService: string;
  readonly messageId: string;
}): Promise<StellarReceipt & { readonly balanceChanges: readonly HorizonBalanceChange[] }> {
  const url = `${params.horizonUrl.replace(/\/$/, "")}/transactions/${params.txHash}/operations`;
  const reply = await requestJson("Horizon", url);
  if (!reply.ok) {
    throw new MavnaError(`Horizon answered HTTP ${reply.status} for the delivery transaction.`, {
      retryable: reply.status >= 500 || reply.status === 429,
    });
  }
  const records =
    (reply.body as { _embedded?: { records?: HorizonOperation[] } })._embedded?.records ?? [];

  for (const operation of records) {
    if (operation.type !== "invoke_host_function" || !operation.transaction_successful) continue;
    const args = (operation.parameters ?? []).map((p) =>
      scValToNative(xdr.ScVal.fromXdr(p.value, "base64")),
    );
    const [contract, method, , messageId] = args;
    const payload = args[args.length - 1];
    if (
      contract !== params.tokenService ||
      method !== "execute" ||
      messageId !== params.messageId ||
      !(payload instanceof Uint8Array)
    ) {
      continue;
    }
    return { ...decodeHubTransfer(payload), balanceChanges: operation.asset_balance_changes ?? [] };
  }
  throw new MavnaError(
    "Horizon's record of the transaction Axelar names is not the token service executing " +
      "this message, so it is not evidence that this transfer arrived.",
    { retryable: false },
  );
}

/**
 * The hub's message to Stellar: `(uint256 4, string sourceChain, bytes inner)`,
 * where inner is `(uint256 0, bytes32 tokenId, bytes source, bytes destination,
 * uint256 amount, bytes data)`, the interchain transfer the token service pays
 * out. Read strictly: any other message type is refused.
 */
export function decodeHubTransfer(payload: Uint8Array): StellarReceipt {
  const hexed = hex(payload);
  const word = (data: string, index: number): bigint => {
    const slice = data.slice(index * 64, index * 64 + 64);
    if (slice.length !== 64) throw unreadable();
    return BigInt(`0x${slice}`);
  };
  const bytesAt = (data: string, offset: bigint): string => {
    const start = Number(offset) * 2;
    const length = Number(BigInt(`0x${data.slice(start, start + 64) || "0"}`));
    const body = data.slice(start + 64, start + 64 + length * 2);
    if (body.length !== length * 2) throw unreadable();
    return body;
  };

  if (word(hexed, 0) !== 4n) throw unreadable();
  const inner = bytesAt(hexed, word(hexed, 2));
  if (word(inner, 0) !== 0n) throw unreadable();
  const tokenId = inner.slice(64, 128);
  const recipientHex = bytesAt(inner, word(inner, 3));
  const amount = word(inner, 4);
  let recipient = "";
  for (let i = 0; i < recipientHex.length; i += 2) {
    recipient += String.fromCharCode(Number.parseInt(recipientHex.slice(i, i + 2), 16));
  }
  if (tokenId.length !== 64 || amount <= 0n || !/^[GCM][A-Z2-7]{55,}$/.test(recipient)) {
    throw unreadable();
  }
  return { tokenId, recipient, amount };
}

function unreadable(): MavnaError {
  return new MavnaError("The message the token service executed is not an interchain transfer.", {
    retryable: false,
  });
}
