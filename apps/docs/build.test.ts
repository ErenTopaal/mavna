import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildDirectory, requireSponsor } from "./build-settings.ts";
import config from "./react-router.config.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const saved = process.env.VITE_MAVNA_SPONSOR_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.VITE_MAVNA_SPONSOR_URL;
  else process.env.VITE_MAVNA_SPONSOR_URL = saved;
});

describe("a production build", () => {
  let start: (() => void) | undefined;
  // resolving loads react router's plugin, which takes seconds on a cold cache
  beforeAll(async () => {
    const resolved = await resolveConfig(
      { root, configFile: `${root}vite.config.ts`, mode: "production" },
      "build",
    );
    const plugin = resolved.plugins.find((p) => p.name === "mavna-docs-sponsor-required");
    start = plugin?.buildStart as unknown as (() => void) | undefined;
  }, 60_000);

  async function sponsorCheck(): Promise<() => void> {
    const check = start;
    if (check === undefined) throw new Error("the production build has no sponsor check");
    return () => check.call({});
  }

  it("refuses to start without a sponsor url for the live widgets", async () => {
    delete process.env.VITE_MAVNA_SPONSOR_URL;
    expect(await sponsorCheck()).toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });

  it("refuses an empty sponsor url, which is how compose forwards an unset one", async () => {
    process.env.VITE_MAVNA_SPONSOR_URL = "";
    expect(await sponsorCheck()).toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });

  it("builds with one", async () => {
    process.env.VITE_MAVNA_SPONSOR_URL = "https://sponsor.mavna.test";
    expect(await sponsorCheck()).not.toThrow();
    expect(() =>
      requireSponsor({ VITE_MAVNA_SPONSOR_URL: "https://sponsor.mavna.test" }),
    ).not.toThrow();
  });
});

describe("where a build writes", () => {
  it("writes dist for the host build, the folder a host is given", () => {
    expect(buildDirectory({ npm_lifecycle_event: "build" })).toBe("dist");
    expect(config.buildDirectory).toBe(buildDirectory(process.env));
  });

  // the browser tests build for a sponsor that does not exist; that build must
  // never land where a deploy copies from
  it("writes where build:test says, so a test build never replaces dist", () => {
    expect(
      buildDirectory({ npm_lifecycle_event: "build:test", MAVNA_BUILD_OUT_DIR: "dist-test" }),
    ).toBe("dist-test");
    expect(buildDirectory({ npm_lifecycle_event: "build:test" })).toBe("dist-test");
  });

  it("refuses a host build with MAVNA_BUILD_OUT_DIR left in the environment", () => {
    expect(() =>
      buildDirectory({ npm_lifecycle_event: "build", MAVNA_BUILD_OUT_DIR: "dist-test" }),
    ).toThrow(/MAVNA_BUILD_OUT_DIR.*build:test/);
  });
});
