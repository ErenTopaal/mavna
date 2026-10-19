import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { oldDelivery as old, recentDelivery as recent } from "./__fixtures__/fixtures.js";
import { deliveredByEvent, deliveredByOperation, identifyMessage } from "./proof.js";

const recentEvents = [
  ...rpc.parseRawEvents(recent.messageReceived).events,
  ...rpc.parseRawEvents(recent.mintAndForward).events,
];

describe("identifyMessage", () => {
  it("reads the nonce and both domains from the raw message", () => {
    const id = identifyMessage(recent.iris.message);
    expect(hex(id.nonce)).toBe("e83b84d963478fb4498f1a22c8b44b04c3c6c4ec4eccdc898b3356980f20d24e");
    expect(id.sourceDomain).toBe(0);
    expect(id.destinationDomain).toBe(27);
  });
});

describe("deliveredByEvent", () => {
  it("finds the delivery whose transmitter event carries this message's nonce", () => {
    const delivery = deliveredByEvent(
      recentEvents,
      identifyMessage(recent.iris.message),
      "testnet",
    );
    expect(delivery).toEqual({
      txHash: "5821d6b37277c11a3f85320a93bb90bd36e4c8aa0a88a48dcde0b6d103467eae",
      ledger: 5261151,
      amount: 10_000_000n,
      recipient: "GAM7ZOID2YK4SVLN4LNOBWCKLXAXRIXPQMBCKGRA3C37EHQ3NFX7I4CO",
    });
  });

  it("finds nothing for another message, though the events are a real delivery", () => {
    expect(
      deliveredByEvent(recentEvents, identifyMessage(old.iris.message), "testnet"),
    ).toBeUndefined();
  });

  it("finds nothing when the nonce matches but the source domain does not", () => {
    const id = identifyMessage(recent.iris.message);
    expect(deliveredByEvent(recentEvents, { ...id, sourceDomain: 6 }, "testnet")).toBeUndefined();
  });

  it("does not take the transmitter's receipt alone as the forwarder's delivery", () => {
    const receiptOnly = rpc.parseRawEvents(recent.messageReceived).events;
    expect(
      deliveredByEvent(receiptOnly, identifyMessage(recent.iris.message), "testnet"),
    ).toBeUndefined();
  });
});

describe("deliveredByOperation", () => {
  const records = old.operations._embedded.records;

  it("finds the forwarder call that carried exactly these message bytes", () => {
    expect(deliveredByOperation(records, old.iris.message, "testnet")).toEqual({
      txHash: "1d7a7e152bf95193d2933971deb712de682e862da15beb8631e89a5c96a17174",
      ledger: 4094213,
      amount: 50_000_000n,
      recipient: old.recipient,
    });
  });

  it("finds nothing for another message, though the account holds a real delivery", () => {
    expect(deliveredByOperation(records, recent.iris.message, "testnet")).toBeUndefined();
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
