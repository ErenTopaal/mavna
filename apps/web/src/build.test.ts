import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const saved = process.env.VITE_MAVNA_SPONSOR_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.VITE_MAVNA_SPONSOR_URL;
  else process.env.VITE_MAVNA_SPONSOR_URL = saved;
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
  it("refuses to start without a sponsor url", async () => {
    delete process.env.VITE_MAVNA_SPONSOR_URL;
    await expect(productionBuild()).rejects.toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });

  it("refuses an empty sponsor url, which is how compose forwards an unset one", async () => {
    process.env.VITE_MAVNA_SPONSOR_URL = "";
    await expect(productionBuild()).rejects.toThrow(/VITE_MAVNA_SPONSOR_URL/);
  });
});
