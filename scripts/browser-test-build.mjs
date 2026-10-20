// Builds the four surfaces for the browser tests, before Playwright starts, so
// the webServer only serves and its timeout is about serving. A build under
// load can take minutes; it is a gate step of its own here, not a race against
// a server window.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPONSOR_URL } from "../tests/env.ts";
import { hostBuildFingerprint, NEXT_TEST_OUT, VITE_TEST_OUT } from "./browser-test-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// the build a host is given stays exactly as it was: the test build goes to its
// own directories, and this checks nothing slipped into dist/ or .next anyway
const before = hostBuildFingerprint(root);

const built = spawnSync(
  "pnpm",
  [
    "turbo",
    "run",
    "build",
    "--filter=@mavna/app...",
    "--filter=@mavna/playground...",
    "--filter=@mavna/web...",
    "--filter=@mavna/docs...",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      // a sponsor no test can reach by accident; the specs answer for it
      VITE_MAVNA_SPONSOR_URL: SPONSOR_URL,
      NEXT_PUBLIC_MAVNA_SPONSOR_URL: SPONSOR_URL,
      // adds the harness page tests/buffer-free.spec.ts drives
      MAVNA_BROWSER_HARNESS: "1",
      MAVNA_BUILD_OUT_DIR: VITE_TEST_OUT,
      MAVNA_NEXT_DIST_DIR: NEXT_TEST_OUT,
    },
  },
);
if (built.status !== 0) process.exit(built.status ?? 1);
if (hostBuildFingerprint(root) !== before) {
  console.error(
    "the browser-test build changed dist/ or .next, which is what a host is given; " +
      `it must write only to ${VITE_TEST_OUT}/ and ${NEXT_TEST_OUT}/`,
  );
  process.exit(1);
}
