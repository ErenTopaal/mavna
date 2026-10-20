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

    const reused = pool.acquire("next", NOW + 2 * DAY, NOW + DAY + 31);
    expect(reused?.address).toBe(first?.address);
    expect(pool.leasedCount).toBe(1);
  });

  it("waits out clock drift past the bound before reclaiming", () => {
    // maxTime is inclusive on the network and our clock is not the ledger's,
    // so a settlement can still land a little after we think it expired.
    const pool = poolOf(1);
    pool.acquire("late", NOW + DAY, NOW);
    expect(pool.acquire("next", NOW + 2 * DAY, NOW + DAY)).toBeUndefined();
    expect(pool.acquire("next", NOW + 2 * DAY, NOW + DAY + 30)).toBeUndefined();
    expect(pool.acquire("next", NOW + 2 * DAY, NOW + DAY + 31)).toBeDefined();
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

  it("hands out a channel's key only to the owner of its lease", () => {
    const keys = [Keypair.random()];
    const pool = new ChannelPool({ channels: keys });
    const address = keys[0]?.publicKey() ?? "";

    // Free, nobody may sign with it.
    expect(pool.keypairFor("owner", address)).toBeUndefined();

    pool.acquire("owner", NOW + DAY, NOW);
    expect(pool.keypairFor("owner", address)?.publicKey()).toBe(address);
    expect(pool.keypairFor("someone-else", address)).toBeUndefined();

    // Once it has moved on, the old owner's settlement no longer gets its key.
    pool.release("owner", address);
    pool.acquire("next", NOW + DAY, NOW);
    expect(pool.keypairFor("owner", address)).toBeUndefined();
    expect(pool.keypairFor("next", address)?.publicKey()).toBe(address);
  });

  it("extends a lease only for the owner on the channel it holds", () => {
    const keys = [Keypair.random(), Keypair.random()];
    const pool = new ChannelPool({ channels: keys });
    const mine = pool.acquire("owner", NOW + 300, NOW);
    const theirs = pool.acquire("other", NOW + 300, NOW);

    expect(pool.extend("owner", theirs?.address ?? "", NOW + DAY, NOW)).toBe(false);
    expect(pool.extend("nobody", mine?.address ?? "", NOW + DAY, NOW)).toBe(false);
    expect(pool.extend("owner", mine?.address ?? "", NOW + DAY, NOW)).toBe(true);

    // The extended lease outlives the short one it started as; the other does not.
    expect(pool.acquire("third", NOW + DAY, NOW + 400)?.address).toBe(theirs?.address);
    expect(pool.acquire("fourth", NOW + DAY, NOW + 400)).toBeUndefined();
  });

  it("does not extend a lease that lapsed and went to someone else", () => {
    const pool = poolOf(1);
    const first = pool.acquire("slow", NOW + 300, NOW);
    expect(pool.acquire("quick", NOW + DAY, NOW + 331)?.address).toBe(first?.address);
    expect(pool.extend("slow", first?.address ?? "", NOW + DAY, NOW + 332)).toBe(false);
  });

  it("does not revive a lapsed lease, even before anyone else asked for the channel", () => {
    const pool = poolOf(1);
    const first = pool.acquire("slow", NOW + 300, NOW);
    expect(pool.extend("slow", first?.address ?? "", NOW + DAY, NOW + 331)).toBe(false);
    expect(pool.availableCount).toBe(1);
  });

  it("refuses to exist with no channels at all", () => {
    expect(() => new ChannelPool({ channels: [] })).toThrow();
  });
});

