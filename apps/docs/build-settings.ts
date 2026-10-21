import { loadEnv, type Plugin } from "vite";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The live widgets fall back to http://localhost:8787, which a reader's browser
 * cannot reach, and every Circle route declines there, so a production build
 * without a sponsor stops here instead.
 */
export function requireSponsor(env: Env): void {
  if ((env.VITE_MAVNA_SPONSOR_URL ?? "") === "") {
    throw new Error(
      "VITE_MAVNA_SPONSOR_URL is not set. A production build needs the testnet sponsor the " +
        "live widgets will call, for example VITE_MAVNA_SPONSOR_URL=https://sponsor.mavna.app.",
    );
  }
}

/**
 * Checked when a production bundle starts rather than when the config loads:
 * react router's typegen loads this config as a build too, and needs no sponsor.
 */
export function sponsorRequired(root: string): Plugin {
  return {
    name: "mavna-docs-sponsor-required",
    apply: (_, { command, mode }) => command === "build" && mode === "production",
    buildStart() {
      requireSponsor(loadEnv("production", root, "VITE_"));
    },
  };
}

/**
 * dist/ is what a host is given. Only build:test, the browser tests' build, may
 * write elsewhere; a host build with MAVNA_BUILD_OUT_DIR left in a shell would
 * leave an old dist/ to be deployed, so it refuses instead.
 */
export function buildDirectory(env: Env): string {
  const outDir = env.MAVNA_BUILD_OUT_DIR ?? "";
  if (env.npm_lifecycle_event === "build:test") return outDir || "dist-test";
  if (outDir !== "" && env.npm_lifecycle_event === "build") {
    throw new Error(
      "MAVNA_BUILD_OUT_DIR set for a host build. Only build:test, the browser tests' build, " +
        "may set it; unset it and build again.",
    );
  }
  return "dist";
}
