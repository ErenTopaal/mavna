import type { Fee, FeeKind, Remedy, Route } from "@mavna/core";
import type { ReactElement } from "react";
import { DraftScale, type ScaleStep } from "./DraftScale.js";
import { formatAmount } from "./format.js";

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

  return (
    <div className="mv-root" data-mv-theme={theme}>
      <section className="mv-panel">
        <div>
          <p className="mv-eyebrow">{headline(outcome, route)}</p>
          <p className="mv-receives">
            {formatAmount(route.receives)}
            <span className="mv-receives-symbol">{route.receives.asset.symbol}</span>
          </p>
          <p className="mv-floor">
            {`At least ${formatAmount(route.receivesAtLeast)} ${route.receivesAtLeast.asset.symbol}, or the transfer does not go through.`}
          </p>
        </div>

        <dl className="mv-fees">
          {route.fees.map((fee) => (
            <FeeLine key={fee.kind} fee={fee} />
          ))}
        </dl>

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

        {started ? <DraftScale steps={steps} outcome={outcome} onRemedy={onRemedy} /> : null}

        {started || onConfirm === undefined ? null : (
          <button type="button" className="mv-confirm" onClick={onConfirm}>
            {`Send ${formatAmount(route.sends)} ${route.sends.asset.symbol}`}
          </button>
        )}
      </section>
    </div>
  );
}

function FeeLine({ fee }: { readonly fee: Fee }): ReactElement {
  return (
    <>
      <dt className="mv-fee-name" data-mv-fee={fee.kind}>
        {FEE_NAMES[fee.kind]}
      </dt>
      <dd className="mv-fee-amount" data-mv-fee={fee.kind}>
        {`${formatAmount(fee.total)} ${fee.total.asset.symbol}`}
      </dd>
      {/* A second <dd> against the same <dt>, which is valid and keeps the note
          a grid item so it can span both columns. */}
      {fee.kind === "account-reserve" ? (
        <dd className="mv-fee-note">
          Stellar locks this in your own account so it can hold assets. It is
          yours, and it comes back if you ever close the account.
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
