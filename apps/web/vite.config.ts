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
  return { plugins: [react()] };
});
