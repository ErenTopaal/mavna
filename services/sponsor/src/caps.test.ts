import { describe, expect, it } from "vitest";
import {
  CapLedger,
  classifySourceChain,
  DEFAULT_CHEAP_GAS_CHAINS,
  InMemoryCapStore,
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
