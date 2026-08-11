import { MavnaWidget, type MavnaWidgetConfig } from "@mavna/widget";
import "@mavna/widget/widget.css";
import type { NetworkId } from "@mavna/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

/*
 * The app is a thin host over the widget: it reads its own configuration from the
 * environment and renders the widget in its wide, full-page layout. Everything the
 * interface does now lives in @mavna/widget, so the app and any integrator run the
 * exact same code path.
 */
const network: NetworkId = import.meta.env.VITE_MAVNA_NETWORK === "mainnet" ? "mainnet" : "testnet";

const config: MavnaWidgetConfig = {
  integrator: "mavna.app",
  network,
  variant: "wide",
  // The design is dark; the app commits to it rather than following the OS.
  appearance: "dark",
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL,
  sponsorUrl: import.meta.env.VITE_MAVNA_SPONSOR_URL,
  disabledSources: import.meta.env.VITE_MAVNA_DISABLED_SOURCES,
  // The two faces the app ships. The widget stays on system fonts for anyone else.
  theme: {
    font: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
    fontMono: '"Azeret Mono", ui-monospace, monospace',
  },
  // The header overflow ("...") menu: the app's own destinations.
  menuLinks: [
    { label: "Home", href: "https://web.mavna.app" },
    { label: "Playground", href: "https://playground.mavna.app" },
    { label: "Docs", href: "https://docs.mavna.app" },
    { label: "GitHub", href: "https://github.com/ErenTopaal/mavna", external: true },
  ],
};

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");

createRoot(container).render(
  <StrictMode>
    <MavnaWidget config={config} />
  </StrictMode>,
);
