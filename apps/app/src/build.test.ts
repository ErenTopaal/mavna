import { fileURLToPath } from "node:url";
import { build, resolveConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAMES = [
  "VITE_MAVNA_NETWORK",
  "VITE_MAVNA_NETWORKS",
  "VITE_MAVNA_SPONSOR_URL",
  "VITE_MAVNA_TESTNET_SPONSOR_URL",
  "VITE_MAVNA_MAINNET_SPONSOR_URL",
] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const productionBuild = () =>
  build({
    root,
    configFile: `${root}vite.config.ts`,
    mode: "production",
    logLevel: "silent",
    build: { write: false },
  });

describe("a production build", () => {
  it("refuses to start without a sponsor url for the default network", async () => {
    setEnv({});
    await expect(productionBuild()).rejects.toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });

  it("refuses an empty sponsor url, which is how compose forwards an unset one", async () => {
    setEnv({ VITE_MAVNA_SPONSOR_URL: "" });
    await expect(productionBuild()).rejects.toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });

  it("refuses an offered network that has no sponsor of its own", async () => {
    setEnv({
      VITE_MAVNA_NETWORK: "testnet",
      VITE_MAVNA_NETWORKS: "testnet,mainnet",
      VITE_MAVNA_SPONSOR_URL: "https://sponsor.mavna.test",
    });
    await expect(productionBuild()).rejects.toThrow(/VITE_MAVNA_MAINNET_SPONSOR_URL/);
  });
});

describe("where a build writes", () => {
  const savedOut = process.env.MAVNA_BUILD_OUT_DIR;
  afterEach(() => {
    if (savedOut === undefined) delete process.env.MAVNA_BUILD_OUT_DIR;
    else process.env.MAVNA_BUILD_OUT_DIR = savedOut;
  });

  const outDir = async () =>
    (
      await resolveConfig(
        { root, configFile: `${root}vite.config.ts`, mode: "production" },
        "build",
      )
    ).build.outDir;

  it("writes dist/ by default, the folder a host is given", async () => {
    process.env.VITE_MAVNA_SPONSOR_URL = "https://sponsor.mavna.app";
    delete process.env.MAVNA_BUILD_OUT_DIR;
    expect(await outDir()).toBe("dist");
  });

  // the browser tests build for a sponsor that does not exist; that build must
  // never land where a deploy copies from
  it("writes where MAVNA_BUILD_OUT_DIR says, so a test build never replaces dist/", async () => {
    process.env.VITE_MAVNA_SPONSOR_URL = "https://sponsor.mavna.test";
    process.env.MAVNA_BUILD_OUT_DIR = "dist-test";
    expect(await outDir()).toBe("dist-test");
  });
});
