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
  type Route,
  type RouteRejection,
  type RouteSet,
  rejectionIsRetryable,
  type TrustModel,
} from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import type { Engine } from "./engine";
import { amountValue, fromBaseUnits, toBaseUnits } from "./format";

/** USDC carries six decimals on every source chain the rails start from. */
const USDC_DECIMALS_ON_EVM = 6;

export type RailName = "Circle" | "Axelar" | "LayerZero";
export type Priority = "best" | "fast";
export type Wanted = "USDC" | "XLM";

/** Adapter id ⇄ the display name the design uses for each rail. */
const SOURCE_TO_RAIL: Readonly<Record<string, RailName>> = {
  cctp: "Circle",
  axelar: "Axelar",
  layerzero: "LayerZero",
};
const RAIL_TO_SOURCE: Readonly<Record<RailName, string>> = {
  Circle: "cctp",
  Axelar: "axelar",
  LayerZero: "layerzero",
};

/** Trust model as the design's short label, keyed by rail name. */
export const TRUST_LABEL: Readonly<Record<RailName, string>> = {
  Circle: "Issuer mint & burn",
  Axelar: "Validator set",
  LayerZero: "Issuer-chosen verifiers",
};

export interface QuoteInputs {
  readonly chainId: string;
  readonly wanted: Wanted;
  readonly amount: string;
  readonly destination: string;
  readonly priority: Priority;
  readonly rails: Readonly<Record<RailName, boolean>>;
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
 * Why a route cannot set up a new account, or undefined when it can.
 *
 * The sponsor fronts the reserve and is repaid out of what arrives, and the
 * repayment it holds spends USDC: the only asset it curates. A rail that lands
 * anything else leaves that repayment with nothing to spend, so the sponsor
 * would be out the reserve for good.
 */
export function settlementBlocker(route: Route, usdcId: string): string | undefined {
  if (!route.steps.some((s) => s.kind === "prepare-account")) return undefined;
  const delivers = route.deliveredAtLeast.asset;
  if (delivers.id === usdcId) return undefined;
  return (
    "A new Stellar account can only be set up on a route that delivers USDC, because its " +
    `deposit is repaid in USDC from what arrives, and this route delivers ${delivers.symbol}.`
  );
}

/** Move the routes no sponsor could settle into the declines, with the reason. */
export function declineUnsettleable(set: RouteSet, usdcId: string): RouteSet {
  const routes: Route[] = [];
  const rejected: RouteRejection[] = [...set.rejected];
  for (const route of set.routes) {
    const why = settlementBlocker(route, usdcId);
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
  >,
  inputs: QuoteInputs,
  onUpdate: (set: RouteSet) => void,
  onDone: (set: RouteSet) => void,
): QuoteRun {
  let live = true;
  const amountBase = toBaseUnits(inputs.amount, USDC_DECIMALS_ON_EVM);
  if (BigInt(amountBase) <= 0n) {
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

  let assets: { from: Asset; to: Asset };
  try {
    assets = buildAssets(engine, inputs.chainId, inputs.wanted);
  } catch (cause) {
    // Nothing can be asked without the source token, and every enabled rail is
    // owed the reason rather than a picker that quietly shows nothing.
    const explanation = cause instanceof Error ? cause.message : String(cause);
    const declined: RouteSet = {
      routes: [],
      rejected: adapters.map((a) => ({
        source: a.id,
        reason: "asset-unsupported" as const,
        explanation,
        retryable: rejectionIsRetryable("asset-unsupported"),
      })),
      complete: true,
    };
    onUpdate(declined);
    onDone(declined);
    return handle;
  }
  const { from, to } = assets;
  const usdc = engine.usdcOnStellar.id;

  void raceAdapters(
    adapters,
    {
      from,
      to,
      sends: { asset: from, baseUnits: amountBase },
      destination: inputs.destination.trim(),
      maxSlippageBps: 50,
    },
    {
      onUpdate: (partial) => {
        if (live) onUpdate(declineUnsettleable(partial, usdc));
      },
      breaker: engine.breaker,
      swap: inputs.wanted === "XLM" ? engine.xlmSwap : undefined,
      ranking: inputs.priority === "fast" ? "fastest" : "best-received",
      // No transaction builder pays a fee out yet, so nothing may be shown as
      // taken. Revisit when a collector exists for a route.
      integratorFee:
        engine.integratorFee === undefined
          ? undefined
          : { ...engine.integratorFee, collects: () => false },
    },
  ).then(
    (final) => {
      if (live) onDone(declineUnsettleable(final, usdc));
    },
    () => {
      // A total failure still resolves to a complete, empty set for the UI.
      if (live) onDone({ routes: [], rejected: [], complete: true });
    },
  );

  return handle;
}

export type { Route, RouteRejection, RouteSet, TrustModel };
