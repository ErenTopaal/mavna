// @ts-check
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import nextra from "nextra";

/**
 * The documentation site, on Nextra's docs theme.
 *
 * Content lives in `content/` as MDX; the reference tables and source excerpts
 * under `generated/` are written by scripts/sync-reference.mjs from the packages
 * themselves before every build, so a page can only show what the source says.
 */
const withNextra = nextra({
  // Code blocks are indexed too: this reference is mostly identifiers, and a
  // search that cannot find `TransferHandle` because it sits in a fence would
  // miss the queries this site exists to answer.
  search: { codeblocks: true },
});

/**
 * The live widgets on these pages call a sponsor. Without one they fall back to
 * http://localhost:8787, which a reader's browser cannot reach, and every
 * Circle route declines, so a production build stops here instead.
 *
 * @param {string} phase
 */
export default function config(phase) {
  if (
    phase === PHASE_PRODUCTION_BUILD &&
    (process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL ?? "") === ""
  ) {
    throw new Error(
      "NEXT_PUBLIC_MAVNA_SPONSOR_URL is not set. A production build needs the testnet sponsor " +
        "the live widgets will call, for example NEXT_PUBLIC_MAVNA_SPONSOR_URL=https://sponsor.mavna.app.",
    );
  }
  // honoured when building only by build:test; a host build with it left in a
  // shell would write elsewhere and leave an old .next to be served. Serving
  // (next start for the browser tests) reads it to find the test build.
  const distDir = process.env.MAVNA_NEXT_DIST_DIR || undefined;
  if (
    phase === PHASE_PRODUCTION_BUILD &&
    distDir !== undefined &&
    process.env.npm_lifecycle_event !== "build:test"
  ) {
    throw new Error(
      "MAVNA_NEXT_DIST_DIR set for a host build. Only build:test, the browser tests' build, " +
        "may set it; unset it and build again.",
    );
  }
  return withNextra({
    // .next is what a host serves; the browser tests build into their own
    // directory, so their test-sponsor build never replaces it
    ...(distDir === undefined ? {} : { distDir }),
    reactStrictMode: true,
    // Do not write CLAUDE.md / AGENTS.md into this app on every dev run.
    agentRules: false,
  });
}
