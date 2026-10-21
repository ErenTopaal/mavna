import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
import { sponsorRequired } from "./build-settings.ts";

export default defineConfig({
  plugins: [
    sponsorRequired(fileURLToPath(new URL(".", import.meta.url))),
    fumadocsMdx(),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: { tsconfigPaths: true },
});
