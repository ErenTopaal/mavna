import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ChannelPool } from "./channels.js";

const poolOf = (n: number): ChannelPool =>
  new ChannelPool({ channels: Array.from({ length: n }, () => Keypair.random()) });

describe("channel pool", () => {
  it("gives one channel per in-flight settlement, never shared", () => {
    const pool = poolOf(2);
    const a = pool.acquire("transfer-a");
    const b = pool.acquire("transfer-b");

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Sharing would let two ladders occupy the same sequence numbers.
    expect(a?.address).not.toBe(b?.address);
  });

  it("returns the same channel when asked twice for the same transfer", () => {
    const pool = poolOf(2);
    expect(pool.acquire("t")?.address).toBe(pool.acquire("t")?.address);
    expect(pool.leasedCount).toBe(1);
  });

  it("reports exhaustion rather than throwing, so the caller can refuse at quote time", () => {
    const pool = poolOf(1);
    pool.acquire("first");
    expect(pool.acquire("second")).toBeUndefined();
    expect(pool.availableCount).toBe(0);
  });

  it("only reuses a channel once its settlement is finished", () => {
    const pool = poolOf(1);
    const first = pool.acquire("first");
    expect(pool.acquire("second")).toBeUndefined();

    pool.release("first");
    const reused = pool.acquire("second");
    expect(reused?.address).toBe(first?.address);
  });

  it("ignores a release for something it never leased", () => {
    const pool = poolOf(1);
    pool.release("never-existed");
    expect(pool.availableCount).toBe(1);
  });

  it("refuses to exist with no channels at all", () => {
    expect(() => new ChannelPool({ channels: [] })).toThrow();
  });
});
