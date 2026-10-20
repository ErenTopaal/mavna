import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("copies only what the build needs, never secrets or what git ignores", () => {
    const src = tree({
      ".gitignore": "resources/\n.superpowers/\napps/docs/generated/\n*.zip\n",
      "package.json": "{}",
      "pnpm-lock.yaml": "lock",
      "pnpm-workspace.yaml": "packages: []",
      "turbo.json": "{}",
      "tsconfig.base.json": "{}",
      "packages/core/src/a.ts": "a",
      "apps/docs/content/index.mdx": "docs",
      "services/sponsor/src/main.ts": "sponsor",
      ".env.example": "SPONSOR_SECRET_KEY=",
      // what must never travel into the volume
      "resources/plans/notes.md": "internal",
      ".superpowers/x": "internal",
      ".claude/worktrees/x/a.ts": "a worktree",
      "apps/docs/generated/exports.mdx": "generated",
      "sponsor.env": "SPONSOR_SECRET_KEY=S",
      "services/sponsor/prod.env": "SPONSOR_SECRET_KEY=S",
      ".env.production": "SPONSOR_SECRET_KEY=S",
      "services/sponsor/tls.pem": "key",
      "services/sponsor/signer.key": "key",
      "backup.zip": "zip",
      "notes.txt": "a file at the root nobody listed",
    });
    const dest = tree({});
    sync(src, dest);
    for (const copied of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.base.json",
      "packages/core/src/a.ts",
      "apps/docs/content/index.mdx",
      "services/sponsor/src/main.ts",
    ]) {
      expect(existsSync(join(dest, copied)), copied).toBe(true);
    }
    for (const left of [
      "resources",
      ".superpowers",
      ".claude",
      "apps/docs/generated",
      "sponsor.env",
      "services/sponsor/prod.env",
      ".env.production",
      "services/sponsor/tls.pem",
      "services/sponsor/signer.key",
      "backup.zip",
      "notes.txt",
    ]) {
      expect(existsSync(join(dest, left)), left).toBe(false);
    }
  });

  it("copies only the file types a build reads inside the allowed directories", () => {
    const src = tree({
      "package.json": "{}",
      "apps/app/src/main.tsx": "app",
      "apps/app/index.html": "<html>",
      "apps/app/public/mark.png": "png",
      "packages/core/package.json": "{}",
      "packages/core/tsconfig.json": "{}",
      "packages/core/src/index.ts": "export {}",
      "contracts/arrival/Cargo.toml": "[package]",
      "contracts/build.sh": "#!/bin/sh",
      "apps/docs/biome.jsonc": "{}",
      // secrets a dropped file could carry, none matching the old patterns
      "apps/app/.npmrc": "//registry.npmjs.org/:_authToken=npm_secret",
      "packages/core/.envrc": "export SPONSOR_SECRET_KEY=S",
      "services/sponsor/credentials.json": '{"key":"S"}',
      "services/sponsor/secrets.json": '{"key":"S"}',
      "services/sponsor/sponsor.secret": "S",
      "services/sponsor/SPONSOR_SECRET_KEY": "S",
      "apps/app/sponsor.env.bak": "SPONSOR_SECRET_KEY=S",
      "packages/core/src/.env.local": "SPONSOR_SECRET_KEY=S",
      "scripts/notes.txt": "not a file type the build reads",
    });
    const dest = tree({});
    sync(src, dest);
    for (const copied of [
      "apps/app/src/main.tsx",
      "apps/app/index.html",
      "apps/app/public/mark.png",
      "packages/core/package.json",
      "packages/core/tsconfig.json",
      "packages/core/src/index.ts",
      "contracts/arrival/Cargo.toml",
      "contracts/build.sh",
      "apps/docs/biome.jsonc",
    ]) {
      expect(existsSync(join(dest, copied)), copied).toBe(true);
    }
    for (const left of [
      "apps/app/.npmrc",
      "packages/core/.envrc",
      "services/sponsor/credentials.json",
      "services/sponsor/secrets.json",
      "services/sponsor/sponsor.secret",
      "services/sponsor/SPONSOR_SECRET_KEY",
      "apps/app/sponsor.env.bak",
      "packages/core/src/.env.local",
      "scripts/notes.txt",
    ]) {
      expect(existsSync(join(dest, left)), left).toBe(false);
    }
  });

  it("honours a .gitignore inside a directory, relative to it", () => {
    const src = tree({
      "package.json": "{}",
      "apps/docs/.gitignore": "generated/\npublic/_pagefind/\nnext-env.d.ts\n",
      "apps/docs/generated/exports.mdx": "generated",
      "apps/docs/public/_pagefind/index.js": "generated",
      "apps/docs/public/logo.png": "png",
      "apps/docs/next-env.d.ts": "generated",
      "apps/docs/content/index.mdx": "docs",
    });
    const dest = tree({});
    sync(src, dest);
    expect(existsSync(join(dest, "apps/docs/content/index.mdx"))).toBe(true);
    expect(existsSync(join(dest, "apps/docs/public/logo.png"))).toBe(true);
    for (const left of [
      "apps/docs/generated",
      "apps/docs/public/_pagefind",
      "apps/docs/next-env.d.ts",
    ]) {
      expect(existsSync(join(dest, left)), left).toBe(false);
    }
  });

  it("removes from the volume a secret an earlier sync copied", () => {
    const src = tree({ "package.json": "{}" });
    const dest = tree({ "sponsor.env": "SPONSOR_SECRET_KEY=S", "resources/x": "internal" });
    sync(src, dest);
    expect(existsSync(join(dest, "sponsor.env"))).toBe(false);
    expect(existsSync(join(dest, "resources"))).toBe(false);
  });

  it("never writes into the source", () => {
    const src = tree({ "packages/core/a.ts": "a" });
    const dest = tree({ "packages/core/b.ts": "b" });
    sync(src, dest);
    expect(existsSync(join(src, "packages/core/b.ts"))).toBe(false);
  });

  it("runs as a command even when reached through a symlinked path", () => {
    const src = tree({ "packages/core/a.ts": "a" });
    const dest = join(tree({}), "workspace");
    // /tmp on macOS is a symlink, as a mount path can be anywhere
    const linked = join(tree({}), "scripts");
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), linked);
    const result = spawnSync(process.execPath, [join(linked, "compose-sync.mjs"), src, dest], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dest, "packages/core/a.ts"), "utf8")).toBe("a");
  });

  it("refuses to run without both paths", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./compose-sync.mjs", import.meta.url))],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
  });
});
