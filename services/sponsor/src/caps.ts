import { MavnaError } from "@mavna/core";

/**
 * The two caps from resources/cost_decision.md §11.
 *
 * One cap cannot do this job. Sized for real traffic it permits far more loss
 * than intended; sized to bound loss it throttles legitimate users. Losses only
 * occur when a sponsorship strands, and legitimate transfers settle, so volume
 * and exposure are capped separately.
 */

export type SourceChainClass = "expensive-gas" | "cheap-gas";

export interface CapConfig {
  /**
   * Sponsorships that may strand in a day before sponsorship halts globally.
   * This is the exposure brake and the only real control over the one attack
   * that cannot be prevented.
   */
  readonly strandingCapPerDay: number;
  /**
   * Sponsorships that may be started in a day, per source-chain class. Split
   * because attack economics differ by two orders of magnitude: an attacker on
   * an expensive chain spends more than they destroy and is self-limiting.
   */
  readonly volumeCapPerDay: Readonly<Record<SourceChainClass, number>>;
}

/**
 * Starting values, derived rather than chosen. See cost_decision.md §11.2:
 * 75 strandings at the worst-lane loss of about $0.32 bounds the day at ~$24,
 * and 500 sponsorships is ten times expected early traffic.
 */
export const DEFAULT_CAPS: CapConfig = {
  strandingCapPerDay: 75,
  volumeCapPerDay: { "expensive-gas": 300, "cheap-gas": 200 },
};

export type CapDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly cap: "volume" | "stranding" };

export interface CapUsage {
  readonly day: string;
  readonly started: Readonly<Record<SourceChainClass, number>>;
  readonly stranded: number;
}

/**
 * Persistence is deliberately an interface rather than a choice made here. A cap
 * that does not survive a restart is not a cap, so this must be backed by
 * something durable in production, but the counting logic should not care which.
 */
export interface CapStore {
  load(day: string): Promise<CapUsage | undefined>;
  save(usage: CapUsage): Promise<void>;
}

export class InMemoryCapStore implements CapStore {
  private readonly days = new Map<string, CapUsage>();

  async load(day: string): Promise<CapUsage | undefined> {
    return this.days.get(day);
  }

  async save(usage: CapUsage): Promise<void> {
    this.days.set(usage.day, usage);
  }
}

const emptyUsage = (day: string): CapUsage => ({
  day,
  started: { "expensive-gas": 0, "cheap-gas": 0 },
  stranded: 0,
});

export class CapLedger {
  private readonly store: CapStore;
  private readonly config: CapConfig;
  /** Injected so the day boundary is testable rather than tied to the clock. */
  private readonly today: () => string;
  /**
   * Every count is a read then a write, so two at once would both read the
   * same number and one would be lost. They go through here one at a time.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(store: CapStore, config: CapConfig = DEFAULT_CAPS, today: () => string = utcDay) {
    this.store = store;
    this.config = config;
    this.today = today;
  }

  /**
   * Ask before committing capital. Both caps are checked, and the answer carries
   * a reason the interface can show a user, because being refused without an
   * explanation is worse than being refused.
   */
  async check(source: SourceChainClass): Promise<CapDecision> {
    const usage = (await this.store.load(this.today())) ?? emptyUsage(this.today());

    if (usage.stranded >= this.config.strandingCapPerDay) {
      return {
        allowed: false,
        cap: "stranding",
        reason:
          "Account setup is paused for today while we look into an unusual number of " +
          "incomplete transfers. Transfers to accounts that already exist are unaffected.",
      };
    }

    if (usage.started[source] >= this.config.volumeCapPerDay[source]) {
      return {
        allowed: false,
        cap: "volume",
        reason:
          "Account setup from this network has reached today's limit. " +
          "Try again tomorrow, or send to an address that already exists.",
      };
    }

    return { allowed: true };
  }

  /** Record that capital was committed. Called after preparation lands, not before. */
  recordStarted(source: SourceChainClass): Promise<void> {
    return this.inTurn(async () => {
      const day = this.today();
      const usage = (await this.store.load(day)) ?? emptyUsage(day);
      await this.store.save({
        ...usage,
        started: { ...usage.started, [source]: usage.started[source] + 1 },
      });
    });
  }

  /**
   * Record a sponsorship that will never be recovered. This is the number that
   * matters: it drives the exposure brake and it is a permanent loss, so it is
   * reported as a line item rather than left implicit.
   */
  recordStranded(): Promise<void> {
    return this.inTurn(async () => {
      const day = this.today();
      const usage = (await this.store.load(day)) ?? emptyUsage(day);
      await this.store.save({ ...usage, stranded: usage.stranded + 1 });
    });
  }

  /** Run after every count asked for before it, whether those worked or not. */
  private inTurn(count: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => {}).then(count);
    this.queue = next;
    return next;
  }

  async usage(): Promise<CapUsage> {
    return (await this.store.load(this.today())) ?? emptyUsage(this.today());
  }
}

/**
 * Classify a source chain by what an attack from it costs. Gas of a few cents
 * means the attacker's cost approaches what they freeze, so those chains get the
 * tighter allocation.
 */
export function classifySourceChain(
  chain: string,
  cheapGasChains: ReadonlySet<string>,
): SourceChainClass {
  if (chain.length === 0) {
    throw new MavnaError("Source chain is required to apply a cap.", { retryable: false });
  }
  const counterpart = Object.hasOwn(TESTNET_COUNTERPART, chain)
    ? (TESTNET_COUNTERPART[chain] as string)
    : chain;
  return cheapGasChains.has(counterpart) ? "cheap-gas" : "expensive-gas";
}

/**
 * Testnet chains, by the ids the CCTP adapter gives them, against the mainnet
 * chain they stand in for. Testnet gas is free everywhere, so the class has to
 * come from the chain being rehearsed. Several land on mainnet ids that are not
 * in the cheap set, which classes them expensive exactly as on mainnet.
 */
export const TESTNET_COUNTERPART: Readonly<Record<string, string>> = {
  "base-sepolia": "base",
  "arbitrum-sepolia": "arbitrum",
  "optimism-sepolia": "optimism",
  "polygon-amoy": "polygon",
  "avalanche-fuji": "avalanche",
  "unichain-sepolia": "unichain",
  "linea-sepolia": "linea",
  "world-chain-sepolia": "world-chain",
  "ink-sepolia": "ink",
  "x-layer-sepolia": "x-layer",
  "ethereum-sepolia": "ethereum",
  "solana-devnet": "solana",
  "starknet-sepolia": "starknet",
};

/**
 * Chains where gas is cents rather than dollars, so the gas cost of an attack is
 * not a meaningful deterrent. Configuration, because it changes as fees move.
 */
export const DEFAULT_CHEAP_GAS_CHAINS: ReadonlySet<string> = new Set([
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "solana",
  "unichain",
  "linea",
]);

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
