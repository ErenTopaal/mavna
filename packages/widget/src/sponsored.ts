/*
 * The two transactions a sponsor that fronts the reserve asks the user to sign:
 * the preparation that opens the account, and the settlement that repays it
 * from what arrives. The user's key signs both as the sponsor returned them, so
 * each is read against what this transfer needs before the wallet is asked.
 * The honest shapes are the ones @mavna/stellar's sponsorship builders make.
 */
import type { Route } from "@mavna/core";
import { xlmToStroops } from "@mavna/stellar";
import {
  FeeBumpTransaction,
  type Operation,
  Asset as StellarAsset,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signerOf } from "./recipient";

/** What a changeTrust with no limit given reads back as: the largest Int64 in stroops. */
const DEFAULT_TRUST_LIMIT = "922337203685.4775807";
/** The sponsor builds its preparation with a 300 second bound. */
const PREPARATION_MAX_SECONDS = 600;
/** The sponsor holds a settlement for a day; a little longer is clock skew, not a standing grant. */
const SETTLEMENT_MAX_SECONDS = 86_400 + 600;

/**
 * Headroom over the sponsor's own ceiling, for the price moving between its read
 * of the order book and this page's, a few seconds apart.
 */
const PRICE_DRIFT_BPS = 500n;

/**
 * The most a settlement buying back `destStroops` of XLM may spend, in base
 * units of the paying asset: twice its worth at the mid price, as the sponsor
 * builds it, with a little headroom, rounded up.
 */
export function repaymentCeiling(
  destStroops: bigint,
  xlmStroopsPerUnit: bigint,
  decimals: number,
): bigint {
  if (xlmStroopsPerUnit <= 0n) return 0n;
  const num = destStroops * 2n * 10n ** BigInt(decimals) * (10_000n + PRICE_DRIFT_BPS);
  const den = xlmStroopsPerUnit * 10_000n;
  return (num + den - 1n) / den;
}

function fmtUnitsPlain(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? (baseUnits / scale).toString() : `${baseUnits / scale}.${fraction}`;
}

type Parsed = Exclude<ReturnType<typeof TransactionBuilder.fromXDR>, FeeBumpTransaction>;

function parse(xdr: string, passphrase: string): Parsed | undefined {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXdr(xdr, passphrase);
  } catch {
    return undefined;
  }
  return parsed instanceof FeeBumpTransaction ? undefined : parsed;
}

function boundedBy(tx: Parsed, seconds: number): boolean {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  return maxTime !== 0 && maxTime <= Math.floor(Date.now() / 1000) + seconds;
}

/** An operation run by the transaction's own source, which is the sponsor's, not the user's. */
function sourcedBy(op: { readonly source?: string | undefined }, tx: Parsed): boolean {
  return op.source === undefined || op.source === tx.source;
}

/**
 * Why a sponsored preparation is not the one this transfer needs, or undefined.
 *
 * It must be: the sponsor begins sponsoring the receiving account, optionally
 * creates it with nothing in it, the account opens one trustline to what the
 * route delivers at the default limit, and ends the sponsorship. Nothing else,
 * and nothing the account pays for.
 */
export function preparationProblem(
  xdr: string,
  passphrase: string,
  /** The account being opened, and the asset it must be able to hold. */
  wanted: { readonly destination: string; readonly holds: Route["deliveredAtLeast"]["asset"] },
): string | undefined {
  const tx = parse(xdr, passphrase);
  if (tx === undefined) return "it could not be read";
  // a muxed address is prepared as the account it wraps, which holds the balance
  const account = signerOf(wanted.destination) ?? wanted.destination;
  const holds = wanted.holds;
  if (tx.source === account) return "it would be paid for by the receiving account";
  if (!boundedBy(tx, PREPARATION_MAX_SECONDS)) return "it is not limited to a few minutes";
  const ops = [...tx.operations];
  const begin = ops.shift();
  if (
    begin?.type !== "beginSponsoringFutureReserves" ||
    begin.sponsoredId !== account ||
    !sourcedBy(begin, tx)
  ) {
    return "it does not sponsor the receiving account";
  }
  if (ops[0]?.type === "createAccount") {
    const create = ops.shift() as Operation.CreateAccount;
    if (
      create.destination !== account ||
      xlmToStroops(create.startingBalance) !== 0n ||
      !sourcedBy(create, tx)
    ) {
      return "it creates an account other than the receiving one, or funds it";
    }
  }
  const trust = ops.shift();
  if (
    trust?.type !== "changeTrust" ||
    trust.source !== account ||
    !(trust.line instanceof StellarAsset) ||
    trust.line.toString() !== holds.id ||
    trust.limit !== DEFAULT_TRUST_LIMIT
  ) {
    return `it does not open the ${holds.symbol} trustline this transfer delivers into`;
  }
  const end = ops.shift();
  if (end?.type !== "endSponsoringFutureReserves" || end.source !== account) {
    return "it does not end the sponsorship it began";
  }
  if (ops.length > 0) return "it does more than open the account";
  return undefined;
}

