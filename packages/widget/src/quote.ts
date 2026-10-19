/*
 * Real quoting for the app, wrapping @mavna/routing's raceAdapters.
 *
 * The design simulated routes with a hardcoded fee table and a fake XLM rate.
 * This asks the real rails and returns real routes, fees, floors, signature
 * counts and decline reasons. Nothing here is fabricated: every figure the UI
 * shows comes out of a Route or a RouteRejection.
 */

import { sourceUsdcFor } from "@mavna/adapter-cctp";
import {
  type Asset,
  MavnaError,
  type Route,
  type RouteRejection,
  type RouteSet,
  rejectionIsRetryable,
  type TrustModel,
} from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import { inspectDestination, readAccountEntry, spareStroops, stroopsToXlm } from "@mavna/stellar";
import { Asset as StellarAsset, StrKey } from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import { amountValue, fromBaseUnits, toBaseUnits } from "./format";
import { OWN_DELIVERY_FEE_BUDGET_STROOPS, OWN_TRUSTLINE_FEE_STROOPS } from "./own-delivery";
import type { SponsorTerms } from "./sponsor";

/** USDC carries six decimals on every source chain the rails start from. */
const USDC_DECIMALS_ON_EVM = 6;

export type RailName = "Circle" | "Axelar" | "LayerZero" | "NEAR Intents";
export type Priority = "best" | "fast";
/** USDT0 lands as itself: no conversion leg is offered for it here. */
export type Wanted = "USDC" | "XLM" | "USDT0";
/** What the user sends, as the picker names it. */
export type SendAsset = "USDC" | "USDT0";

/** Adapter id ⇄ the display name the design uses for each rail. */
const SOURCE_TO_RAIL: Readonly<Record<string, RailName>> = {
  cctp: "Circle",
  axelar: "Axelar",
  layerzero: "LayerZero",
  "near-intents": "NEAR Intents",
};
const RAIL_TO_SOURCE: Readonly<Record<RailName, string>> = {
  Circle: "cctp",
  Axelar: "axelar",
  LayerZero: "layerzero",
  "NEAR Intents": "near-intents",
};

/** Trust model as the design's short label, keyed by rail name. */
export const TRUST_LABEL: Readonly<Record<RailName, string>> = {
  Circle: "Issuer mint & burn",
  Axelar: "Validator set",
  LayerZero: "Issuer-chosen verifiers",
  "NEAR Intents": "Competing solvers",
};

export interface QuoteInputs {
  readonly chainId: string;
  readonly wanted: Wanted;
  readonly amount: string;
  readonly destination: string;
  readonly priority: Priority;
  readonly rails: Readonly<Record<RailName, boolean>>;
  /** Defaults to USDC. */
  readonly send?: SendAsset;
}

/** A route reduced to the numbers the design's cards and review screen show. */
export interface RouteView {
  readonly id: string;
  readonly route: Route;
  readonly source: RailName;
  readonly trust: string;
  readonly receives: number;
  readonly floor: number;
  readonly fee: number;
  readonly exact: boolean;
  readonly minutes: number;
  readonly sigs: number;
  readonly newAccount: boolean;
  readonly reserveXlm: number | undefined;
  /**
   * The exchange the conversion runs through, when the route has a swap leg.
   * Read off the swap step's own provider, never assumed, so a route that does
   * not convert has none and a route through a different venue shows that venue.
   */
  readonly swapVenue: string | undefined;
  /** What the transfer fee is counted in, read off the fee itself. */
  readonly feeSymbol: string;
}

export interface DeclineView {
  readonly source: string;
  readonly why: string;
  readonly retryable: boolean;
}

export function railDisplay(source: string): string {
  return SOURCE_TO_RAIL[source] ?? source;
}

/** Which adapters to race, honouring the per-session rail toggles. */
function enabledAdapters(
  adapters: Engine["adapters"],
  rails: Readonly<Record<RailName, boolean>>,
): Engine["adapters"] {
  return adapters.filter((a) => {
    const rail = SOURCE_TO_RAIL[a.id];
    return rail === undefined ? true : rails[rail] !== false;
  });
}

