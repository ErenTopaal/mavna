import { MavnaError } from "@mavna/core";

/**
 * Reconciliation, per resources/cost_decision.md §7.
 *
 * Our own records are primary: we created every sponsored account, so we know
 * which ones should exist, and their state reads back one at a time with no index
 * and no Horizon.
 *
 * Horizon answers a different and narrower question: is there anything on-chain
 * that our records do NOT know about? That catches a class of bug our own
 * bookkeeping cannot catch by construction, namely capital we are carrying and
 * have lost track of.
 *
 * This is a cross-check, not a dependency. The product functions without it and
 * degrades to "no independent audit" rather than to broken. It does need the
 * project specification's blanket prohibition on Horizon amended to permit this
 * one out-of-band use, or the two documents contradict each other.
 */

export interface SponsoredRecord {
  readonly userAddress: string;
  /** Reserve slots we believe we are carrying for this account. */
  readonly slots: number;
  readonly state: "awaiting-arrival" | "settled" | "stranded";
}

export interface ReconciliationReport {
  /** Slots our records say we are carrying. */
  readonly expectedSlots: number;
  /** Slots the chain says we are carrying. */
  readonly actualSlots: number;
  /**
   * Accounts the chain says we sponsor that our records do not mention. Each is
   * capital we are carrying and did not know about, which is the whole reason
   * this check exists.
   */
  readonly untracked: readonly string[];
  /**
   * Accounts our records claim but the chain does not confirm. Usually means a
   * settlement landed and our record was not updated.
   */
  readonly stale: readonly string[];
  /** Sponsorships we know will never be recovered. Reported, never hidden. */
  readonly strandedCount: number;
  readonly balanced: boolean;
}

export interface ChainSponsorshipView {
  /** numSponsoring on the sponsor account: total slots carried. */
  totalSlotsCarried(sponsorAddress: string): Promise<number>;
  /** Accounts the chain says this sponsor is carrying. */
  sponsoredAccounts(sponsorAddress: string): Promise<readonly string[]>;
}

/**
 * Compare what we think we are carrying against what the chain says. A divergence
 * means we have lost track of capital, which is the failure this is built to
 * surface rather than a routine difference to tolerate.
 */
export async function reconcile(
  sponsorAddress: string,
  records: readonly SponsoredRecord[],
  chain: ChainSponsorshipView,
): Promise<ReconciliationReport> {
  const open = records.filter((record) => record.state !== "settled");
  const expectedSlots = open.reduce((total, record) => total + record.slots, 0);

  const [actualSlots, onChain] = await Promise.all([
    chain.totalSlotsCarried(sponsorAddress),
    chain.sponsoredAccounts(sponsorAddress),
  ]);

  const known = new Set(open.map((record) => record.userAddress));
  const seen = new Set(onChain);

  const untracked = onChain.filter((address) => !known.has(address));
  const stale = [...known].filter((address) => !seen.has(address));

  return {
    expectedSlots,
    actualSlots,
    untracked,
    stale,
    strandedCount: records.filter((record) => record.state === "stranded").length,
    balanced: expectedSlots === actualSlots && untracked.length === 0 && stale.length === 0,
  };
}

/**
 * Horizon-backed view. Deliberately the only place Horizon appears, and only for
 * the cross-check: Stellar RPC has no index that can answer "what does this
 * account sponsor", so there is no RPC alternative for this specific question.
 */
export class HorizonSponsorshipView implements ChainSponsorshipView {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl.startsWith("https://")) {
      throw new MavnaError("Horizon base URL must be https.", { retryable: false });
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async totalSlotsCarried(sponsorAddress: string): Promise<number> {
    const account = await this.fetchJson(`/accounts/${sponsorAddress}`);
    return Number(account.num_sponsoring ?? 0);
  }

  async sponsoredAccounts(sponsorAddress: string): Promise<readonly string[]> {
    const found: string[] = [];
    let url: string | undefined = `/accounts?sponsor=${sponsorAddress}&limit=200`;

    // Paginated deliberately: a sponsor carrying many accounts is exactly the case
    // where truncating the answer would hide the capital we are looking for.
    while (url !== undefined) {
      const page = await this.fetchJson(url);
      const embedded = page._embedded as { records?: { account_id?: string }[] } | undefined;
      const records = embedded?.records ?? [];
      for (const record of records) {
        if (record.account_id !== undefined) found.push(record.account_id);
      }
      const next = (page._links as { next?: { href?: string } } | undefined)?.next?.href;
      url = records.length > 0 && next !== undefined ? next.replace(this.baseUrl, "") : undefined;
    }

    return found;
  }

  private async fetchJson(path: string): Promise<Record<string, unknown>> {
    const response = await fetch(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new MavnaError(`Horizon returned ${response.status} for ${path}`, {
        retryable: response.status >= 500,
      });
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
