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
