import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ChannelPool } from "./channels.js";

const poolOf = (n: number): ChannelPool =>
  new ChannelPool({ channels: Array.from({ length: n }, () => Keypair.random()) });

const NOW = 1_000_000;
const DAY = 86_400;

describe("channel pool", () => {
  it("gives one channel per in-flight settlement, never shared", () => {
    const pool = poolOf(2);
    const a = pool.acquire("transfer-a", NOW + DAY, NOW);
    const b = pool.acquire("transfer-b", NOW + DAY, NOW);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Sharing would let two ladders occupy the same sequence numbers.
    expect(a?.address).not.toBe(b?.address);
  });

  it("returns the same channel when asked twice for the same transfer", () => {
    const pool = poolOf(2);
    expect(pool.acquire("t", NOW + DAY, NOW)?.address).toBe(
      pool.acquire("t", NOW + DAY, NOW)?.address,
    );
    expect(pool.leasedCount).toBe(1);
  });

  it("reports exhaustion rather than throwing, so the caller can refuse at quote time", () => {
    const pool = poolOf(1);
    pool.acquire("first", NOW + DAY, NOW);
    expect(pool.acquire("second", NOW + DAY, NOW)).toBeUndefined();
    expect(pool.availableCount).toBe(0);
  });

  it("only reuses a channel once its settlement is finished", () => {
    const pool = poolOf(1);
    const first = pool.acquire("first", NOW + DAY, NOW);
    expect(pool.acquire("second", NOW + DAY, NOW)).toBeUndefined();

    pool.release("first", first?.address ?? "");
    const reused = pool.acquire("second", NOW + DAY, NOW);
    expect(reused?.address).toBe(first?.address);
  });

  it("ignores a release for something it never leased", () => {
    const pool = poolOf(1);
    pool.release("never-existed", "GNOTHING");
    expect(pool.availableCount).toBe(1);
  });

  it("reclaims a lease whose settlement can no longer land", () => {
    const pool = poolOf(1);
    const first = pool.acquire("abandoned", NOW + DAY, NOW);

    const reused = pool.acquire("next", NOW + 2 * DAY, NOW + DAY);
    expect(reused?.address).toBe(first?.address);
    expect(pool.leasedCount).toBe(1);
  });

  it("does not reclaim a lease that is still live", () => {
    const pool = poolOf(1);
    pool.acquire("in-flight", NOW + DAY, NOW);
    expect(pool.acquire("next", NOW + 2 * DAY, NOW + DAY - 1)).toBeUndefined();
  });

  it("follows the newest settlement when the same owner asks again", () => {
    const pool = poolOf(1);
    pool.acquire("owner", NOW + 10, NOW);
    pool.acquire("owner", NOW + DAY, NOW);
    expect(pool.acquire("next", NOW + 2 * DAY, NOW + 10)).toBeUndefined();
  });

  it("releases only the channel it is told the settlement was on", () => {
    const pool = poolOf(2);
    const leased = pool.acquire("owner", NOW + DAY, NOW);
    const other = poolOf(1).acquire("elsewhere", NOW + DAY, NOW);

    pool.release("owner", other?.address ?? "");
    expect(pool.leasedCount).toBe(1);
    pool.release("owner", leased?.address ?? "");
    expect(pool.leasedCount).toBe(0);
  });

  it("refuses to exist with no channels at all", () => {
    expect(() => new ChannelPool({ channels: [] })).toThrow();
  });
});
