import type { Variant } from "@mavna/widget";
import { useTheme } from "fumadocs-ui/provider/base";
import { lazy, type ReactElement, Suspense, useEffect, useState } from "react";
import "@mavna/widget/widget.css";

// the widget connects wallets and touches the dom, so it is loaded in the
// browser only: the page is rendered to html at build time without it
const MavnaWidget = lazy(() => import("@mavna/widget").then((m) => ({ default: m.MavnaWidget })));

// inlined at build time; vite.config.ts refuses a production build without it.
// a dev server leaves it unset, so the widget asks the sponsor on localhost:8787.
const SPONSOR_URL: string | undefined = import.meta.env.VITE_MAVNA_SPONSOR_URL || undefined;

function Holding(): ReactElement {
  return <div className="mv-live-holding" aria-hidden="true" />;
}

/** The real widget against the test network, following the docs theme. */
export function LiveWidget({ variant = "compact" }: { readonly variant?: Variant }): ReactElement {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const appearance = resolvedTheme === "dark" ? "dark" : "light";
  return (
    <div className="mv-live not-prose">
      {mounted && resolvedTheme !== undefined ? (
        <Suspense fallback={<Holding />}>
          <MavnaWidget
            config={{
              integrator: "docs.mavna.app",
              network: "testnet",
              ...(SPONSOR_URL === undefined ? {} : { sponsorUrl: SPONSOR_URL }),
              variant,
              appearance,
            }}
          />
        </Suspense>
      ) : (
        <Holding />
      )}
    </div>
  );
}
