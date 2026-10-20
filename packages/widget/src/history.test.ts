import { beforeEach, describe, expect, it } from "vitest";

/**
 * A real key-value store behind the storage contract, not a spy.
 *
 * The unit under test is the wrapper's judgement: parsing, dedup, the cap, and
 * treating mangled data as absent. Those need a store that stores, which a Map
 * is. How an actual browser persists it is the browser suite's job.
 */
class MapStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

(globalThis as { window?: unknown }).window = { localStorage: new MapStorage() };

import { forget, forgetHistory, readHistory, remember, type TransferRecord } from "./history.js";

/**
 * The browser's own record of transfers, which is untrusted input like any
 * other: localStorage is user-writable and shared with everything on the origin.
 */

const record = (over: Partial<TransferRecord> = {}): TransferRecord => ({
  sourceTxHash: "0xabc",
  sourceChainId: "ethereum-sepolia",
  sourceChainName: "Ethereum Sepolia",
  destination: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
  sendsBaseUnits: "5000000",
  symbol: "USDC",
  decimals: 6,
  startedAtUnix: 1_755_000_000,
  explorerUrl: undefined,
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("what this browser remembers", () => {
  it("keeps newest first and never duplicates a transaction", () => {
    remember(record({ sourceTxHash: "0x1" }));
    remember(record({ sourceTxHash: "0x2" }));
    remember(record({ sourceTxHash: "0x1" }));

    const seen = readHistory();
    expect(seen.map((r) => r.sourceTxHash)).toEqual(["0x1", "0x2"]);
  });

  it("drops records something else mangled rather than rendering them", () => {
    // Storage is shared with every script on the origin. A malformed entry is
    // untrusted input, and the failure mode is silence, not a crash mid-render.
    window.localStorage.setItem(
      "mavna.transfers.v1",
      JSON.stringify([record(), { garbage: true }, "not even an object"]),
    );
    expect(readHistory()).toHaveLength(1);
  });

  it("treats unreadable storage as empty rather than throwing", () => {
    window.localStorage.setItem("mavna.transfers.v1", "{not json");
    expect(readHistory()).toEqual([]);
  });

  it("never links to anything but an https explorer from stored data", () => {
    window.localStorage.setItem(
      "mavna.transfers.v1",
      JSON.stringify([
        record({ sourceTxHash: "0x1", explorerUrl: "javascript:alert(1)" }),
        record({ sourceTxHash: "0x2", explorerUrl: "https://sepolia.etherscan.io/tx/0x2" }),
      ]),
    );
    expect(readHistory().map((r) => r.explorerUrl)).toEqual([
      undefined,
      "https://sepolia.etherscan.io/tx/0x2",
    ]);
  });

  it("forgets one transfer by its transaction, keeping the rest", () => {
    remember(record({ sourceTxHash: "0x1" }));
    remember(record({ sourceTxHash: "0x2" }));
    forget("0x1");
    expect(readHistory().map((r) => r.sourceTxHash)).toEqual(["0x2"]);
  });

  it("forgets everything when asked, because the data is the user's", () => {
    remember(record());
    forgetHistory();
    expect(readHistory()).toEqual([]);
  });
});

describe("history from before it was kept per network", () => {
  // only testnet was served before v2, so everything under the old key is testnet's
  const legacy = (key: string, records: TransferRecord[]) =>
    window.localStorage.setItem(key, JSON.stringify(records));

  it("moves into the testnet history on first read, and the old key goes away", () => {
    legacy("mavna.transfers.v1", [record({ sourceTxHash: "0xold", startedAtUnix: 1 })]);
    remember(record({ sourceTxHash: "0xnew", startedAtUnix: 2 }), "mavna.transfers.v1.testnet");

    const seen = readHistory("mavna.transfers.v1.testnet");
    expect(seen.map((r) => r.sourceTxHash)).toEqual(["0xnew", "0xold"]);
    expect(window.localStorage.getItem("mavna.transfers.v1")).toBeNull();
    expect(readHistory("mavna.transfers.v1.testnet")).toEqual(seen);
  });

  it("goes to testnet even when mainnet is read first, and never shows on mainnet", () => {
    legacy("mavna.transfers.v1", [record({ sourceTxHash: "0xold" })]);
    expect(readHistory("mavna.transfers.v1.mainnet")).toEqual([]);
    expect(window.localStorage.getItem("mavna.transfers.v1")).toBeNull();
    expect(readHistory("mavna.transfers.v1.testnet").map((r) => r.sourceTxHash)).toEqual(["0xold"]);
  });

  it("keeps an integrator's prefix, and does not count a transfer twice", () => {
    legacy("acme:mavna.transfers.v1", [record({ sourceTxHash: "0xsame" })]);
    remember(record({ sourceTxHash: "0xsame" }), "acme:mavna.transfers.v1.testnet");
    expect(readHistory("acme:mavna.transfers.v1.testnet").map((r) => r.sourceTxHash)).toEqual([
      "0xsame",
    ]);
    expect(window.localStorage.getItem("acme:mavna.transfers.v1")).toBeNull();
  });
});