/** The rail names that are switched on, for the panel's "N of M" status. */
export function enabledRailCount(rails: Readonly<Record<RailName, boolean>>): number {
  return (Object.keys(RAIL_TO_SOURCE) as RailName[]).filter((r) => rails[r] !== false).length;
}

/**
 * The venue label for a swap provider id.
 *
 * Presentation only: the id comes from the route's swap step, this just prints
 * known ids the way people write them and falls back to the id itself for any
 * provider not listed, so nothing is invented and a new venue still shows.
 */
const VENUE_LABEL: Readonly<Record<string, string>> = {
  sdex: "SDEX",
  aquarius: "Aquarius",
  soroswap: "Soroswap",
  sushiswap: "SushiSwap",
};

function venueLabel(id: string): string {
  return VENUE_LABEL[id] ?? id.toUpperCase();
}

/** Map a real Route onto the view the design's screens consume. */
export function toRouteView(route: Route): RouteView {
  const bridge = route.fees.find((f) => f.kind === "bridge");
  const reserve = route.fees.find((f) => f.kind === "account-reserve");
  const swapStep = route.steps.find((s) => s.kind === "swap");
  const receives = amountValue(route.receives);
  const floor = amountValue(route.receivesAtLeast);
  return {
    id: route.id,
    route,
    source: (SOURCE_TO_RAIL[route.source] ?? route.source) as RailName,
    trust: TRUST_LABEL[(SOURCE_TO_RAIL[route.source] ?? route.source) as RailName] ?? "",
    receives,
    floor,
    fee:
      bridge === undefined ? 0 : fromBaseUnits(bridge.total.baseUnits, bridge.total.asset.decimals),
    // A native mint delivers an exact amount: receivesAtLeast equals receives.
    exact: route.receivesAtLeast.baseUnits === route.receives.baseUnits,
    minutes: Math.max(1, Math.round(route.estimatedSeconds / 60)),
    sigs: route.signaturesRequired,
    newAccount: route.steps.some((s) => s.kind === "prepare-account"),
    reserveXlm:
      reserve === undefined
        ? undefined
        : fromBaseUnits(reserve.total.baseUnits, reserve.total.asset.decimals),
    swapVenue: swapStep === undefined ? undefined : venueLabel(swapStep.source),
    feeSymbol: bridge?.total.asset.symbol ?? route.sends.asset.symbol,
  };
}

/**
 * The asset ids are token addresses, which is what the rails match on. The
 * source id used to be the chain id, which names no token at all.
 */
export function buildAssets(
  engine: Pick<Engine, "network" | "usdcOnStellar" | "xlmOnStellar">,
  chainId: string,
  wanted: Wanted,
): { from: Asset; to: Asset } {
  const usdc = sourceUsdcFor(engine.network, chainId);
  if (usdc === undefined) {
    throw new Error(`No USDC deployment is known for ${chainId}.`);
  }
  const from: Asset = {
    chainId,
    id: usdc.address,
    symbol: "USDC",
    decimals: USDC_DECIMALS_ON_EVM,
    curatedBy: "Circle",
  };
  return { from, to: wanted === "XLM" ? engine.xlmOnStellar : engine.usdcOnStellar };
}

/**
 * The assets for what the user picked to send.
 *
 * USDT0's come from the LayerZero deployment through the engine, never from a
 * symbol: the source id is the token the chain's OFT moves and the Stellar id is
 * the classic asset its Stellar token wraps. Nothing converts USDT0 here, so
 * what it lands as is what the recipient gets whatever `wanted` says.
 */
export async function assetsFor(
  engine: Pick<Engine, "network" | "usdcOnStellar" | "xlmOnStellar" | "usdt0Assets">,
  chainId: string,
  send: SendAsset,
  wanted: Wanted,
): Promise<{ from: Asset; to: Asset }> {
  if (send === "USDT0") return engine.usdt0Assets(chainId);
  return buildAssets(engine, chainId, wanted);
}

