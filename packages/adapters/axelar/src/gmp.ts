import { MavnaError, type NetworkId } from "@mavna/core";

/**
 * Where a message stands, and what to do when it stops.
 *
 * One user transfer is TWO records here, because interchain transfers route
 * through a hub rather than chain to chain. The first record is the sending chain
 * reaching the hub; the second is the hub reaching Stellar. Reading the first as
 * the whole journey is the mistake this module exists to avoid: it reaches
 * "executed" while the funds are still in flight, and reporting that as delivered
 * tells a user their money has arrived when it has not.
 *
 * The two are linked by the first record's `callback`, which carries the hub
 * transaction that carries the second leg.
 */

const GMP_API: Readonly<Record<NetworkId, string>> = {
  testnet: "https://testnet.api.gmp.axelarscan.io",
  mainnet: "https://api.gmp.axelarscan.io",
};

/**
 * The lifecycle values Axelar's search returns.
 *
 * Their filter vocabulary is wider than this and includes values no record ever
 * carries, so this is the set observed on records rather than the set the query
 * accepts. Anything unrecognised is treated as still in progress, which is the
 * safe direction: it never reports a delivery that has not happened.
 */
export type GmpStatus =
  | "called"
  | "confirming"
  | "confirmed"
  | "approving"
  | "approved"
  | "executing"
  | "executed"
  | "express_executed"
  | "error";

export interface GmpRecord {
  readonly messageId: string | undefined;
  readonly status: string | undefined;
  readonly simplifiedStatus: string | undefined;
  readonly sourceChain: string | undefined;
  /** Where THIS leg goes, which for the first leg is the hub rather than Stellar. */
  readonly destinationChain: string | undefined;
  /** Where the whole transfer is going. Present once Axelar has read the payload. */
  readonly finalDestinationChain: string | undefined;
  readonly transactionHash: string | undefined;
  /**
   * The receipt log index of the gateway event, which is how a gas top-up names
   * this message. See `buildAddGas` for why this one and not `eventIndex`.
   *
   * Null on hub records, which are Cosmos rather than EVM. Recovery only ever
   * targets the first leg, which is the EVM one, so it is populated there.
   */
  readonly logIndex: number | undefined;
  /** Axelar's own counter for the event within the transaction. Not the log index. */
  readonly eventIndex: number | undefined;
  /** Identifies the second leg once the hub has created it. */
  readonly callbackId: string | undefined;
  /** True when Axelar says the delivery was underpaid. Three flags, any of them. */
  readonly underpaid: boolean;
  readonly errored: boolean;
  readonly refunded: boolean;
  /** The hub transaction carrying the second leg, once there is one. */
  readonly callbackTransactionHash: string | undefined;
  readonly sourceAddress: string | undefined;
  readonly destinationAddress: string | undefined;
  readonly amount: string | undefined;
  readonly symbol: string | undefined;
  readonly decimals: number | undefined;
  readonly tokenId: string | undefined;
}

interface RawRecord {
  readonly message_id?: string;
  readonly status?: string;
  readonly simplified_status?: string;
  readonly is_insufficient_fee?: boolean;
  readonly is_not_enough_gas?: boolean;
  readonly not_enough_gas_to_execute?: boolean;
  readonly refunded?: unknown;
  readonly callback?: { id?: string; transactionHash?: string };
  readonly interchain_transfer?: {
    sourceAddress?: string;
    destinationAddress?: string;
    amount?: string;
    symbol?: string;
    tokenId?: string;
    decimals?: number;
    destinationChain?: string;
  };
  readonly call?: {
    chain?: string;
    transactionHash?: string;
    logIndex?: number;
    eventIndex?: number;
    returnValues?: { destinationChain?: string };
  };
}

export class GmpApi {
  private readonly network: NetworkId;

  constructor(network: NetworkId) {
    this.network = network;
  }

  /** Every record Axelar holds for a transaction hash. Empty is not a failure. */
  async byTransaction(txHash: string): Promise<readonly GmpRecord[]> {
    return this.search({ txHash });
  }

  async byMessageId(messageId: string): Promise<readonly GmpRecord[]> {
    return this.search({ messageId });
  }

  private async search(query: Record<string, unknown>): Promise<readonly GmpRecord[]> {
    const response = await fetch(`${GMP_API[this.network]}/searchGMP`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });

