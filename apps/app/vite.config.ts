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

/**
 * The browser tests' settings, honoured only by `build:test`: a host build with
 * either left in a shell would put a test harness into dist/, or leave an old
 * dist/ to be deployed while it writes elsewhere. So a host build refuses them.
 */
function testBuildSettings(command: string): { outDir: string; harness: boolean } {
  const testBuild = process.env.npm_lifecycle_event === "build:test";
  const leaked = ["MAVNA_BUILD_OUT_DIR", "MAVNA_BROWSER_HARNESS"].filter(
    (name) => (process.env[name] ?? "") !== "",
  );
  if (command === "build" && !testBuild && leaked.length > 0) {
    throw new Error(
      `${leaked.join(" and ")} set for a host build. Only build:test, the browser tests' ` +
        "build, may set them; unset them and build again.",
    );
  }
  return {
    outDir: testBuild ? process.env.MAVNA_BUILD_OUT_DIR || "dist-test" : "dist",
    harness: testBuild && process.env.MAVNA_BROWSER_HARNESS === "1",
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode === "production") {
    requireSponsors(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_"));
  }
  // dist/ is what a host is given; the browser tests build elsewhere, with the
  // harness page, so their test-sponsor build never replaces it
  const { outDir, harness } = testBuildSettings(command);
  return {
    plugins: [react()],
    build: {
      outDir,
      ...(harness
        ? {
            rolldownOptions: {
              input: {
                main: fileURLToPath(new URL("./index.html", import.meta.url)),
                harness: fileURLToPath(new URL("./harness/buffer-free.html", import.meta.url)),
                backdrop: fileURLToPath(new URL("./harness/backdrop.html", import.meta.url)),
              },
            },
          }
        : {}),
    },
  };
});
