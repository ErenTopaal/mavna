import { defineConfig, devices } from "@playwright/test";
import { PORTS, SPONSOR_URL } from "./tests/env.js";

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
    // own pipeline, which would test a bundle no integrator ever receives. The
    // script serves the playground, landing and docs too, on the next three ports.
    command: "node scripts/browser-test-servers.mjs",
    url: `http://localhost:${PORTS.app}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // a sponsor no test can reach by accident; the specs answer for it
    env: {
      VITE_MAVNA_SPONSOR_URL: SPONSOR_URL,
      NEXT_PUBLIC_MAVNA_SPONSOR_URL: SPONSOR_URL,
      // adds the harness page tests/buffer-free.spec.ts drives
      MAVNA_BROWSER_HARNESS: "1",
      MAVNA_TEST_PORT: String(PORTS.app),
    },
  },
});
