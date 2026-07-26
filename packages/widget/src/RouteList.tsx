import type { Route, RouteRejection, RouteSet, TrustModel } from "@mavna/core";
import type { ReactElement } from "react";
import { formatAmount } from "./format.js";

/**
 * Choosing between rails.
 *
 * Two requirements shape this and both come from the same place: a user has to
 * be able to weigh a route without knowing the vocabulary, and has to be able to
 * see WHY a route is missing rather than watching it quietly not appear.
 *
 * So the trust model is a sentence, not a badge with a tooltip behind it. Badges
 * are how this category currently ships it, and a badge reading "Validator Set"
 * transfers no information to anyone who did not already know what that means.
 * The person deciding whether to send their money is exactly the person who
 * does not know.
 */

export interface RouteListProps {
  readonly routes: RouteSet;
  readonly selectedId: string | undefined;
  readonly onSelect: (routeId: string) => void;
  /** Undefined follows the machine, which is right when nobody has said. */
  readonly theme?: "light" | "dark" | undefined;
}

/**
 * This carries its own `mv-root` rather than assuming one is above it.
 *
 * Every token the stylesheet defines lives on that class, so rendering this
 * without one resolves `--mv-ink` to nothing and the list quietly inherits the
 * host page's colours instead of its own. That is not a visible error, it is
 * near-black text on a dark page, and it shipped exactly that way in our own app
 * because the playground happened to wrap it and the app did not. A component
 * that can be rendered on its own has to scope itself.
 */
export function RouteList({ routes, selectedId, onSelect, theme }: RouteListProps): ReactElement {
  return (
    <div className="mv-root mv-routes" data-mv-theme={theme}>
      <ul className="mv-route-options">
        {routes.routes.map((route) => (
          <li key={route.id}>
            <button
              type="button"
              className="mv-route"
              aria-pressed={route.id === selectedId}
              onClick={() => {
                onSelect(route.id);
              }}
            >
              <span className="mv-route-amount">
                {formatAmount(route.receives)}
                <span className="mv-route-symbol">{route.receives.asset.symbol}</span>
              </span>
              <span className="mv-route-meta">{summarise(route)}</span>
              <span className="mv-route-trust">{TRUST[route.trustModel]}</span>
            </button>
          </li>
        ))}
      </ul>

      {/*
        Rejections are shown, always. A route that is missing because the amount
        is below a floor looks identical to one that is missing because the whole
        rail is down, and the difference decides whether the user should change
        the amount or come back later.
      */}
      {routes.rejected.length === 0 ? null : (
        <ul className="mv-route-rejections">
          {routes.rejected.map((rejection) => (
            <li key={`${rejection.source}-${rejection.reason}`} className="mv-route-rejection">
              <span className="mv-route-rejection-source">{rejection.source}</span>
              {rejection.explanation}
            </li>
          ))}
        </ul>
      )}

      {routes.complete ? null : <p className="mv-route-pending">Still asking other routes.</p>}
    </div>
  );
}

/**
 * How a rail is trusted, in words that carry the actual risk.
 *
 * Each of these answers "who could take my money, and when". That is the only
 * question the trust model is really about, so it is the one answered here.
 */
const TRUST: Readonly<Record<TrustModel, string>> = {
  "native-mint": "The issuer destroys and reissues it. Nobody holds your money in between.",
  "validator-set": "A named group of validators has to agree before it is released.",
  "solver-network": "Someone fronts you the money and claims it back later.",
  "liquidity-pool": "A shared pool holds both sides and swaps between them.",
};

function summarise(route: Route): string {
  const minutes = Math.max(1, Math.round(route.estimatedSeconds / 60));
  const signatures =
    route.signaturesRequired === 1 ? "1 approval" : `${route.signaturesRequired} approvals`;
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} · ${signatures}`;
}

/** Exported so an app can reuse the same wording outside the widget. */
export function explainTrust(model: TrustModel): string {
  return TRUST[model];
}

/** Exported for the same reason: the app's history view says this too. */
export function describeRejection(rejection: RouteRejection): string {
  return `${rejection.source}: ${rejection.explanation}`;
}
