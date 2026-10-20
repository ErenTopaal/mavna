import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Each package runs its own vitest (from turbo, in parallel) over this one
// config. Sharing one module cache, they all clear it at once when the lockfile
// changes, and one fails with ENOTEMPTY while another writes into it. So each
// package directory gets a cache of its own.
const cacheFor = relative(root, process.cwd()).replaceAll("/", "-") || "root";

export default defineConfig({
  test: {
    fsModuleCachePath: join(root, "node_modules", ".vitest-cache", cacheFor),
    projects: [
      {
        test: {
          name: "unit",
          // apps/** included deliberately: every gap a full audit found lived in
          // the assembly layer, which was the one layer nothing tested. Green
          // packages under an untested app is how that happened.
          include: [
            "packages/**/*.test.ts",
            "services/**/*.test.ts",
            "apps/**/src/**/*.test.ts",
            "apps/docs/*.test.ts",
            "scripts/*.test.ts",
          ],
          // Live tests must never run here. They hit the network, and a testnet
          // outage is not evidence that someone's change is wrong.
          exclude: ["**/*.live.test.ts", "**/node_modules/**", "**/dist/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "live",
          include: [
            "packages/**/*.live.test.ts",
            "services/**/*.live.test.ts",
            "apps/**/src/**/*.live.test.ts",
          ],
          testTimeout: 120_000,
          hookTimeout: 300_000,
          // One at a time. These share a public network, and running them in
          // parallel is self-inflicted congestion that shows up as false failures.
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
