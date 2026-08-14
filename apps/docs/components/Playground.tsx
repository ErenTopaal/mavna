"use client";

/**
 * The playground embed for the docs.
 *
 * A single live widget on a framed stage, so the playground page shows the real
 * component working before it sends you to the full configurator at
 * playground.mavna.app. The configurator (variant, rails, theme, event log) lives
 * there; this is the proof it is real, not a second copy of it.
 */
import { type ReactElement } from "react";
import { LiveWidget } from "./LiveWidget";

export function Playground(): ReactElement {
  return (
    <div className="mv-stage">
      <LiveWidget variant="compact" />
    </div>
  );
}
