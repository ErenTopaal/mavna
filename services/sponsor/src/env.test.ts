import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "./env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reading configuration from the environment", () => {
  it("treats an empty value as unset", () => {
    // docker compose passes `${NAME:-}` through as an empty string, which must
    // fall back to the default rather than override it with nothing.
    vi.stubEnv("MAVNA_TEST_SETTING", "");
    expect(env("MAVNA_TEST_SETTING")).toBeUndefined();
  });

  it("returns a value that is set", () => {
    vi.stubEnv("MAVNA_TEST_SETTING", "https://rpc.example");
    expect(env("MAVNA_TEST_SETTING")).toBe("https://rpc.example");
  });

  it("returns undefined for a name that is absent", () => {
    expect(env("MAVNA_TEST_SETTING_NEVER_SET")).toBeUndefined();
  });
});
