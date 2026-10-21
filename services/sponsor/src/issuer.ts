import { MavnaError } from "@mavna/core";
import type { Asset } from "@stellar/stellar-sdk";

/**
 * Whether an asset's issuer makes every new trustline wait for its approval.
 *
 * With `auth_required` set, a trustline the sponsor opens starts unauthorized,
 * so nothing can be paid into it until the issuer authorizes it: the arrival
 * fails, and the reserve lent for that line is never repaid. Issuers can turn
 * the flag on at any time (unless `auth_immutable`), so it is read from the
 * ledger rather than written down.
 */
export interface IssuerFlags {
  authRequired(asset: Asset): Promise<boolean>;
}

export interface HorizonIssuerFlagsOptions {
  readonly horizonUrl: string;
  /** How long one answer is reused, in milliseconds. A minute by default. */
  readonly ttlMs?: number;
}

interface Cached {
  readonly atMs: number;
  readonly answer: Promise<boolean>;
}

/**
 * The issuer account's flags, from Horizon's account endpoint. Reused briefly
 * so a burst of requests asks once; a failed read is not kept.
 */
export class HorizonIssuerFlags implements IssuerFlags {
  private readonly horizonUrl: string;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, Cached>();

  constructor(options: HorizonIssuerFlagsOptions) {
    if (!options.horizonUrl.startsWith("https://")) {
      throw new MavnaError("Horizon base URL must be https.", { retryable: false });
    }
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  authRequired(asset: Asset): Promise<boolean> {
    const issuer = asset.getIssuer();
    if (issuer === undefined) {
      return Promise.reject(new MavnaError("XLM has no issuer to read.", { retryable: false }));
    }
    const now = Date.now();
    const cached = this.cache.get(issuer);
    if (cached !== undefined && now - cached.atMs < this.ttlMs) return cached.answer;
    const answer = this.read(asset, issuer);
    const entry = { atMs: now, answer };
    this.cache.set(issuer, entry);
    answer.catch(() => {
      if (this.cache.get(issuer) === entry) this.cache.delete(issuer);
    });
    return answer;
  }

  private async read(asset: Asset, issuer: string): Promise<boolean> {
    const named = `${asset.getCode()}'s issuer`;
    // short, because /health waits on it and the widget gives /health a few seconds
    const response = await fetch(`${this.horizonUrl}/accounts/${issuer}`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new MavnaError(`Horizon could not read ${named} (HTTP ${response.status}).`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const body = (await response.json()) as { flags?: { auth_required?: unknown } };
    const required = body.flags?.auth_required;
    if (typeof required !== "boolean") {
      throw new MavnaError(`Horizon's answer for ${named} has no flags.`, { retryable: true });
    }
    return required;
  }
}
