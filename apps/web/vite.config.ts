import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

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
  // dist/ is what a host is given; the browser tests build elsewhere
  // (MAVNA_BUILD_OUT_DIR), so their test-sponsor build never replaces it
  const outDir = process.env.MAVNA_BUILD_OUT_DIR || "dist";
  return { plugins: [react()], build: { outDir } };
});