describe("a channel pool written down and read back", () => {
  it("keeps every key and every lease, so a restart cannot hand out a live sequence", () => {
    const keys = [Keypair.random(), Keypair.random()];
    const pool = new ChannelPool({ channels: keys });
    const held = pool.acquire("held", NOW + DAY, NOW);

    const restored = ChannelPool.fromSnapshot(pool.snapshot(), NOW);
    expect(restored.leasedCount).toBe(1);
    expect(restored.availableCount).toBe(1);
    expect(restored.keypairFor("held", held?.address ?? "")?.secret()).toBe(
      keys.find((k) => k.publicKey() === held?.address)?.secret(),
    );
    expect(restored.acquire("next", NOW + DAY, NOW)?.address).not.toBe(held?.address);
  });

  it("drops a lease that lapsed while the process was down", () => {
    const pool = poolOf(1);
    pool.acquire("old", NOW + 60, NOW);
    const restored = ChannelPool.fromSnapshot(pool.snapshot(), NOW + DAY);
    expect(restored.acquire("new", NOW + DAY + DAY, NOW + DAY)).toBeDefined();
  });

  it("restores leases onto a pool it was given, for the channels that pool has", () => {
    const key = Keypair.random();
    const before = new ChannelPool({ channels: [key] });
    before.acquire("held", NOW + DAY, NOW);
    const given = new ChannelPool({ channels: [key] });
    given.restoreLeases(before.snapshot().leases, NOW);
    expect(given.acquire("other", NOW + DAY, NOW)).toBeUndefined();
  });

  it("ignores a lease on a channel the given pool does not have", () => {
    const before = poolOf(1);
    before.acquire("held", NOW + DAY, NOW);
    const given = poolOf(1);
    given.restoreLeases(before.snapshot().leases, NOW);
    expect(given.acquire("other", NOW + DAY, NOW)).toBeDefined();
  });
});

describe("a pool that grows", () => {
  it("adds a funded channel once, and leases it like any other", () => {
    const first = Keypair.random();
    const added = Keypair.random();
    const pool = new ChannelPool({ channels: [first] });
    pool.add(added);
    pool.add(added);
    pool.add(first);
    expect(pool.size).toBe(2);
    expect(pool.acquire("a", 100, 0)?.address).toBeDefined();
    expect(pool.acquire("b", 100, 0)?.address).toBeDefined();
    expect(pool.acquire("c", 100, 0)).toBeUndefined();
  });

  it("says whether an owner still holds its lease, and lets a lapsed one go", () => {
    const pool = new ChannelPool({ channels: [Keypair.random()] });
    const channel = pool.acquire("a", 100, 0);
    expect(pool.holds("a", channel?.address ?? "", 50)).toBe(true);
    expect(pool.owners(50)).toEqual(["a"]);
    expect(pool.holds("a", channel?.address ?? "", 200)).toBe(false);
    expect(pool.owners(200)).toEqual([]);
  });

  it("brings a lease's end forward, never later", () => {
    const pool = new ChannelPool({ channels: [Keypair.random()] });
    const channel = pool.acquire("a", 1_000, 0)?.address ?? "";
    pool.limit("a", channel, 2_000);
    expect(pool.holds("a", channel, 1_020)).toBe(true);
    pool.limit("a", channel, 100);
    expect(pool.holds("a", channel, 200)).toBe(false);
  });
});

describe("round 2: a lease nobody paid for", () => {
  it("is not lengthened by asking for it again", () => {
    const pool = new ChannelPool({ channels: [Keypair.random()] });
    const channel = pool.acquire("a", 100, 0)?.address ?? "";
    expect(pool.acquire("a", 10_000, 50)?.address).toBe(channel);
    expect(pool.holds("a", channel, 131)).toBe(false);
  });

  it("is kept past its bound while something on it may still land", () => {
    const pool = new ChannelPool({ channels: [Keypair.random()] });
    const channel = pool.acquire("a", 100, 0)?.address ?? "";
    let inFlight = true;
    pool.holdWhile((owner) => owner === "a" && inFlight);
    expect(pool.holds("a", channel, 500)).toBe(true);
    inFlight = false;
    expect(pool.holds("a", channel, 500)).toBe(false);
  });
});

describe("round 2: restoring two leases for one owner", () => {
  it("keeps every channel's key, and the later lease", () => {
    const first = Keypair.random();
    const second = Keypair.random();
    const pool = ChannelPool.fromSnapshot(
      {
        secrets: [first.secret(), second.secret()],
        leases: [
          { owner: "a", channel: first.publicKey(), untilUnix: 500 },
          { owner: "a", channel: second.publicKey(), untilUnix: 900 },
        ],
      },
      0,
    );
    expect(pool.size).toBe(2);
    expect(pool.snapshot().secrets).toHaveLength(2);
    expect(pool.holds("a", second.publicKey(), 0)).toBe(true);
    expect(pool.availableCount).toBe(1);
  });
});
