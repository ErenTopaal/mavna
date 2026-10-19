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
/**
 * One build-time variable, with an empty value read as unset: docker compose
 * forwards `${NAME:-}` as an empty string when nothing is set, and the widget
 * rightly refuses an empty endpoint.
 */
function setting(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function networkId(value: string, name: string): NetworkId {
  if (value !== "testnet" && value !== "mainnet") {
    throw new Error(`${name} must be testnet or mainnet; got "${value}".`);
  }
  return value;
}

const network = networkId(
  setting(import.meta.env.VITE_MAVNA_NETWORK) ?? "testnet",
  "VITE_MAVNA_NETWORK",
);
// The networks the header toggle offers, comma separated. Each one other than
// the default needs its own sponsor below; the widget refuses otherwise.
const networks = (setting(import.meta.env.VITE_MAVNA_NETWORKS) ?? network)
  .split(",")
  .map((entry: string) => networkId(entry.trim(), "VITE_MAVNA_NETWORKS"));

const endpoints = {
  testnet: {
    rpcUrl: setting(import.meta.env.VITE_MAVNA_TESTNET_RPC_URL),
    sponsorUrl: setting(import.meta.env.VITE_MAVNA_TESTNET_SPONSOR_URL),
  },
  mainnet: {
    rpcUrl: setting(import.meta.env.VITE_MAVNA_MAINNET_RPC_URL),
    sponsorUrl: setting(import.meta.env.VITE_MAVNA_MAINNET_SPONSOR_URL),
  },
};

const config: MavnaWidgetConfig = {
  integrator: "mavna.app",
  network,
  networks,
  endpoints: {
    testnet: withoutUnset(endpoints.testnet),
    mainnet: withoutUnset(endpoints.mainnet),
  },
  variant: "wide",
  // The design is dark; the app commits to it rather than following the OS.
  appearance: "dark",
  ...optional("rpcUrl", setting(import.meta.env.VITE_STELLAR_RPC_URL)),
  ...optional("sponsorUrl", setting(import.meta.env.VITE_MAVNA_SPONSOR_URL)),
  ...optional("disabledSources", setting(import.meta.env.VITE_MAVNA_DISABLED_SOURCES)),
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

/** A field only when it was set, so an unset one never reads as an empty value. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

/** Drop the unset fields, so a per-network value never hides the default one. */
function withoutUnset(entry: { rpcUrl: string | undefined; sponsorUrl: string | undefined }): {
  rpcUrl?: string;
  sponsorUrl?: string;
} {
  return {
    ...(entry.rpcUrl === undefined ? {} : { rpcUrl: entry.rpcUrl }),
    ...(entry.sponsorUrl === undefined ? {} : { sponsorUrl: entry.sponsorUrl }),
  };
}

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");

createRoot(container).render(
  <StrictMode>
    <MavnaWidget config={config} />
  </StrictMode>,
);
