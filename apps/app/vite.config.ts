import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * Every network the build offers needs a sponsor. Without one the widget either
 * falls back to http://localhost:8787, which a visitor's browser cannot reach,
 * or throws when the network is picked, so a hosted build fails here instead.
 */
function requireSponsors(env: Record<string, string>): void {
  const set = (name: string): boolean => (env[name] ?? "") !== "";
  const network = set("VITE_MAVNA_NETWORK") ? env.VITE_MAVNA_NETWORK : "testnet";
  const networks = set("VITE_MAVNA_NETWORKS")
    ? (env.VITE_MAVNA_NETWORKS ?? "").split(",").map((entry) => entry.trim())
    : [network];
  for (const entry of networks) {
    const own = `VITE_MAVNA_${(entry ?? "").toUpperCase()}_SPONSOR_URL`;
    if (set(own)) continue;
    if (entry === network && set("VITE_MAVNA_SPONSOR_URL")) continue;
    throw new Error(
      entry === network
        ? `VITE_MAVNA_SPONSOR_URL (or ${own}) is not set. A production build needs the ` +
            `${entry} sponsor this app will call.`
        : `${own} is not set. VITE_MAVNA_NETWORKS offers ${entry}, and a sponsor serves one ` +
            "network, so it needs its own.",
    );
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode === "production") {
    requireSponsors(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_"));
  }
  // the browser tests' harness page, never part of a build that gets hosted
  const harness = process.env.MAVNA_BROWSER_HARNESS === "1";
  return {
    plugins: [react()],
    ...(harness
      ? {
          build: {
            rolldownOptions: {
              input: {
                main: fileURLToPath(new URL("./index.html", import.meta.url)),
                harness: fileURLToPath(new URL("./harness/buffer-free.html", import.meta.url)),
              },
            },
          },
        }
      : {}),
  };
});
