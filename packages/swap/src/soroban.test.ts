import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwapRefusal } from "./provider.js";
import { simulate } from "./soroban.js";

const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
  .setTimeout(30)
  .build();

/** The node, at its boundary, answering one JSON-RPC body. */
function answering(body: unknown): void {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => vi.unstubAllGlobals());

describe("simulate, when the swap cannot be prepared", () => {
  it("says so in fixed words and keeps the host's text as detail", async () => {
    answering({
      jsonrpc: "2.0",
      id: 1,
      result: { error: "HostError: Error(Contract, #6)\nEvent log: ...", latestLedger: 10 },
    });
    const error = await simulate("https://rpc.invalid", tx, 1_000, "SushiSwap").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapRefusal);
    expect((error as SwapRefusal).message).toBe("SushiSwap could not prepare this swap right now.");
    expect((error as SwapRefusal).message).not.toMatch(/HostError/);
    expect((error as SwapRefusal).detail).toMatch(/HostError: Error\(Contract, #6\)/);
    expect((error as SwapRefusal).retryable).toBe(false);
  });

  it("keeps the node's own error text out of the message too", async () => {
    answering({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params: xdr" } });
    const error = await simulate("https://rpc.invalid", tx, 1_000, "Aquarius").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapRefusal);
    expect((error as SwapRefusal).message).toBe("Aquarius could not prepare this swap right now.");
    expect((error as SwapRefusal).detail).toMatch(/invalid params: xdr/);
    expect((error as SwapRefusal).retryable).toBe(true);
  });
});