/**
 * Why a route cannot set up a new account, or undefined when it can.
 *
 * The sponsor fronts the reserve and is repaid out of what arrives, and the
 * repayment it holds spends USDC: the only asset it curates. A rail that lands
 * anything else leaves that repayment with nothing to spend, so the sponsor
 * would be out the reserve for good.
 */
export function settlementBlocker(
  route: Route,
  usdcId: string,
  reserveFunding: SponsorTerms["reserveFunding"] = "sponsor",
): string | undefined {
  if (!route.steps.some((s) => s.kind === "prepare-account")) return undefined;
  const delivers = route.deliveredAtLeast.asset;
  if (reserveFunding === "self") {
    // Nothing is lent, so nothing has to be repaid in USDC; the sponsor only
    // has to curate the trustline the account opens for itself.
    if (trustlineName(route, usdcId) !== undefined) return undefined;
    return (
      "An account paying its own reserve can only open a trustline to USDC or USDT0, " +
      `the assets the sponsor curates, and this route delivers ${delivers.symbol}.`
    );
  }
  if (delivers.id === usdcId) return undefined;
  return (
    "A new Stellar account can only be set up on a route that delivers USDC, the one asset " +
    "the sponsor curates, because its deposit is repaid in USDC from what arrives, and this " +
    `route delivers ${delivers.symbol}.`
  );
}

/**
 * The curated name the sponsor knows the route's trustline by, or undefined
 * when it curates none. The sponsor holds the issuer; the widget checks the
 * preparation it gets back against the delivered asset before anyone signs.
 */
export function trustlineName(route: Route, usdcId: string): "USDC" | "USDT0" | undefined {
  const delivers = route.deliveredAtLeast.asset.id;
  if (delivers === usdcId) return "USDC";
  if (delivers.startsWith("USDT0:")) return "USDT0";
  return undefined;
}

/** Move the routes no sponsor could settle into the declines, with the reason. */
export function declineUnsettleable(
  set: RouteSet,
  usdcId: string,
  reserveFunding: SponsorTerms["reserveFunding"] = "sponsor",
): RouteSet {
  const routes: Route[] = [];
  const rejected: RouteRejection[] = [...set.rejected];
  for (const route of set.routes) {
    const why = settlementBlocker(route, usdcId, reserveFunding);
    if (why === undefined) {
      routes.push(route);
      continue;
    }
    rejected.push({
      source: route.source,
      reason: "destination-unsupported",
      explanation: why,
      retryable: rejectionIsRetryable("destination-unsupported"),
    });
  }
  return { routes, rejected, complete: set.complete };
}

