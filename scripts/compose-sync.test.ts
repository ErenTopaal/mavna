import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sync } from "./compose-sync.mjs";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mavna-sync-"));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("syncing the checkout into compose's volume", () => {
  it("copies sources and leaves out what the host installed or built", () => {
    const src = tree({
      "package.json": "{}",
      "apps/app/src/main.tsx": "app",
      "node_modules/x/index.js": "host install",
      "apps/app/node_modules/y/index.js": "host install",
      "apps/app/dist/index.html": "host build",
      ".turbo/cache": "host cache",
      ".env": "SPONSOR_SECRET_KEY=S",
    });
    const dest = tree({});
    sync(src, dest);
    expect(readFileSync(join(dest, "apps/app/src/main.tsx"), "utf8")).toBe("app");
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    for (const left of [
      "node_modules",
      "apps/app/node_modules",
      "apps/app/dist",
      ".turbo",
      ".env",
    ]) {
      expect(existsSync(join(dest, left)), left).toBe(false);
    }
  });

  it("drops a source the checkout no longer has, and keeps the volume's own install and build", () => {
    const src = tree({ "packages/core/src/a.ts": "new" });
    const dest = tree({
      "packages/core/src/a.ts": "old",
      "packages/core/src/removed.ts": "gone from the checkout",
      "node_modules/x/index.js": "linux install",
      "packages/core/node_modules/y/index.js": "linux install",
      "packages/core/dist/index.mjs": "linux build",
    });
    sync(src, dest);
    expect(readFileSync(join(dest, "packages/core/src/a.ts"), "utf8")).toBe("new");
    expect(existsSync(join(dest, "packages/core/src/removed.ts"))).toBe(false);
    for (const kept of [
      "node_modules/x/index.js",
      "packages/core/node_modules/y/index.js",
      "packages/core/dist/index.mjs",
    ]) {
      expect(existsSync(join(dest, kept)), kept).toBe(true);
    }
  });

  it("never writes into the source", () => {
    const src = tree({ "a.ts": "a" });
    const dest = tree({ "b.ts": "b" });
    sync(src, dest);
    expect(existsSync(join(src, "b.ts"))).toBe(false);
  });
});
