import { MavnaError } from "@mavna/core";
import type { Asset } from "@stellar/stellar-sdk";

/**
 * What XLM is worth, read from Stellar's own order book.
 *
 * The floors in `cost_decision.md` §9 are derived from the live reserve cost and
 * the live XLM price, so that they track the market rather than being constants
 * somebody has to remember to edit. That needs a price, and a price has to come
 * from somewhere real.
 *
 * It comes from Stellar's built-in exchange, which is the right source for three
 * reasons. It is the market this transfer actually settles against, so it is the
 * rate that decides whether the sponsorship is recoverable. It needs no API key
 * and no account with anybody. And it is on the same network as everything else
 * here, so it cannot disagree with the chain the way an external feed can.
 *
 * Horizon rather than RPC because RPC has no order book: every candidate method
 * returns "method not found", confirmed by probing them. The project owner lifted
 * the prohibition on Horizon for exactly this class of use.
 */

/** Enough of Horizon's order book response to price one asset. */
interface OrderBook {
  readonly bids?: readonly { readonly price?: string }[];
  readonly asks?: readonly { readonly price?: string }[];
}

const STROOPS_PER_XLM = 10_000_000n;

export interface PriceOptions {
  /** Horizon's base URL. Network-resolved, never hardcoded to one network. */
  readonly horizonUrl: string;
  /**
   * How stale a cached price may be. A price moving between quote and settlement
   * is ordinary; one that is an hour old is a different number entirely.
   */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * How many stroops of XLM one whole unit of an asset buys.
 *
 * Returned as an integer in stroops rather than a decimal, because every amount
 * in this codebase is an integer in base units and a float here would be a float
 * in the middle of deciding whether somebody's transfer is large enough.
 */
export class XlmPriceSource {
  private readonly horizonUrl: string;
  private readonly maxAgeMs: number;
  private readonly cache = new Map<string, { readonly at: number; readonly stroops: bigint }>();

  constructor(options: PriceOptions) {
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * The mid price, from the best bid and the best ask.
   *
   * The mid rather than either side, because this is not a trade: nothing is
   * being executed against this number. It decides whether a transfer clears a
   * floor, and taking the worse side would refuse transfers that are in fact
   * large enough while taking the better side would accept ones that are not.
   *
   * A one-sided book is refused rather than priced off the side that exists. A
   * market with no bids has no price, and inventing one here would be inventing
   * the very number the floor depends on.
   */
  async xlmStroopsPerUnit(asset: Asset): Promise<bigint> {
    const key = `${asset.getCode()}:${asset.getIssuer()}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < this.maxAgeMs) {
      return cached.stroops;
    }

    const issuer = asset.getIssuer();
    if (issuer === undefined || issuer === "") {
      // The native asset priced against itself is one, and asking the order book
      // for that would be asking a market that does not exist.
      return STROOPS_PER_XLM;
    }

    const params = new URLSearchParams({
      selling_asset_type: "native",
      buying_asset_type: asset.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      buying_asset_code: asset.getCode(),
      buying_asset_issuer: issuer,
      limit: "1",
    });

    const response = await fetch(`${this.horizonUrl}/order_book?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new MavnaError(`Could not read the order book (HTTP ${response.status}).`, {
        retryable: response.status >= 500,
      });
    }

    const book = (await response.json()) as OrderBook;
    // Selling XLM for the asset, so a price is the asset per one XLM.
    const bid = book.bids?.[0]?.price;
    const ask = book.asks?.[0]?.price;
    if (bid === undefined || ask === undefined) {
      throw new MavnaError(
        `Stellar's market for ${asset.getCode()} has no price right now, so a minimum ` +
          "transfer size cannot be worked out. Nothing has been sent.",
        { retryable: true },
      );
    }

    const assetPerXlm = (Number(bid) + Number(ask)) / 2;
    if (!Number.isFinite(assetPerXlm) || assetPerXlm <= 0) {
      throw new MavnaError("Stellar's market returned a price that is not a number.", {
        retryable: true,
      });
    }

    // Inverted, because callers hold an amount of the asset and want its worth in
    // XLM. Rounded to stroops at the end, so the only imprecision is the last
    // stroop of a price rather than anywhere in an amount.
    const stroops = BigInt(Math.round(Number(STROOPS_PER_XLM) / assetPerXlm));
    if (stroops <= 0n) {
      throw new MavnaError("Stellar's market priced this asset at effectively zero XLM.", {
        retryable: true,
      });
    }

    this.cache.set(key, { at: Date.now(), stroops });
    return stroops;
  }
}
