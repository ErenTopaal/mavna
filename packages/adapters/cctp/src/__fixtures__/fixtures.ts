import { readFileSync } from "node:fs";
import type { rpc } from "@stellar/stellar-sdk";
import type { HorizonOperation } from "../proof.js";

/**
 * What Stellar testnet and Circle's sandbox actually returned, captured read-only.
 * Each file's `source` says where from and when.
 *
 * forward-event.json: a delivery inside RPC retention (ledger 5261151), with the
 * transmitter's `message_received` and the forwarder's `mint_and_forward`, and
 * every event that transaction emitted.
 *
 * forward-operations.json: a delivery from August (ledger 4094213), long outside
 * RPC retention: the recipient's Horizon operations now and as they stood before
 * the delivery, a full RPC scan for its nonce that found nothing, and the
 * recipient's ledger entries.
 */

export interface Captured {
  readonly burn: string;
  readonly iris: { readonly message: string };
  readonly health: rpc.Api.GetHealthResponse;
}

export interface HorizonPage {
  readonly _embedded: { readonly records: readonly HorizonOperation[] };
}

export interface EventCapture extends Captured {
  readonly messageReceived: rpc.Api.RawGetEventsResponse;
  readonly mintAndForward: rpc.Api.RawGetEventsResponse;
}

export interface OperationsCapture extends Captured {
  readonly recipient: string;
  readonly operations: HorizonPage;
  readonly operationsBeforeDelivery: HorizonPage;
  readonly scan: readonly {
    readonly request: { readonly pagination: { readonly cursor?: string } };
    readonly response: rpc.Api.RawGetEventsResponse;
  }[];
  readonly recipientLedgerEntries: {
    readonly latestLedger: number;
    readonly entries: readonly { readonly key: string; readonly xdr: string }[];
  };
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
}

export const recentDelivery: EventCapture = load<EventCapture>("forward-event.json");
export const oldDelivery: OperationsCapture = load<OperationsCapture>("forward-operations.json");
