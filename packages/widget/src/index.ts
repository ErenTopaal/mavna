// This import is what puts the stylesheet in the build graph, and removing it
// emits no CSS at all. It does NOT reach the consumer: tsdown extracts the CSS
// into `dist/widget.css` and strips the import from the emitted JS, so importing
// only the component renders it completely unstyled with no error anywhere.
//
// Integrators therefore need one line, `import "@mavna/widget/widget.css"`, and
// TransferPanel warns in development if it is missing, because the failure is
// otherwise silent. Found the hard way, by shipping the unstyled version.
import "./widget.css";

export type { DraftScaleProps, ScaleStep } from "./DraftScale.js";
export {
  actionLabel,
  blockedNote,
  DraftScale,
  humanDuration,
  needsUser,
  noteFor,
  remedyFor,
} from "./DraftScale.js";
export { formatAmount, shortenAddress } from "./format.js";
export type { TransferPanelProps } from "./TransferPanel.js";
export { settledAmount, TransferPanel } from "./TransferPanel.js";
