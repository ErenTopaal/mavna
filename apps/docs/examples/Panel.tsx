/**
 * The widget, wired to a quote and then to a transfer in flight.
 *
 * Both states are the same component. Before anything is signed, `steps` is
 * undefined and the panel is a quote with a confirm button. Once a transfer
 * starts, the same panel grows the draft scale and the button goes away.
 */

// One line, and it is not optional. tsdown extracts the widget's CSS into a file
// of its own and strips this import from the emitted JavaScript, so a component
// imported without it renders completely unstyled and throws nothing at all.
import "@mavna/widget/widget.css";

import type { Remedy, Route } from "@mavna/core";
import { outcomeOf, type TransferState } from "@mavna/status";
import { TransferPanel } from "@mavna/widget";
import type { ReactElement } from "react";

interface PanelProps {
  readonly route: Route;
  /** Undefined until the user has confirmed. That is the quote state. */
  readonly transfer: TransferState | undefined;
  readonly onConfirm: () => void;
  readonly onRemedy: (stepId: string, remedy: Remedy) => void;
}

export function Panel({ route, transfer, onConfirm, onRemedy }: PanelProps): ReactElement {
  const started = transfer !== undefined;

  return (
    <TransferPanel
      route={route}
      // TrackedStep already carries the id, label and phase the scale needs, so
      // there is nothing to map between the status machine and the widget.
      steps={transfer?.steps}
      outcome={transfer === undefined ? "in-flight" : outcomeOf(transfer)}
      // Nothing to confirm once it is under way. Passing a handler anyway would
      // render a button that sends a second transfer.
      onConfirm={started ? undefined : onConfirm}
      onRemedy={started ? onRemedy : undefined}
      // Undefined follows the reader's system setting, which is the right
      // default inside somebody else's page. Pass "light" or "dark" when your
      // app has its own switch, because a host on a dark OS running a light
      // theme is a real and common case.
      theme={undefined}
    />
  );
}
