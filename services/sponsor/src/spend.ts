import { MavnaError } from "@mavna/core";
import type { Asset } from "@stellar/stellar-sdk";

/**
 * What a settlement's path payment would spend right now, read from Horizon.
 *
 * The settlement is signed with a ceiling of twice the reserve's value, and a
 * balance check against that ceiling turns away an arrival that would settle
 * comfortably: one between the reserve's value and twice it never settles and
 * strands after a day. The trade the network will run is the settlement's own
 * direct path (no hops), so that path's quote is the number that decides.
 *
 * Horizon rather than RPC because RPC has no order book or path finding, the
 * same reason the price source reads Horizon.
 */
export interface SpendQuoteOptions {
  readonly horizonUrl: string;
}

interface PathRecord {
  readonly source_amount?: unknown;
  readonly path?: unknown;
}

export class DirectSpendQuote {
  private readonly horizonUrl: string;

  constructor(options: SpendQuoteOptions) {
    if (!options.horizonUrl.startsWith("https://")) {
      throw new MavnaError("Horizon base URL must be https.", { retryable: false });
    }
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
  }

  /**
   * Stroops of `sendAsset` the direct path spends to receive `destXlm` XLM
   * (Horizon's decimal form), or undefined when the market has no direct path.
   */
  async directSpendStroops(sendAsset: Asset, destXlm: string): Promise<bigint | undefined> {
    const params = new URLSearchParams({
      source_assets: `${sendAsset.getCode()}:${sendAsset.getIssuer()}`,
      destination_asset_type: "native",
      destination_amount: destXlm,
    });
    const response = await fetch(`${this.horizonUrl}/paths/strict-receive?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new MavnaError(`Horizon could not quote the settlement (HTTP ${response.status}).`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const body = (await response.json()) as { _embedded?: { records?: readonly PathRecord[] } };
    const direct = (body._embedded?.records ?? []).find(
      (record) => Array.isArray(record.path) && record.path.length === 0,
    );
    if (direct === undefined) return undefined;
    if (typeof direct.source_amount !== "string") {
      throw new MavnaError("Horizon's quote for the settlement has no amount.", {
        retryable: true,
      });
    }
    return stroopsOf(direct.source_amount);
  }
}

function stroopsOf(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (match === null) {
    throw new MavnaError(`Horizon quoted an amount that is not one: ${amount}`, {
      retryable: true,
    });
  }
  return BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}
