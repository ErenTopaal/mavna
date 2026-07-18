import { RouteList, TransferPanel } from "@mavna/widget";
import { type ReactElement, useState } from "react";
import { ROUTE, ROUTE_SET, SCENARIOS } from "./fixtures.js";

/**
 * Every widget state, side by side, in both themes.
 *
 * Phase 8's verification asks for every failure state to be rendered and
 * reviewed rather than only the happy path, and the design rules say the failure
 * states get designed first. Neither is checkable by describing them, so they are
 * all on one page where a still screenshot shows whether two states that mean
 * different things actually look different.
 */
export function WidgetStates(): ReactElement {
  return (
    <main className="min-h-dvh bg-background px-4 py-10 sm:px-8">
      <header className="mb-10">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Widget states</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each column is one state of the draft scale. Read them as stills: if two mean different
          things and look the same, the design has failed.
        </p>
      </header>

      <section className="mb-12">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Choosing a route
        </h2>
        <div className="grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr))]">
          <RouteChoice theme="light" />
          <div className="dark rounded-lg bg-background p-4">
            <RouteChoice theme="dark" />
          </div>
        </div>
      </section>

      {(["light", "dark"] as const).map((theme) => (
        <section key={theme} className="mb-12">
          <h2 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {theme}
          </h2>
          <div
            className={
              theme === "dark"
                ? "dark grid gap-6 rounded-lg bg-background p-4 sm:p-6 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]"
                : "grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]"
            }
          >
            {SCENARIOS.map((scenario) => (
              <div key={scenario.name} data-scenario={scenario.name}>
                <p className="mb-2 text-xs text-muted-foreground">{scenario.name}</p>
                <TransferPanel
                  route={ROUTE}
                  steps={scenario.steps}
                  outcome={scenario.outcome}
                  onConfirm={undefined}
                  onRemedy={() => undefined}
                  theme={theme}
                />
              </div>
            ))}
            <div data-scenario="Before it starts">
              <p className="mb-2 text-xs text-muted-foreground">Before it starts</p>
              <TransferPanel
                route={ROUTE}
                steps={undefined}
                outcome="in-flight"
                onConfirm={() => undefined}
                onRemedy={undefined}
                theme={theme}
              />
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

/** Selection is real state here, because a card that cannot be picked proves nothing. */
function RouteChoice({ theme }: { readonly theme: "light" | "dark" }): ReactElement {
  const [selected, setSelected] = useState(ROUTE_SET.routes[0]?.id);
  return (
    <div className="mv-root" data-mv-theme={theme}>
      <div className="mv-panel">
        <RouteList routes={ROUTE_SET} selectedId={selected} onSelect={setSelected} />
      </div>
    </div>
  );
}
