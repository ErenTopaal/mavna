import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { afterEach, describe, expect, it } from "vitest";
import config from "./next.config.mjs";

const saved = process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL;
  else process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL = saved;
});

describe("the docs build", () => {
  it("refuses a production build without a sponsor url for the live widgets", () => {
    delete process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL;
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(/NEXT_PUBLIC_MAVNA_SPONSOR_URL/);
    process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL = "";
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(/NEXT_PUBLIC_MAVNA_SPONSOR_URL/);
  });

  it("builds with one, and lets a dev server run without", () => {
    process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL = "https://sponsor.mavna.test";
    expect(config(PHASE_PRODUCTION_BUILD)).toMatchObject({ reactStrictMode: true });
    delete process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL;
    expect(config(PHASE_DEVELOPMENT_SERVER)).toMatchObject({ reactStrictMode: true });
  });
});

describe("where the docs build writes", () => {
  const savedDir = process.env.MAVNA_NEXT_DIST_DIR;
  afterEach(() => {
    if (savedDir === undefined) delete process.env.MAVNA_NEXT_DIST_DIR;
    else process.env.MAVNA_NEXT_DIST_DIR = savedDir;
  });

  it("writes .next by default, the build a host serves", () => {
    process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL = "https://sponsor.mavna.app";
    delete process.env.MAVNA_NEXT_DIST_DIR;
    expect(config(PHASE_PRODUCTION_BUILD).distDir ?? ".next").toBe(".next");
  });

  it("writes where MAVNA_NEXT_DIST_DIR says, so a test build never replaces .next", () => {
    process.env.NEXT_PUBLIC_MAVNA_SPONSOR_URL = "https://sponsor.mavna.test";
    process.env.MAVNA_NEXT_DIST_DIR = ".next-test";
    expect(config(PHASE_PRODUCTION_BUILD).distDir).toBe(".next-test");
  });
});