/** What quoting learned about the sponsor and the destination, once per quote. */
export interface SponsorCheck {
  /** The network this page runs on, which the sponsor must run on too. */
  readonly network: string;
  /** The sponsor's terms, or why they could not be read. */
  readonly terms: SponsorTerms | Error;
  /**
   * Whether the destination account exists. Only looked up when accounts fund
   * their own reserve, since that is the only case it changes; an error when
   * the lookup failed.
   */
  readonly destination: "exists" | "missing" | Error;
  /**
   * What the destination can spend above its minimum balance, in stroops, read
   * alongside `destination` for an ordinary account. Undefined for an address
   * that is not one, which cannot sign for its own delivery.
   */
  readonly spareStroops?: bigint | undefined;
  /** The network's base reserve, in stroops, for pricing a trustline. */
  readonly baseReserveStroops?: number;
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Why the sponsor cannot carry this route, or undefined when it can.
 *
 * Two kinds of route lean on the sponsor: a Circle transfer, which the sponsor
 * delivers on Stellar at its own cost, and a route that sets an account up. A
 * route that does neither never touches it and is never held to its terms.
 */
function sponsorBlocker(route: Route, check: SponsorCheck): RouteRejection | undefined {
  const circle = route.source === "cctp";
  const setsUp = route.steps.some((s) => s.kind === "prepare-account");
  if (!circle && !setsUp) return undefined;
  const decline = (reason: RouteRejection["reason"], explanation: string): RouteRejection => ({
    source: route.source,
    reason,
    explanation,
    retryable: rejectionIsRetryable(reason),
  });

  const { terms } = check;
  if (terms instanceof Error) {
    return decline(
      "temporarily-unavailable",
      `This route needs the sponsor service, which could not be asked just now: ${message(terms)}`,
    );
  }
  if (terms.network !== check.network) {
    return decline(
      "chain-unsupported",
      `The sponsor this page is set up with runs on ${terms.network}, and this page runs on ` +
        `${check.network}, so it cannot carry this route.`,
    );
  }

  if (setsUp && terms.reserveFunding === "self") {
    if (check.destination instanceof Error) {
      return decline(
        "temporarily-unavailable",
        `Whether the receiving account exists could not be checked: ${message(check.destination)}`,
      );
    }
    const holds = route.deliveredAtLeast.asset.symbol;
    if (check.destination === "missing") {
      return decline(
        "destination-unsupported",
        "That Stellar account does not exist yet, and right now an account pays its own " +
          "reserve, which an address with nothing in it cannot do. Send it at least 1.5 XLM " +
          `first (1 to exist, 0.5 to hold ${holds}), or send to an account that already exists.`,
      );
    }
    // Circle routes add their delivery fee to this and are checked below; any
    // other rail needs only the trustline's reserve and fee, known now, so it is
    // declined here rather than refused by the sponsor after the user chose it.
    const reserve = BigInt(check.baseReserveStroops ?? 0) + OWN_TRUSTLINE_FEE_STROOPS;
    if (!circle && check.spareStroops !== undefined && check.spareStroops < reserve) {
      const spare = check.spareStroops > 0n ? check.spareStroops : 0n;
      return decline(
        "destination-unsupported",
        "Right now an account pays its own reserve: " +
          `${stroopsToXlm(BigInt(check.baseReserveStroops ?? 0))} XLM to hold ${holds}, plus ` +
          `a small fee, and this one has ${stroopsToXlm(spare)} XLM to spare. Add XLM to it, ` +
          "or send to an account that can already hold it.",
      );
    }
  }

  if (circle && terms.reserveFunding === "self") {
    const blocked = ownDeliveryBlocker(route, check, setsUp);
    if (blocked !== undefined) return decline(blocked[0], blocked[1]);
  }

  // The minimum guards the sponsor's XLM, and an account paying for its own
  // delivery spends none of it.
  if (circle && terms.reserveFunding === "sponsor" && terms.minDeliveryBaseUnits > 0n) {
    // What the sponsor will see minted: what is sent less Circle's fee, in the
    // source token's units, against a minimum stated at six decimals.
    const decimals = route.sends.asset.decimals;
    const scale = (units: bigint): bigint =>
      decimals >= 6 ? units * 10n ** BigInt(decimals - 6) : units / 10n ** BigInt(6 - decimals);
    const fee = route.fees.find((f) => f.kind === "bridge")?.total.baseUnits ?? "0";
    const minted = BigInt(route.sends.baseUnits) - BigInt(fee);
    if (minted < scale(terms.minDeliveryBaseUnits)) {
      const minimum = fromBaseUnits(terms.minDeliveryBaseUnits.toString(), 6);
      return decline(
        "amount-too-small",
        `The sponsor delivers Circle transfers that arrive as at least ${minimum} USDC, ` +
          "since delivering costs it the same whatever the amount. Send a little more.",
      );
    }
  }
  return undefined;
}

/**
 * Why the receiving account cannot pay for Circle's delivery on Stellar, when
 * it must. It signs and pays `mint_and_forward` itself, so it has to be an
 * account that exists, can sign, and can spare the fee, and the trustline's
 * reserve too when it opens one first.
 */
function ownDeliveryBlocker(
  route: Route,
  check: SponsorCheck,
  setsUp: boolean,
): [RouteRejection["reason"], string] | undefined {
  if (check.destination instanceof Error) {
    return [
      "temporarily-unavailable",
      `Whether the receiving account can pay for its delivery could not be checked: ${message(check.destination)}`,
    ];
  }
  const pays =
    "Right now the receiving account pays for Circle's delivery on Stellar from its own XLM";
  if (check.destination === "missing") {
    return [
      "destination-unsupported",
      `${pays}, and that account does not exist yet. Send it some XLM first, or send to an ` +
        "account that already exists.",
    ];
  }
  if (check.spareStroops === undefined) {
    return [
      "destination-unsupported",
      `${pays}, which needs an ordinary G account that can sign for itself. Send to one, or ` +
        "pick another route.",
    ];
  }
  const reserve = setsUp ? BigInt(check.baseReserveStroops ?? 0) + OWN_TRUSTLINE_FEE_STROOPS : 0n;
  if (check.spareStroops >= OWN_DELIVERY_FEE_BUDGET_STROOPS + reserve) return undefined;
  const holds = route.deliveredAtLeast.asset.symbol;
  const spare = check.spareStroops > 0n ? check.spareStroops : 0n;
  return [
    "destination-unsupported",
    `${pays}: up to ${stroopsToXlm(OWN_DELIVERY_FEE_BUDGET_STROOPS)} XLM` +
      (setsUp
        ? `, plus ${stroopsToXlm(BigInt(check.baseReserveStroops ?? 0))} XLM to hold ${holds}`
        : "") +
      `, and it has ${stroopsToXlm(spare)} XLM to spare. Add XLM to it, or pick another route.`,
  ];
}

/** Move the routes the sponsor cannot carry into the declines, with the reason. */
export function applySponsorTerms(set: RouteSet, check: SponsorCheck): RouteSet {
  const routes: Route[] = [];
  const rejected: RouteRejection[] = [...set.rejected];
  // an account that pays its own Circle delivery also signs it, one more
  // approval than the rail counted
  const ownDelivery = !(check.terms instanceof Error) && check.terms.reserveFunding === "self";
  for (const route of set.routes) {
    const blocked = sponsorBlocker(route, check);
    if (blocked !== undefined) rejected.push(blocked);
    else if (ownDelivery && route.source === "cctp") {
      routes.push({ ...route, signaturesRequired: route.signaturesRequired + 1 });
    } else routes.push(route);
  }
  return { routes, rejected, complete: set.complete };
}

/** Ask the sponsor for its terms, and the network for the destination if they need it. */
async function checkSponsor(
  engine: Pick<Engine, "network" | "rpc" | "usdcIssuer" | "sponsorTerms" | "baseReserveStroops">,
  destination: string,
): Promise<SponsorCheck> {
  let terms: SponsorTerms | Error;
  try {
    terms = await engine.sponsorTerms();
  } catch (cause) {
    terms = cause instanceof Error ? cause : new Error(String(cause));
  }
  let found: SponsorCheck["destination"] = "exists";
  let spare: bigint | undefined;
  const { baseReserveStroops } = engine;
  if (!(terms instanceof Error) && terms.reserveFunding === "self") {
    try {
      const state = await inspectDestination(
        engine.rpc,
        destination,
        new StellarAsset("USDC", engine.usdcIssuer),
      );
      found = state.lane.kind === "needs-account" ? "missing" : "exists";
      // Only an ordinary account can sign for and pay its own delivery.
      if (found === "exists" && StrKey.isValidEd25519PublicKey(destination)) {
        const entry = await readAccountEntry(engine.rpc, destination);
        if (entry === undefined) found = "missing";
        else spare = spareStroops(entry, baseReserveStroops);
      }
    } catch (cause) {
      found = cause instanceof Error ? cause : new Error(String(cause));
    }
  }
  return {
    network: engine.network,
    terms,
    destination: found,
    spareStroops: spare,
    baseReserveStroops,
  };
}

export interface QuoteRun {
  cancel(): void;
}

/**
 * Ask the enabled rails for this transfer. `onUpdate` fires as each rail lands,
 * `onDone` once with the complete set. Returns a handle whose cancel() makes any
 * later callback a no-op, so a superseded quote never writes stale routes.
 */
export function runQuote(
  engine: Pick<
    Engine,
    | "network"
    | "usdcOnStellar"
    | "xlmOnStellar"
    | "adapters"
    | "breaker"
    | "xlmSwap"
    | "integratorFee"
    | "rpc"
    | "usdcIssuer"
    | "sponsorTerms"
    | "usdt0Assets"
    | "baseReserveStroops"
  >,
  inputs: QuoteInputs,
  onUpdate: (set: RouteSet) => void,
  onDone: (set: RouteSet) => void,
  /** Told what the sponsor said, before any route arrives. */
  onSponsor?: (check: SponsorCheck) => void,
): QuoteRun {
  let live = true;
  const send = inputs.send ?? "USDC";
  // only asks whether there is anything to send; the amount is counted in the
  // source token's own decimals once that token is known
  if (BigInt(toBaseUnits(inputs.amount, USDC_DECIMALS_ON_EVM)) <= 0n) {
    const empty: RouteSet = { routes: [], rejected: [], complete: true };
    onUpdate(empty);
    onDone(empty);
    return {
      cancel: () => {
        live = false;
      },
    };
  }

  const adapters = enabledAdapters(engine.adapters, inputs.rails);
  const handle: QuoteRun = {
    cancel: () => {
      live = false;
    },
  };

  const usdc = engine.usdcOnStellar.id;
  const destination = inputs.destination.trim();

  // Nothing can be asked without the source token, and every enabled rail is
  // owed the reason rather than a picker that quietly shows nothing.
  const declineAll = (cause: unknown): void => {
    const explanation = cause instanceof Error ? cause.message : String(cause);
    // A node that did not answer is not a chain with no route.
    const reason =
      cause instanceof MavnaError && cause.retryable
        ? ("temporarily-unavailable" as const)
        : ("asset-unsupported" as const);
    const declined: RouteSet = {
      routes: [],
      rejected: adapters.map((a) => ({
        source: a.id,
        reason,
        explanation,
        retryable: rejectionIsRetryable(reason),
      })),
      complete: true,
    };
    onUpdate(declined);
    onDone(declined);
  };

  const race = ({ from, to }: { from: Asset; to: Asset }): void => {
    // The sponsor's terms come first, so no route it cannot carry is ever shown
    // and then taken back. They are cached on the engine after the first answer.
    void checkSponsor(engine, destination)
      .then((check) => {
        if (!live) return undefined;
        onSponsor?.(check);
        // An unreadable answer is declined by the sponsor terms anyway.
        const funding = check.terms instanceof Error ? "sponsor" : check.terms.reserveFunding;
        const settle = (set: RouteSet): RouteSet =>
          applySponsorTerms(declineUnsettleable(set, usdc, funding), check);
        return raceAdapters(
          adapters,
          {
            from,
            to,
            sends: { asset: from, baseUnits: toBaseUnits(inputs.amount, from.decimals) },
            destination,
            maxSlippageBps: 50,
          },
          {
            onUpdate: (partial) => {
              if (live) onUpdate(settle(partial));
            },
            breaker: engine.breaker,
            // the XLM leg converts arrived USDC, so it only rides on a USDC send
            swap: inputs.wanted === "XLM" && send === "USDC" ? engine.xlmSwap : undefined,
            ranking: inputs.priority === "fast" ? "fastest" : "best-received",
            // No transaction builder pays a fee out yet, so nothing may be shown as
            // taken. Revisit when a collector exists for a route.
            integratorFee:
              engine.integratorFee === undefined
                ? undefined
                : { ...engine.integratorFee, collects: () => false },
          },
        ).then((final) => settle(final));
      })
      .then(
        (final) => {
          if (live && final !== undefined) onDone(final);
        },
        () => {
          // A total failure still resolves to a complete, empty set for the UI.
          if (live) onDone({ routes: [], rejected: [], complete: true });
        },
      );
  };

  if (send === "USDT0") {
    engine.usdt0Assets(inputs.chainId).then(
      (assets) => {
        if (live) race(assets);
      },
      (cause: unknown) => {
        if (live) declineAll(cause);
      },
    );
    return handle;
  }

  let assets: { from: Asset; to: Asset };
  try {
    assets = buildAssets(engine, inputs.chainId, inputs.wanted);
  } catch (cause) {
    declineAll(cause);
    return handle;
  }
  race(assets);

  return handle;
}

export type { Route, RouteRejection, RouteSet, TrustModel };
