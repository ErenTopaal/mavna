import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["packages/**/*.test.ts"], environment: "node" },
      },
      {
        // Hits real endpoints. Never a required check on a pull request: a testnet
        // outage is not evidence that someone's change is wrong.
        test: {
          name: "live",
          include: ["packages/**/*.live.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          maxWorkers: 2,
        },
      },
    ],
  },
});
