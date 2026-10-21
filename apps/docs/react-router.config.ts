import type { Config } from "@react-router/dev/config";
import { buildDirectory } from "./build-settings.ts";

export default {
  // every page is rendered to html at build time and served as static files
  ssr: false,
  buildDirectory: buildDirectory(process.env),
  async prerender({ getStaticPaths }) {
    const { prerenderPaths } = await import("./app/lib/paths");
    return [...new Set([...getStaticPaths(), ...prerenderPaths()])];
  },
} satisfies Config;