    if (!response.ok) {
      throw new MavnaError(`Axelar's message search answered HTTP ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as { data?: RawRecord[] };
    const rows = body.data;
    if (!Array.isArray(rows)) return [];
    return rows.map(read);
  }
}

function read(row: RawRecord): GmpRecord {
  const transfer = row.interchain_transfer;
  return {
    messageId: row.message_id,
    status: row.status,
    simplifiedStatus: row.simplified_status,
    sourceChain: row.call?.chain,
    // The first leg's own destination is the hub, not Stellar. The chain the user
    // actually asked for is on the transfer, which is why both are carried.
    destinationChain: row.call?.returnValues?.destinationChain,
    finalDestinationChain: transfer?.destinationChain,
    transactionHash: row.call?.transactionHash,
    logIndex: row.call?.logIndex ?? undefined,
    eventIndex: row.call?.eventIndex,
    callbackId: row.callback?.id,
    // Three separate flags mean the same thing to a user. Any one of them is a
    // transfer that needs paying for again rather than waiting on.
    underpaid:
      row.is_insufficient_fee === true ||
      row.is_not_enough_gas === true ||
      row.not_enough_gas_to_execute === true,
    errored: row.status === "error",
    refunded: row.refunded !== undefined && row.refunded !== null && row.refunded !== false,
    callbackTransactionHash: row.callback?.transactionHash,
    sourceAddress: transfer?.sourceAddress,
    destinationAddress: transfer?.destinationAddress,
    amount: transfer?.amount,
    symbol: transfer?.symbol,
    decimals: transfer?.decimals,
    tokenId: transfer?.tokenId === undefined ? undefined : withPrefix(transfer.tokenId),
  };
}

function withPrefix(id: string): string {
  return id.startsWith("0x") ? id.toLowerCase() : `0x${id.toLowerCase()}`;
}

/** Whether a leg has finished carrying its message. */
export function legDelivered(record: GmpRecord): boolean {
  return record.status === "executed" || record.status === "express_executed";
}

/**
 * Topping up a message that was not paid enough to deliver.
 *
 * Read from Axelar's own gas service interface:
 *
 *     function addNativeGas(bytes32 txHash, uint256 logIndex, address refundAddress) payable
 *
 * The implementation does nothing but emit an event. It validates neither
 * argument, so a wrong `txHash` or `logIndex` does not revert: the money leaves,
 * no message is credited, and the transfer stays stuck. That makes the index
 * below the most dangerous number in this file.
 *
 * Axelar's two client libraries disagree about which index it is. The older SDK
 * reads `call.eventIndex` from the search API in one branch, and its own
 * `getLogIndexFromTxReceipt` (the RECEIPT log index) in the other, so it
 * contradicts itself; the two are different numbers whenever the transaction
 * emitted anything else, 4 against 125 on the transfer used to work this out.
 * The current library uses the receipt log index, the interface documents the
 * argument as "the log index for the cross-chain call", and the helper that
 * fills it is named for it. Three of four point the same way, so the receipt log
 * index is what is used here.
 *
 * Not confirmed by sending one. Add-gas is rare enough that no `NativeGasAdded`
 * event was found on base-sepolia, ethereum-sepolia or ethereum to check an
 * emitted index against its message.
 */
export const GAS_SERVICE_ABI = [
  {
    type: "function",
    name: "addNativeGas",
    stateMutability: "payable",
    inputs: [
      { name: "txHash", type: "bytes32" },
      { name: "logIndex", type: "uint256" },
      { name: "refundAddress", type: "address" },
    ],
    outputs: [],
  },
] as const;

export interface AddGasCall {
  readonly contract: string;
  readonly functionName: "addNativeGas";
  readonly args: readonly [txHash: string, logIndex: bigint, refundAddress: string];
  readonly value: bigint;
  readonly describes: string;
}

export function buildAddGas(params: {
  readonly gasService: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly refundAddress: string;
  readonly amount: bigint;
}): AddGasCall {
  if (params.amount <= 0n) {
    throw new MavnaError(
      "Refusing to add nothing as gas. A top-up of zero costs a signature and " +
        "changes nothing about the stuck message.",
      { retryable: false },
    );
  }
  if (!Number.isInteger(params.logIndex) || params.logIndex < 0) {
    throw new MavnaError(
      "Refusing to add gas without the message's log index. The gas service does " +
        "not check it and does not revert, so paying against a missing or wrong " +
        "index spends the money and credits nothing.",
      { retryable: false },
    );
  }
  return {
    contract: params.gasService,
    functionName: "addNativeGas",
    args: [
      params.txHash.startsWith("0x") ? params.txHash : `0x${params.txHash}`,
      BigInt(params.logIndex),
      params.refundAddress,
    ],
    value: params.amount,
    describes:
      "Pay again for delivering your transfer, which was sent without enough to " +
      "cover it. Your funds are still in the transfer and this releases them. " +
      "Anything not spent is returned to your wallet.",
  };
}
