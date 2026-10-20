import { defineConfig, devices } from "@playwright/test";
import { PORTS } from "./tests/env.js";

/**
 * Browser tests, kept apart from Vitest.
 *
 * Vitest collects `*.test.ts` under `packages/`, `services/` and `apps/`, so
 * `tests/*.spec.ts` here cannot be picked up by both runners. That separation is deliberate: these
 * need a built app and a real browser, and folding them into `pnpm test` would
 * make the fast suite slow enough that people stop running it.
 */
export default defineConfig({
  testDir: "tests",
  // Live specs reach the network and are run on demand, not on every push.
  testIgnore: process.env.MAVNA_LIVE === "1" ? [] : ["**/*.live.spec.ts"],
  fullyParallel: true,
  // A test that only passes sometimes is worse than one that fails, so a retry
  // never turns a red run green. CI is where flake gets discovered, not hidden.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORTS.app}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Built rather than dev-served: the dev server inlines CSS through Vite's
    // own pipeline, which would test a bundle no integrator ever receives.
    // `pnpm test:browser` builds first (scripts/browser-test-build.mjs), so this
    // only serves the four surfaces, on this port and the next three, and its
    // timeout is sized for serving rather than for a build under load.
    command: "node scripts/browser-test-servers.mjs",
    url: `http://localhost:${PORTS.app}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { MAVNA_TEST_PORT: String(PORTS.app) },
  },
});