/**
 * Read a held settlement, and say what it may take of the arrival.
 *
 * It must be: the receiving account buys back, for itself, at most the reserve
 * the route quoted, in XLM, paying in what the route delivers and no more than
 * part of what arrives; then the sponsor hands back its claims on that account.
 * Built on the sponsor's channel, so the account pays no fee and spends no
 * sequence of its own.
 */
export function readSettlement(
  xdr: string,
  passphrase: string,
  route: Pick<Route, "destination" | "deliveredAtLeast" | "fees">,
  channel: string,
  /**
   * The order book's mid price for what arrives, in stroops per whole unit: the
   * figure the sponsor builds its ceiling from, twice the buy-back's worth.
   */
  xlmStroopsPerUnit: bigint,
): { readonly sendMax: bigint } | { readonly problem: string } {
  const tx = parse(xdr, passphrase);
  if (tx === undefined) return { problem: "it could not be read" };
  // the account a muxed address wraps is the one that repays
  const account = signerOf(route.destination) ?? route.destination;
  const holds = route.deliveredAtLeast.asset;
  const reserve = route.fees.find((f) => f.kind === "account-reserve");
  if (reserve === undefined) {
    return { problem: "this route does not say what reserve it is repaying" };
  }
  if (tx.source !== channel || tx.source === account) {
    return { problem: "it is not built on the sponsor's own channel" };
  }
  if (!boundedBy(tx, SETTLEMENT_MAX_SECONDS)) return { problem: "it does not expire within a day" };
  const [buy, ...rest] = tx.operations;
  if (
    buy?.type !== "pathPaymentStrictReceive" ||
    buy.source !== account ||
    buy.destination !== account ||
    !buy.destAsset.isNative() ||
    buy.path.length > 0 ||
    buy.sendAsset.toString() !== holds.id
  ) {
    return { problem: "its repayment is not the receiving account buying back its own reserve" };
  }
  if (xlmToStroops(buy.destAmount) > BigInt(reserve.total.baseUnits)) {
    return { problem: "it buys back more XLM than the reserve this route quoted" };
  }
  const sendMax = xlmToStroops(buy.sendMax);
  if (sendMax >= BigInt(route.deliveredAtLeast.baseUnits)) {
    return { problem: `it may spend as much ${holds.symbol} as the whole transfer brings in` };
  }
  // the quote offered this setup on that same ceiling, so nothing above it is signed
  const ceiling = repaymentCeiling(xlmToStroops(buy.destAmount), xlmStroopsPerUnit, holds.decimals);
  if (sendMax > ceiling) {
    return {
      problem:
        "it may spend more than twice the reserve's worth at the order book's price " +
        `(at most ${fmtUnitsPlain(ceiling, holds.decimals)} ${holds.symbol}), which is what ` +
        "this setup was offered on",
    };
  }
  let accountReleased = false;
  for (const op of rest) {
    if (op.source === undefined || op.source === account) {
      return { problem: "it asks the receiving account for more than the repayment" };
    }
    if (
      op.type === "revokeTrustlineSponsorship" &&
      op.account === account &&
      op.asset instanceof StellarAsset &&
      op.asset.toString() === holds.id
    ) {
      continue;
    }
    if (op.type === "revokeAccountSponsorship" && op.account === account && !accountReleased) {
      accountReleased = true;
      continue;
    }
    return { problem: "it does more than repay the reserve and release the sponsorship" };
  }
  return { sendMax };
}
