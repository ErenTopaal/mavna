import { describe, expect, it, vi } from "vitest";
import { DeliveryBudget } from "./delivery-budget.js";
import { MemoryDocumentStore } from "./state.js";

const XLM = 10_000_000n;

describe("the daily budget for deliveries the sponsor pays", () => {
  it("lets reservations through until the day's budget would be passed", async () => {
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 5n * XLM, () => "2026-10-20");
    expect(await budget.reserve(2n * XLM)).toBeDefined();
    expect(await budget.reserve(2n * XLM)).toBeDefined();
    expect(await budget.reserve(2n * XLM)).toBeUndefined();
    expect(await budget.spentToday()).toBe(4n * XLM);
  });

  it("counts what a delivery was charged, not what was set aside for it", async () => {
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 5n * XLM, () => "2026-10-20");
    const reservation = await budget.reserve(2n * XLM);
    await reservation?.settle(130_000n);
    expect(await budget.spentToday()).toBe(130_000n);
    // a refused send cost nothing
    await (await budget.reserve(2n * XLM))?.release();
    expect(await budget.spentToday()).toBe(130_000n);
  });

  it("keeps the count across a restart, and starts afresh each UTC day", async () => {
    const store = new MemoryDocumentStore();
    let day = "2026-10-20";
    await (await new DeliveryBudget(store, 5n * XLM, () => day).reserve(4n * XLM))?.settle(
      4n * XLM,
    );
    const restarted = new DeliveryBudget(store, 5n * XLM, () => day);
    expect(await restarted.reserve(2n * XLM)).toBeUndefined();
    day = "2026-10-21";
    expect(await restarted.reserve(2n * XLM)).toBeDefined();
  });

  it("does not let reservations made at once together pass the budget", async () => {
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 5n * XLM, () => "2026-10-20");
    const granted = await Promise.all([1, 2, 3, 4].map(() => budget.reserve(2n * XLM)));
    expect(granted.filter((r) => r !== undefined)).toHaveLength(2);
  });

  it("counts today as spent when its record is unreadable, and starts afresh tomorrow", async () => {
    const store = new MemoryDocumentStore();
    await store.write("delivery-spend", { "2026-10-20": "lots" });
    let day = "2026-10-20";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const budget = new DeliveryBudget(store, 5n * XLM, () => day);
    expect(await budget.reserve(1n)).toBeUndefined();
    errors.mockRestore();
    expect(await store.read("delivery-spend-rejected")).toEqual({ "2026-10-20": "lots" });
    day = "2026-10-21";
    expect(await budget.reserve(1n)).toBeDefined();
  });

  it("pays for nothing with a budget of zero", async () => {
    const budget = new DeliveryBudget(new MemoryDocumentStore(), 0n, () => "2026-10-20");
    expect(await budget.reserve(1n)).toBeUndefined();
  });
});
