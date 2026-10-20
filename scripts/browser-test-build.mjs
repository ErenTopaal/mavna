// Builds the four surfaces for the browser tests, before Playwright starts, so
// the webServer only serves and its timeout is about serving. A build under
// load can take minutes; it is a gate step of its own here, not a race against
// a server window.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPONSOR_URL } from "../tests/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

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
    },
  },
);
process.exit(built.status ?? 1);
