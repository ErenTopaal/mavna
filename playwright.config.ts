import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests, kept apart from Vitest.
 *
 * Vitest only collects `packages/**` and `services/**`, so `tests/*.spec.ts`
 * here cannot be picked up by both runners. That separation is deliberate: these
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
    baseURL: "http://localhost:4319",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Built rather than dev-served: the dev server inlines CSS through Vite's
    // own pipeline, which would test a bundle no integrator ever receives.
    command:
      "pnpm turbo run build --filter=@mavna/app... && pnpm --filter @mavna/app exec vite preview --port 4319 --strictPort",
    url: "http://localhost:4319",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
