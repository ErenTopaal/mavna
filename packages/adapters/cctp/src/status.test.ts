import type { StepPhase, TransferHandle } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Captured,
  type HorizonPage,
  type OperationsCapture,
  oldDelivery as old,
  recentDelivery as recent,
} from "./__fixtures__/fixtures.js";
import { CctpAdapter } from "./adapter.js";
import { AttestationService } from "./attestation.js";
import { CCTP_CONTRACTS } from "./config.js";

const testnet = CCTP_CONTRACTS.testnet;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("status from a burn proves delivery from the chain, not a balance", () => {
  it("stays pending for an attested transfer the forwarder has not delivered, though the recipient already holds more", async () => {
    // The recipient as it stood before the delivery: its history up to then, no
    // event for this nonce anywhere in retention, and a trustline already holding
    // 6 USDC against an attested 5. A balance check calls this done.
    const adapter = adapterWith({
      captured: old,
      events: replayScan(old),
      horizon: old.operationsBeforeDelivery,
      ledgerEntries: old.recipientLedgerEntries,
    });

    const phase = await adapter.status(handleFor(old.burn, old.recipient));
    expect(phase.phase).toBe("pending");
  });

  it("is done with the forwarder event's amount when the event names this message", async () => {
    const adapter = adapterWith({
      captured: recent,
      events: (request) => {
        const filter = request.filters[0];
        if (filter?.contractIds?.[0] === testnet.messageTransmitter) {
          expect(filter.topics?.[0]?.[2]).toBe(recent.messageReceived.events[0]?.topic?.[2]);
          return recent.messageReceived;
        }
        if (filter?.contractIds?.[0] === testnet.cctpForwarder) return recent.mintAndForward;
        throw new Error(`unexpected getEvents ${JSON.stringify(request)}`);
      },
    });

    const phase = await adapter.status(
      handleFor(recent.burn, "GAM7ZOID2YK4SVLN4LNOBWCKLXAXRIXPQMBCKGRA3C37EHQ3NFX7I4CO"),
    );
    expectDone(phase, "10000000");
  });

  it("falls back to Horizon for a delivery older than RPC retention", async () => {
    const adapter = adapterWith({
      captured: old,
      events: replayScan(old),
      horizon: old.operations,
    });

    const phase = await adapter.status(handleFor(old.burn, old.recipient));
    expectDone(phase, "50000000");
  });
});

describe("status from a destination address alone", () => {
  it("does not call a transfer done because the address once received a delivery", async () => {
    const adapter = adapterWith({ captured: old, horizon: old.operations });
    const phase = await adapter.status(handleFor(undefined, old.recipient));

    expect(phase.phase).toBe("pending");
    if (phase.phase !== "pending") return;
    // The latest forwarder delivery, so the person can see what did arrive.
    expect(phase.ref.txHash).toBe(
      "1d7a7e152bf95193d2933971deb712de682e862da15beb8631e89a5c96a17174",
    );
  });

  it("surfaces a failing Horizon rather than reporting that nothing arrived", async () => {
    const adapter = adapterWith({ captured: old, horizonStatus: 503 });
    await expect(adapter.status(handleFor(undefined, old.recipient))).rejects.toThrow(/503/);
  });
});

type EventsHandler = (request: rpc.Api.GetEventsRequest) => rpc.Api.RawGetEventsResponse;

/** Replays the captured scan page by page, keyed on the cursor the adapter sends. */
function replayScan(capture: OperationsCapture): EventsHandler {
  return (request) => {
    const cursor = "cursor" in request ? request.cursor : undefined;
    const page = capture.scan.find((p) => p.request.pagination.cursor === cursor);
    if (page === undefined) throw new Error(`no captured page for cursor ${cursor}`);
    expect(request.filters[0]?.contractIds).toEqual([testnet.messageTransmitter]);
    return page.response;
  };
}

/**
 * The adapter with doubles at its network edges only: Circle and Horizon over
 * fetch, Stellar RPC through its server object. Anything unexpected throws, so a
 * test cannot quietly reach the real network.
 */
function adapterWith(options: {
  readonly captured: Captured;
  readonly events?: EventsHandler;
  readonly horizon?: HorizonPage;
  readonly horizonStatus?: number;
  readonly ledgerEntries?: OperationsCapture["recipientLedgerEntries"];
}): CctpAdapter {
  const client = new RpcClient({
    url: "https://soroban-testnet.stellar.org",
    sleep: async () => {},
  });
  vi.spyOn(client.server, "getHealth").mockResolvedValue(options.captured.health);
  vi.spyOn(client.server, "getEvents").mockImplementation(async (request) => {
    if (options.events === undefined) throw new Error("getEvents was not expected");
    return rpc.parseRawEvents(options.events(request));
  });
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async () => {
    const captured = options.ledgerEntries;
    if (captured === undefined) throw new Error("getLedgerEntries was not expected");
    return {
      latestLedger: captured.latestLedger,
      entries: captured.entries.map((e) => ({
        key: xdr.LedgerKey.fromXDR(e.key, "base64"),
        val: xdr.LedgerEntryData.fromXDR(e.xdr, "base64"),
      })),
    };
  });

  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith(testnet.irisBaseUrl)) {
      if (url === `${testnet.irisBaseUrl}/v2/messages/0?transactionHash=${options.captured.burn}`) {
        return Response.json({ messages: [options.captured.iris] });
      }
      return new Response("{}", { status: 404 });
    }
    if (url.startsWith("https://horizon-testnet.stellar.org/accounts/")) {
      if (options.horizonStatus !== undefined) {
        return new Response("{}", { status: options.horizonStatus });
      }
      if (options.horizon === undefined) throw new Error(`Horizon was not expected: ${url}`);
      return Response.json(options.horizon);
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  return new CctpAdapter({
    network: "testnet",
    rpc: client,
    baseReserveStroops: 5_000_000,
    attestations: new AttestationService("testnet"),
  });
}

function handleFor(burn: string | undefined, destination: string): TransferHandle {
  return {
    sourceTxHash: burn,
    sourceChainId: burn === undefined ? undefined : "ethereum-sepolia",
    depositAddress: undefined,
    destinationAddress: destination,
  };
}

function expectDone(phase: StepPhase, baseUnits: string): void {
  expect(phase.phase).toBe("done");
  if (phase.phase !== "done") return;
  expect(phase.received.baseUnits).toBe(baseUnits);
  expect(phase.received.asset.id).toBe(`USDC:${testnet.usdcIssuer}`);
}
