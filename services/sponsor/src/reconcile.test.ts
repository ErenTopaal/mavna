import { describe, expect, it } from "vitest";
import type { ChainSponsorshipView, SponsoredRecord } from "./reconcile.js";
import { reconcile } from "./reconcile.js";

const chainSaying = (slots: number, accounts: string[]): ChainSponsorshipView => ({
  totalSlotsCarried: async () => slots,
  sponsoredAccounts: async () => accounts,
});

const record = (address: string, state: SponsoredRecord["state"], slots = 3): SponsoredRecord => ({
  userAddress: address,
  slots,
  state,
});

describe("reconciliation", () => {
  it("balances when our records and the chain agree", async () => {
    const report = await reconcile(
      "GSPONSOR",
      [record("GA", "awaiting-arrival")],
      chainSaying(3, ["GA"]),
    );
    expect(report.balanced).toBe(true);
    expect(report.expectedSlots).toBe(3);
    expect(report.actualSlots).toBe(3);
  });

  it("finds capital we are carrying and did not know about", async () => {
    // The whole reason this check exists: our bookkeeping cannot catch this by
    // construction, because it does not know the account is there.
    const report = await reconcile(
      "GSPONSOR",
      [record("GA", "awaiting-arrival")],
      chainSaying(6, ["GA", "GHIDDEN"]),
    );

    expect(report.balanced).toBe(false);
    expect(report.untracked).toEqual(["GHIDDEN"]);
    expect(report.actualSlots).toBe(6);
    expect(report.expectedSlots).toBe(3);
  });

  it("finds records the chain no longer confirms", async () => {
    const report = await reconcile(
      "GSPONSOR",
      [record("GA", "awaiting-arrival")],
      chainSaying(0, []),
    );
    expect(report.stale).toEqual(["GA"]);
    expect(report.balanced).toBe(false);
  });

  it("does not count settled sponsorships as still carried", async () => {
    const report = await reconcile(
      "GSPONSOR",
      [record("GA", "settled"), record("GB", "awaiting-arrival")],
      chainSaying(3, ["GB"]),
    );
    expect(report.expectedSlots).toBe(3);
    expect(report.balanced).toBe(true);
  });

  it("counts stranded sponsorships separately, because they are a permanent loss", async () => {
    const report = await reconcile(
      "GSPONSOR",
      [record("GA", "stranded"), record("GB", "stranded")],
      chainSaying(6, ["GA", "GB"]),
    );
    expect(report.strandedCount).toBe(2);
    // Still balanced: the capital is genuinely still carried, it just will not return.
    expect(report.balanced).toBe(true);
  });
});
