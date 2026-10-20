import { EVM_DEPLOYMENTS, NON_EVM_CHAINS } from "@mavna/adapter-cctp";
import { describe, expect, it } from "vitest";
import {
  CapLedger,
  type CapUsage,
  classifySourceChain,
  DEFAULT_CHEAP_GAS_CHAINS,
  InMemoryCapStore,
  TESTNET_COUNTERPART,
} from "./caps.js";

const tinyCaps = {
  strandingCapPerDay: 2,
  volumeCapPerDay: { "expensive-gas": 3, "cheap-gas": 1 } as const,
};

function ledgerOn(day: string): CapLedger {
  return new CapLedger(new InMemoryCapStore(), tinyCaps, () => day);
}

describe("volume cap", () => {
  it("allows up to the per-chain-class limit, then refuses with a reason", async () => {
    const ledger = ledgerOn("2026-08-11");

    expect((await ledger.check("cheap-gas")).allowed).toBe(true);
    await ledger.recordStarted("cheap-gas");

    const refused = await ledger.check("cheap-gas");
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.cap).toBe("volume");
      // A user who is refused must be told what to do instead.
      expect(refused.reason).toMatch(/already exists/);
    }
  });

  it("keeps the classes independent, so cheap-chain abuse cannot starve the rest", async () => {
    const ledger = ledgerOn("2026-08-11");
    await ledger.recordStarted("cheap-gas");

    expect((await ledger.check("cheap-gas")).allowed).toBe(false);
    expect((await ledger.check("expensive-gas")).allowed).toBe(true);
  });
});

describe("stranding cap", () => {
  it("halts sponsorship globally once the exposure brake trips", async () => {
    const ledger = ledgerOn("2026-08-11");
    await ledger.recordStranded();
    await ledger.recordStranded();

    for (const source of ["cheap-gas", "expensive-gas"] as const) {
      const decision = await ledger.check(source);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.cap).toBe("stranding");
    }
  });

  it("takes precedence over the volume cap, because it bounds money not traffic", async () => {
    const ledger = ledgerOn("2026-08-11");
    await ledger.recordStranded();
    await ledger.recordStranded();

    const decision = await ledger.check("expensive-gas");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.cap).toBe("stranding");
  });
});

describe("the day boundary", () => {
  it("counts per day, so yesterday's usage does not block today", async () => {
    const store = new InMemoryCapStore();
    let day = "2026-08-11";
    const ledger = new CapLedger(store, tinyCaps, () => day);

    await ledger.recordStarted("cheap-gas");
    expect((await ledger.check("cheap-gas")).allowed).toBe(false);

    day = "2026-08-12";
    expect((await ledger.check("cheap-gas")).allowed).toBe(true);
  });
});

describe("source chain classification", () => {
  it("puts the cheap-gas chains in the tighter bucket", () => {
    expect(classifySourceChain("base", DEFAULT_CHEAP_GAS_CHAINS)).toBe("cheap-gas");
    expect(classifySourceChain("arbitrum", DEFAULT_CHEAP_GAS_CHAINS)).toBe("cheap-gas");
    // Gas of a dollar or more makes an attack cost more than it destroys.
    expect(classifySourceChain("ethereum", DEFAULT_CHEAP_GAS_CHAINS)).toBe("expensive-gas");
  });

  it("classes a testnet chain as its mainnet counterpart", () => {
    // What the app sends on testnet. Classing these all as expensive would give
    // testnet a looser cap than the mainnet it rehearses.
    for (const id of [
      "base-sepolia",
      "arbitrum-sepolia",
      "optimism-sepolia",
      "polygon-amoy",
      "unichain-sepolia",
      "linea-sepolia",
      "solana-devnet",
    ]) {
      expect(classifySourceChain(id, DEFAULT_CHEAP_GAS_CHAINS), id).toBe("cheap-gas");
    }
    for (const id of ["ethereum-sepolia", "avalanche-fuji", "starknet-sepolia"]) {
      expect(classifySourceChain(id, DEFAULT_CHEAP_GAS_CHAINS), id).toBe("expensive-gas");
    }
  });

  it("maps only real testnet ids onto real mainnet ids", () => {
    const testnet = new Set([
      ...Object.keys(EVM_DEPLOYMENTS.testnet),
      ...Object.keys(NON_EVM_CHAINS.testnet),
    ]);
    const mainnet = new Set([
      ...Object.keys(EVM_DEPLOYMENTS.mainnet),
      ...Object.keys(NON_EVM_CHAINS.mainnet),
    ]);
    for (const [from, to] of Object.entries(TESTNET_COUNTERPART)) {
      expect(testnet.has(from), from).toBe(true);
      expect(mainnet.has(to), to).toBe(true);
    }
    for (const id of DEFAULT_CHEAP_GAS_CHAINS) expect(mainnet.has(id), id).toBe(true);
  });

  it("refuses to classify an unnamed chain rather than defaulting", () => {
    expect(() => classifySourceChain("", DEFAULT_CHEAP_GAS_CHAINS)).toThrow();
  });
});

describe("usage reporting", () => {
  it("exposes stranded count, because a permanent loss must stay visible", async () => {
    const ledger = ledgerOn("2026-08-11");
    await ledger.recordStranded();
    await ledger.recordStarted("expensive-gas");

    const usage = await ledger.usage();
    expect(usage.stranded).toBe(1);
    expect(usage.started["expensive-gas"]).toBe(1);
  });
});

describe("counts recorded at the same moment", () => {
  /** A store whose reads and writes take a turn of the event loop, like a disk. */
  class SlowStore extends InMemoryCapStore {
    override async load(day: string): Promise<CapUsage | undefined> {
      await new Promise((r) => setTimeout(r, 2));
      return super.load(day);
    }
    override async save(usage: CapUsage): Promise<void> {
      await new Promise((r) => setTimeout(r, 2));
      return super.save(usage);
    }
  }

  it("loses neither a start nor a stranding recorded together", async () => {
    const ledger = new CapLedger(new SlowStore(), tinyCaps, () => "2026-10-20");
    await Promise.all([
      ledger.recordStarted("cheap-gas"),
      ledger.recordStranded(),
      ledger.recordStranded(),
      ledger.recordStarted("expensive-gas"),
    ]);
    const usage = await ledger.usage();
    expect(usage.stranded).toBe(2);
    expect(usage.started).toEqual({ "cheap-gas": 1, "expensive-gas": 1 });
  });
});
