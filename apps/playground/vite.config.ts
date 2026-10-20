import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

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
  // the widget falls back to http://localhost:8787, which a visitor's browser
  // cannot reach, so a hosted build without a sponsor declines every circle route
  if (command === "build" && mode === "production") {
    const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
    if ((env.VITE_MAVNA_SPONSOR_URL ?? "") === "") {
      throw new Error(
        "VITE_MAVNA_SPONSOR_URL is not set. A production build needs the testnet sponsor this " +
          "page will call, for example VITE_MAVNA_SPONSOR_URL=https://sponsor.mavna.app.",
      );
    }
  }
  // dist/ is what a host is given; the browser tests build elsewhere, so their
  // test-sponsor build never replaces it
  const { outDir } = testBuildSettings(command);
  return { plugins: [react()], build: { outDir } };
});
