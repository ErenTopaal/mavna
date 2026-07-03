/**
 * Amounts and assets.
 *
 * Two rules govern this file and neither bends. Amounts are integers in base
 * units carried as strings, because floating point on money is a defect. And an
 * asset is identified by code AND issuer, never code alone, because anyone can
 * issue a token called USDC and treating the code as identity is a phishing
 * vector that will eventually be used.
 */

/** A chain this product can move value from or to. */
export interface ChainRef {
  /** Stable identifier we choose, not a third party's. */
  readonly id: string;
  readonly name: string;
  /** Where a transaction on this chain can be looked at. */
  readonly explorerTxUrl: (hash: string) => string;
}

export interface Asset {
  /** Unambiguous identity: chain plus the chain's own notion of the asset. */
  readonly chainId: string;
  /**
   * On Stellar this is `CODE:ISSUER` or `native`; on an EVM chain the contract
   * address. Never a bare symbol, which is not an identity.
   */
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Who vouches for this asset appearing in a list a user picks from. */
  readonly curatedBy: string | undefined;
}

/** An amount of a specific asset. The pair travels together so they cannot drift apart. */
export interface Amount {
  readonly asset: Asset;
  /** Integer in the asset's base units. A string, never a number. */
  readonly baseUnits: string;
}

export function amountOf(asset: Asset, baseUnits: string): Amount {
  if (!/^\d+$/.test(baseUnits)) {
    throw new TypeError(`Amount must be a non-negative integer in base units: ${baseUnits}`);
  }
  return { asset, baseUnits };
}

/** Whether two assets are the same thing, by identity rather than by symbol. */
export function sameAsset(a: Asset, b: Asset): boolean {
  return a.chainId === b.chainId && a.id === b.id;
}

/**
 * Who receives a fee and how much.
 *
 * An array from the outset, deliberately. The most mature product in this space
 * shipped a two-party fee split, outgrew it, and had to bolt an array on beside
 * the original fields, which their own code comments now describe as legacy kept
 * for backward compatibility. Starting with the general shape costs nothing.
 */
export interface FeeRecipient {
  readonly name: string;
  readonly amount: Amount;
  /** Where it goes, when that is knowable and worth showing. */
  readonly address: string | undefined;
}

export type FeeKind =
  | "bridge"
  | "swap"
  | "gas"
  | "integrator"
  /**
   * The Stellar deposit. Not a fee taken from the user: it becomes XLM locked in
   * their own account as their reserve, returning to them if they ever close it.
   * Named separately so the interface can say so rather than overstating the cost.
   */
  | "account-reserve";

export interface Fee {
  readonly kind: FeeKind;
  readonly total: Amount;
  readonly recipients: readonly FeeRecipient[];
  /** True when this is already deducted from the quoted output. */
  readonly includedInQuote: boolean;
}
