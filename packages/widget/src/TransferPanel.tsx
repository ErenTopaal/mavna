import type { Amount, Fee, FeeKind, Remedy, Route } from "@mavna/core";
import { type ReactElement, type RefObject, useEffect, useRef } from "react";
import { DraftScale, type ScaleStep } from "./DraftScale.js";
import { formatAmount } from "./format.js";
import { explainTrust } from "./RouteList.js";

/**
 * The whole widget: what you get, what it costs, and where it is.
 *
 * Two rules shape everything below. The primary number is what ARRIVES, never
 * what is sent, because that is the figure a user is actually deciding on. And
 * nothing is deducted silently: if we do something with their money, the line
 * item says so in words they did not have to learn.
 */

export interface TransferPanelProps {
  readonly route: Route;
  /** Present once the transfer is under way. Absent means it is still a quote. */
  readonly steps: readonly ScaleStep[] | undefined;
  readonly outcome: "succeeded" | "refunded" | "partial" | "failed" | "in-flight";
  readonly onConfirm: (() => void) | undefined;
  readonly onRemedy: ((stepId: string, remedy: Remedy) => void) | undefined;
  readonly theme: "light" | "dark" | undefined;
}

export function TransferPanel(props: TransferPanelProps): ReactElement {
  const { route, steps, outcome, onConfirm, onRemedy, theme } = props;
  const started = steps !== undefined;
  const finished = outcome !== "in-flight";
  const root = useRef<HTMLDivElement>(null);

  useStylesheetWarning(root);

  const landed = settledAmount(outcome, route, steps);

  return (
    <div className="mv-root" data-mv-theme={theme} ref={root}>
      <section className="mv-panel">
        <div>
          <p className="mv-eyebrow">{headline(outcome, route)}</p>
          {landed === undefined ? (
            <p className="mv-receives mv-receives-none">Nothing arrived</p>
          ) : (
            <p className="mv-receives">
              {formatAmount(landed)}
              <span className="mv-receives-symbol">{landed.asset.symbol}</span>
            </p>
          )}
          {/* A floor is a promise about a transfer that has not happened yet.
              Repeating it over a finished one describes nothing. */}
          {finished ? null : <p className="mv-floor">{floorLine(route)}</p>}
        </div>

        {/* Nothing was charged, so listing charges would invent them. */}
        {outcome === "failed" ? null : (
          <dl className="mv-fees">
            {route.fees.map((fee) => (
              <FeeLine key={fee.kind} fee={fee} explain={!started} />
            ))}
          </dl>
        )}

        {/*
          Told once, upfront, and only while it is still true. A finished or
          returned transfer will not ask for anything, so promising approvals on
          one is a lie the interface tells about its own state.
        */}
        {finished ? null : (
          <p className="mv-signatures">
            {route.signaturesRequired === 0 ? (
              "Nothing left to approve."
            ) : (
              <>
                {"You will approve "}
                <strong>{`${route.signaturesRequired} ${route.signaturesRequired === 1 ? "step" : "steps"}`}</strong>
                {" in your wallet."}
              </>
            )}
          </p>
        )}

        {/* Shown here because the panel is often the only thing on screen: with a
            single route there is no list beside it, and "who could hold my money"
            is not a question to answer only when there is a choice. */}
        {started ? null : <p className="mv-trust">{explainTrust(route.trustModel)}</p>}

        {/* The theme is handed down rather than left for the scale to work out.
            The scale scopes its own tokens, so nested inside this panel it would
            otherwise start a second root that follows the machine while this one
            follows what the host said, and the two would disagree. */}
        {started ? (
          <DraftScale steps={steps} outcome={outcome} onRemedy={onRemedy} theme={theme} />
        ) : null}

        {started || onConfirm === undefined ? null : (
          <button type="button" className="mv-confirm" onClick={onConfirm}>
            {`Send ${formatAmount(route.sends)} ${route.sends.asset.symbol}`}
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * Say so, in development, when the stylesheet was never imported.
 *
 * The widget ships its CSS as a separate file, which means forgetting to import
 * it renders every state unstyled and throws nothing: no error, no warning, no
 * console entry. It looks like a broken component rather than a missing import,
 * and it cost an afternoon here before this existed.
 *
 * `process.env.NODE_ENV` is compared explicitly so a consumer's bundler folds the
 * whole check away in production rather than shipping it to their users.
 */
function useStylesheetWarning(root: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const node = root.current;
    if (node === null) return;
    const loaded = getComputedStyle(node).getPropertyValue("--mv-loaded").trim();
    if (loaded !== "") return;
    console.warn(
      '[mavna] The widget is rendering without its stylesheet. Add `import "@mavna/widget/widget.css"` ' +
        "once, anywhere in your app. Styles are shipped as a separate file so they can be replaced.",
    );
  }, [root]);
}

/**
 * What the user actually ended up with.
 *
 * While a transfer is in flight this is the quote, because that is the claim
 * being made. Once it settles it MUST become what really happened: a returned
 * transfer that headlines the quoted amount reads as money received, and a
 * partial delivery that headlines the full amount is simply wrong. This is the
 * single most consequential number in the widget and it is the easiest one to
 * leave stale.
 */
export function settledAmount(
  outcome: TransferPanelProps["outcome"],
  route: Route,
  steps: readonly ScaleStep[] | undefined,
): Amount | undefined {
  if (outcome === "in-flight" || steps === undefined) return route.receives;
  if (outcome === "succeeded") return route.receives;
  if (outcome === "failed") return undefined;

  for (const step of steps) {
    if (outcome === "partial" && step.phase.phase === "partial") return step.phase.received;
    if (outcome === "refunded" && step.phase.phase === "refunded") return step.phase.returned;
  }
  return undefined;
}

function FeeLine({ fee, explain }: { readonly fee: Fee; readonly explain: boolean }): ReactElement {
  return (
    <>
      <dt className="mv-fee-name" data-mv-fee={fee.kind}>
        {FEE_NAMES[fee.kind]}
      </dt>
      <dd className="mv-fee-amount" data-mv-fee={fee.kind}>
        {`${formatAmount(fee.total)} ${fee.total.asset.symbol}`}
      </dd>
      {/* A second <dd> against the same <dt>, which is valid and keeps the note
          a grid item so it can span both columns.

          Shown while the user is deciding, which is when it changes anything.
          The line item itself never disappears, so the deduction is never
          silent; only the explanation of it stands down once it is moot. */}
      {fee.kind === "account-reserve" && explain ? (
        <dd className="mv-fee-note">
          Stellar locks this in your own account so it can hold assets. It is yours, and it comes
          back if you ever close the account.
        </dd>
      ) : null}
    </>
  );
}

/**
 * Fee names in the user's vocabulary, not the protocol's.
 *
 * "Bridge fee" and "gas" name mechanisms this product exists to hide. And the
 * reserve is not a fee at all, so calling it one would overstate the cost of the
 * transfer by the one line item the user gets back.
 */
const FEE_NAMES: Readonly<Record<FeeKind, string>> = {
  bridge: "Transfer",
  swap: "Conversion",
  gas: "Network",
  integrator: "Service",
  "account-reserve": "Kept in your account",
};

/**
 * What the quoted amount is worth as a promise.
 *
 * "At least 25 USDC" above a figure of 25 reads as a hedge, and on a rail that
 * mints exactly what it burns there is nothing to hedge against. Saying so is
 * worth more than a floor: no slippage is a real difference between routes, and
 * a user comparing them cannot see it if every route says the same cautious
 * sentence.
 */
function floorLine(route: Route): string {
  const exact = route.receivesAtLeast.baseUnits === route.receives.baseUnits;
  if (exact) return "Exactly this much. This route cannot deliver less.";
  return `At least ${formatAmount(route.receivesAtLeast)} ${route.receivesAtLeast.asset.symbol}, or the transfer does not go through.`;
}

function headline(outcome: TransferPanelProps["outcome"], route: Route): string {
  switch (outcome) {
    case "succeeded":
      return "Arrived";
    case "refunded":
      return "Returned";
    case "partial":
      return "Partly delivered";
    case "failed":
      return "Did not go through";
    case "in-flight":
      return `You receive on ${route.toChain.name}`;
  }
}
