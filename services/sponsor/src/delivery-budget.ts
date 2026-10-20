import * as z from "zod";
import type { DocumentStore } from "./state.js";

/**
 * What the sponsor may spend on delivery fees in one UTC day.
 *
 * Anyone can ask the sponsor to deliver an attested Circle burn into Stellar,
 * and every delivery costs the sponsor's XLM whatever it carries. The minimum
 * size and the per-address limit slow that down; this bounds it, so a stream
 * of burns from many addresses cannot drain the funded key in a day.
 *
 * A delivery sets its largest possible fee aside before it is signed, and the
 * setting aside is on disk before anything is sent, so a crash counts it in
 * full. Once the network says what was charged, the count comes down to that.
 */

/** One delivery's share of the budget, set aside until its fee is known. */
export interface BudgetReservation {
  /** The delivery was charged this much, at most what was set aside. */
  settle(chargedStroops: bigint): Promise<void>;
  /** Nothing reached the network, so nothing was charged. */
  release(): Promise<void>;
}

/** How many days of counts are kept. Only today's is read. */
const DAYS_KEPT = 3;

const DOCUMENT = "delivery-spend";
const stored = z.record(z.string(), z.string().regex(/^\d+$/));

export class DeliveryBudget {
  private readonly store: DocumentStore;
  private readonly dailyStroops: bigint;
  private readonly today: () => string;
  /** Every change is a read then a write, so they go one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: DocumentStore, dailyStroops: bigint, today: () => string = utcDay) {
    if (dailyStroops < 0n) {
      throw new Error(`A delivery budget cannot be negative; got ${dailyStroops}.`);
    }
    this.store = store;
    this.dailyStroops = dailyStroops;
    this.today = today;
  }

  /**
   * Set `stroops` aside for one delivery, or undefined when that would pass
   * today's budget and the delivery must not be paid for.
   */
  reserve(stroops: bigint): Promise<BudgetReservation | undefined> {
    return this.inTurn(async () => {
      const day = this.today();
      const days = await this.days();
      const spent = days[day] ?? 0n;
      if (spent + stroops > this.dailyStroops) return undefined;
      await this.save({ ...days, [day]: spent + stroops });
      let done = false;
      const giveBack = (unspent: bigint): Promise<void> => {
        if (done) return Promise.resolve();
        done = true;
        return this.inTurn(async () => {
          const now = await this.days();
          const current = now[day] ?? 0n;
          await this.save({ ...now, [day]: current > unspent ? current - unspent : 0n });
        });
      };
      return {
        settle: (charged) => giveBack(stroops - (charged < stroops ? charged : stroops)),
        release: () => giveBack(stroops),
      };
    });
  }

  /** What today's deliveries have been charged or have set aside. */
  async spentToday(): Promise<bigint> {
    return (await this.days())[this.today()] ?? 0n;
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }

  private async days(): Promise<Record<string, bigint>> {
    const value = await this.store.read(DOCUMENT);
    if (value === undefined) return {};
    const parsed = stored.safeParse(value);
    if (!parsed.success) {
      // Today counts as spent in full rather than as nothing spent, since a
      // budget that forgets on a bad file is no budget. The bad copy is kept
      // aside and replaced, so tomorrow starts afresh.
      console.error(
        "[sponsor] the delivery spend state is not in the shape this version writes; " +
          `today counts as spent, and the file is kept as ${DOCUMENT}-rejected`,
      );
      await this.store.write(`${DOCUMENT}-rejected`, value);
      const reset = { [this.today()]: this.dailyStroops };
      await this.save(reset);
      return reset;
    }
    return Object.fromEntries(
      Object.entries(parsed.data).map(([day, stroops]) => [day, BigInt(stroops)]),
    );
  }

  private async save(days: Record<string, bigint>): Promise<void> {
    const kept = Object.keys(days).sort().slice(-DAYS_KEPT);
    await this.store.write(
      DOCUMENT,
      Object.fromEntries(kept.map((day) => [day, (days[day] ?? 0n).toString()])),
    );
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
