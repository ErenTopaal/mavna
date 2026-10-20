import { describe, expect, it } from "vitest";
import { InMemoryTransferStore, isSearchable, parseLookupKey, toHandle } from "./resume.js";

describe("finding a transfer from what the user actually has", () => {
  it("accepts a source transaction hash, with or without a prefix", () => {
    const h = "a4a4308d0b7692da6f377d9c8f8a131cee8110a32dd218f6c55b1c5a7f046660";
    expect(parseLookupKey(h).kind).toBe("source-tx");
    expect(parseLookupKey(`0x${h}`).kind).toBe("source-tx");
  });

  it("accepts a Solana signature and a Starknet hash written without its leading zeros", () => {
    // a Solana signature is 64 bytes in base58, so 87 or 88 characters
    const solana =
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    expect(parseLookupKey(solana)).toEqual({ kind: "source-tx", value: solana });
    expect(parseLookupKey(solana.slice(0, 87)).kind).toBe("source-tx");
    const starknet = `0x${"7c1f".repeat(15)}abc`;
    expect(starknet).toHaveLength(65);
    expect(parseLookupKey(starknet)).toEqual({ kind: "source-tx", value: starknet });
    expect(parseLookupKey("0x1a2b").kind).toBe("source-tx");
    // exactly 40 hex digits is still an EVM address
    expect(parseLookupKey(`0x${"ab".repeat(20)}`).kind).toBe("deposit-address");
  });

  it("refuses base58 that is too short or uses letters base58 leaves out", () => {
    expect(() => parseLookupKey("5VERv8NMvzbJMEkV8xnrLkEa")).toThrow(/Paste the transaction/);
    expect(() => parseLookupKey(`${"0OIl".repeat(22)}`)).toThrow(/Paste the transaction/);
    expect(() => parseLookupKey(`0x${"a".repeat(65)}`)).toThrow(/Paste the transaction/);
  });

  it("accepts a Stellar address, which is all a user may have after closing a tab", () => {
    // The most mature product in this category REFUSES this: its type requires a
    // transaction hash or an internal task id. This is the differentiator.
    const key = parseLookupKey("GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU");
    expect(key.kind).toBe("destination-address");
    expect(isSearchable(toHandle(key))).toBe(true);
  });

  it("accepts an EVM deposit address", () => {
    expect(parseLookupKey("0xb11111F63A875Ac80Fb870f797eB6A2Bf2836a25").kind).toBe(
      "deposit-address",
    );
  });

  it("tolerates whitespace, because people paste", () => {
    expect(
      parseLookupKey("  GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU  ").kind,
    ).toBe("destination-address");
  });

  it("says what to do when the input is not recognisable", () => {
    // Errors say what happened and what to do; they never apologise or say
    // "something went wrong".
    expect(() => parseLookupKey("hello")).toThrow(/Paste the transaction/);
    expect(() => parseLookupKey("")).toThrow(/Enter a transaction/);
  });
});

describe("local memory is a convenience, never the source of truth", () => {
  it("remembers and forgets", async () => {
    const store = new InMemoryTransferStore();
    await store.remember(
      "t1",
      toHandle(parseLookupKey("0xb11111F63A875Ac80Fb870f797eB6A2Bf2836a25")),
    );
    expect(await store.all()).toHaveLength(1);
    await store.forget("t1");
    expect(await store.all()).toHaveLength(0);
  });

  it("a handle with nothing in it is not searchable", () => {
    expect(
      isSearchable({
        sourceTxHash: undefined,
        depositAddress: undefined,
        destinationAddress: undefined,
        sourceChainId: undefined,
      }),
    ).toBe(false);
  });

  it("knowing the chain is not itself something to search on", () => {
    // A chain narrows a search; it cannot be one. Counting it would make a handle
    // with no transaction and no address look recoverable when nothing about it is.
    expect(
      isSearchable({
        sourceTxHash: undefined,
        depositAddress: undefined,
        destinationAddress: undefined,
        sourceChainId: "base-sepolia",
      }),
    ).toBe(false);
  });
});
