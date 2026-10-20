import { MavnaError, type NetworkId, type Remedy } from "@mavna/core";

/**
 * Where a message stands, according to LayerZero.
 *
 * LayerZero publishes no attestation the way Circle does. What it publishes is
 * an indexer, and the indexer is the only place the DVN verification and the
 * executor delivery are visible together. So this is the status source, with the
 * limits that implies: it is an index, it lags, and "not found" means not
 * indexed rather than not sent.
 *
 * That distinction is load bearing. A user shown "failed" for a transfer that is
 * merely unindexed is a user who sends a second one.
 */

export const SCAN_BASE_URL: Readonly<Record<NetworkId, string>> = {
  testnet: "https://scan-testnet.layerzero-api.com/v1",
  mainnet: "https://scan.layerzero-api.com/v1",
};

/**
 * The statuses LayerZero's own OpenAPI document declares.
 *
 * Written out rather than widened to `string`, so a new one LayerZero adds shows
 * up as an unhandled case here rather than as a transfer silently reported as
 * pending forever.
 */
export type ScanStatusName =
  | "INFLIGHT"
  | "CONFIRMING"
  | "FAILED"
  | "DELIVERED"
  | "BLOCKED"
  | "PAYLOAD_STORED"
  | "APPLICATION_BURNED"
  | "APPLICATION_SKIPPED"
  | "UNRESOLVABLE_COMMAND"
  | "MALFORMED_COMMAND";

export interface ScanTx {
  readonly txHash?: string;
  readonly blockTimestamp?: number;
  /** The raw bytes the message carried. On an OFT send this is the amount. */
  readonly payload?: string;
}

export interface ScanMessage {
  readonly guid?: string;
  readonly status?: { readonly name?: ScanStatusName; readonly message?: string };
  readonly pathway?: {
    /** The message's nonce on its pathway, which a compose message carries. */
    readonly nonce?: number;
    readonly srcEid?: number;
    readonly dstEid?: number;
    readonly sender?: { readonly address?: string; readonly chain?: string };
    readonly receiver?: { readonly address?: string; readonly chain?: string };
  };
  readonly source?: { readonly status?: string; readonly tx?: ScanTx };
  readonly destination?: { readonly status?: string; readonly tx?: ScanTx };
}

export interface ScanOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class ScanService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(network: NetworkId, options: ScanOptions = {}) {
    this.baseUrl = SCAN_BASE_URL[network];
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /**
   * Every message a source transaction produced.
   *
   * An empty array means the indexer has nothing, which is the normal state for
   * the first minute after a send and is not evidence of anything going wrong.
   */
  async byTransaction(txHash: string): Promise<readonly ScanMessage[]> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/messages/tx/${encodeURIComponent(txHash)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );

    // The indexer answers an unknown hash with 404, and that is an answer.
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new MavnaError(`LayerZero Scan answered HTTP ${response.status}.`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const body = (await response.json()) as { data?: readonly ScanMessage[] };
    return body.data ?? [];
  }
}

/**
 * What a status name means for someone waiting on their money.
 *
 * Split into three rather than two on purpose. "Still going" and "stopped and
 * needs you" are different states with different copy, and a stopped message
 * is often recoverable, which is worth saying rather than burying under a
 * generic failure.
 */
export function classifyScanStatus(
  name: ScanStatusName | undefined,
): "pending" | "delivered" | "stalled" {
  switch (name) {
    case "DELIVERED":
      return "delivered";
    case "INFLIGHT":
    case "CONFIRMING":
    case undefined:
      return "pending";
    case "FAILED":
    case "BLOCKED":
    case "PAYLOAD_STORED":
    case "APPLICATION_BURNED":
    case "APPLICATION_SKIPPED":
    case "UNRESOLVABLE_COMMAND":
    case "MALFORMED_COMMAND":
      return "stalled";
    default:
      // A status added after this was written. Calling it pending would spin
      // forever and calling it delivered would claim money arrived, so it is
      // reported as stopped and left for a person to read.
      return "stalled";
  }
}

/**
 * What the user can actually do about a stopped message.
 *
 * Never a message with no action beside it, which is what the execution model
 * requires and what the prior art gets wrong: its failure-message map is empty.
 * The cases here are genuinely different. A failed execution can be run again
 * by anyone once its cause clears. A stored payload is held rather than lost,
 * though how it clears is not documented. A blocked message is somebody
 * else's problem clearing in front of it, so waiting is the whole remedy. A
 * burned or malformed one is over, and saying so plainly beats letting someone
 * retry forever hoping.
 */
export function remedyForStatus(
  name: ScanStatusName | undefined,
  scanUrl: string,
  nowUnix: number,
): Remedy {
  switch (name) {
    case "PAYLOAD_STORED":
      // LayerZero's V2 docs say nothing about clearing a stored payload, so no
      // action is promised: the scan page and the reference are what is known
      return {
        kind: "contact",
        reference: scanUrl,
        because:
          "Delivery reverted on Stellar and LayerZero is holding the message rather than " +
          "losing it. The scan page shows its state; quote it to support to have it delivered.",
      };
    case "BLOCKED":
      return {
        kind: "wait",
        // LayerZero delivers a pathway in nonce order, so this clears when the
        // message ahead of it does. No deadline is knowable, and inventing one
        // would be a countdown that reaches zero and means nothing.
        untilUnix: nowUnix,
        because:
          "An earlier transfer on this route is stuck in front of this one, and LayerZero " +
          "delivers them in order. This one moves when that one does.",
      };
    case "APPLICATION_BURNED":
    case "APPLICATION_SKIPPED":
      return {
        kind: "unrecoverable",
        because: "The token contract's owner discarded this message. The funds will not arrive.",
      };
    case "UNRESOLVABLE_COMMAND":
    case "MALFORMED_COMMAND":
      return {
        kind: "unrecoverable",
        because: "LayerZero could not read the message that was sent, so it cannot be delivered.",
      };
    case "FAILED":
      // LayerZero's debugging docs: Scan shows the execution error and can run
      // the message again, and the endpoint's lzReceive behind it is open to anyone
      return {
        kind: "claim",
        at: scanUrl,
        because:
          "The message reached Stellar but running it there failed. The scan page shows why, " +
          "and once that cause has cleared anyone can run it again from there.",
      };
    default:
      return {
        kind: "contact",
        reference: scanUrl,
        because:
          "LayerZero reported a status this app does not recognise, so it cannot say whether " +
          "the transfer is recoverable. The scan page has the details.",
      };
  }
}

/** The page a person can look at, which is the point of publishing a link at all. */
export function scanMessageUrl(network: NetworkId, txHash: string): string {
  const host = network === "mainnet" ? "layerzeroscan.com" : "testnet.layerzeroscan.com";
  return `https://${host}/tx/${txHash}`;
}
