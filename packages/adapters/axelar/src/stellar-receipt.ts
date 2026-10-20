import { MavnaError } from "@mavna/core";
import type { RpcClient } from "@mavna/stellar";
import { rpc, StrKey, scValToNative, type xdr } from "@stellar/stellar-sdk";

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
    throw new MavnaError(
      aged
        ? "Axelar reports this transfer delivered, but the Stellar node no longer keeps the " +
            "transaction that delivered it, so how much arrived cannot be shown from the chain."
        : "Axelar reports this transfer delivered, and Stellar has not shown the transaction " +
            "yet. Checking again shortly.",
      { retryable: !aged },
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
