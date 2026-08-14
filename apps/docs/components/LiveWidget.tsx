"use client";

/**
 * A real Mavna widget, mounted inside a docs page.
 *
 * It is the actual `@mavna/widget` component against the live test network, not a
 * screenshot: the chains, the quote, and the destination check are all real. The
 * appearance follows the docs theme toggle rather than the OS, so the demo tracks
 * the page it sits in.
 *
 * The widget connects wallets and touches the DOM, so it is loaded client-only
 * through next/dynamic: the module never runs during the static build, and the
 * server renders a placeholder until the client mounts it.
 */
import dynamic from "next/dynamic";
import type { Variant } from "@mavna/widget";
import "@mavna/widget/widget.css";
import { type ReactElement, useEffect, useState } from "react";

const MavnaWidget = dynamic(() => import("@mavna/widget").then((m) => m.MavnaWidget), {
  ssr: false,
  loading: () => <div className="mv-live-holding" aria-hidden="true" />,
});

function useDocsTheme(): "light" | "dark" | undefined {
  const [theme, setTheme] = useState<"light" | "dark" | undefined>(undefined);
  useEffect(() => {
    const read = (): void => {
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function LiveWidget({ variant = "compact" }: { readonly variant?: Variant }): ReactElement {
  const appearance = useDocsTheme();
  return (
    <div className="mv-live">
      {appearance === undefined ? (
        <div className="mv-live-holding" aria-hidden="true" />
      ) : (
        <MavnaWidget
          config={{ integrator: "docs.mavna.app", network: "testnet", variant, appearance }}
        />
      )}
    </div>
  );
}
