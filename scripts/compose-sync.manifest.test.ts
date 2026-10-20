import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST, manifestFor, sync } from "./compose-sync.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout: these files, and a manifest listing `tracked` (default: all of them). */
function checkout(files: Record<string, string>, tracked?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mavna-sync-"));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, MANIFEST), `${(tracked ?? Object.keys(files)).join("\n")}\n`);
  return root;
}

function emptyDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mavna-sync-"));
  scratch.push(root);
  return root;
}

function filesUnder(root: string, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = rel === "" ? name : `${rel}/${name}`;
      if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), path);
      else out.push(path);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("syncing the checkout into compose's volume from the tracked-file manifest", () => {
  it("copies what the manifest lists and nothing else in the checkout", () => {
    const src = checkout(
      {
        "package.json": "{}",
        "packages/core/src/index.ts": "export {}",
        "apps/app/.npmrc": "//registry.npmjs.org/:_authToken=npm_x",
        "resources/plans/notes.md": "internal",
        "apps/app/notes.txt": "untracked",
      },
      ["package.json", "packages/core/src/index.ts"],
    );
    const dest = emptyDir();
    sync(src, dest);
    expect(filesUnder(dest)).toEqual(["package.json", "packages/core/src/index.ts"]);
  });

  it("copies source whatever it is named, and holds back tracked files that look like secrets", () => {
    const secrets = [
      "services/sponsor/sponsor.env",
      "services/sponsor/.env.local",
      "services/sponsor/keypair.json",
      "services/sponsor/creds.json",
      "services/sponsor/auth.json",
      "services/sponsor/apikey.json",
      "services/sponsor/service-account.json",
      "services/sponsor/credentials.json",
      "services/sponsor/secrets.json",
      "services/sponsor/tls.pem",
      "services/sponsor/SPONSOR_SECRET_KEY",
      "apps/app/.npmrc",
    ];
    const source = [
      "packages/core/src/secret.ts",
      "packages/core/src/credentials.ts",
      "packages/core/src/keypair.ts",
      "apps/app/.env.example",
    ];
    const src = checkout(Object.fromEntries([...secrets, ...source].map((p) => [p, "x"])));
    const dest = emptyDir();
    const held = sync(src, dest);
    expect(held.sort()).toEqual([...secrets].sort());
    expect(filesUnder(dest)).toEqual([...source].sort());
  });

  it("drops what the manifest no longer lists, and keeps the volume's own install and build", () => {
    const src = checkout({ "packages/core/src/a.ts": "new" });
    const dest = emptyDir();
    for (const [path, text] of Object.entries({
      "packages/core/src/a.ts": "old",
      "packages/core/src/removed.ts": "gone",
      "resources/x": "internal",
      "node_modules/x/index.js": "linux install",
      "packages/core/node_modules/y/index.js": "linux install",
      "packages/core/dist/index.mjs": "linux build",
    })) {
      mkdirSync(dirname(join(dest, path)), { recursive: true });
      writeFileSync(join(dest, path), text);
    }
    sync(src, dest);
    expect(readFileSync(join(dest, "packages/core/src/a.ts"), "utf8")).toBe("new");
    for (const gone of ["packages/core/src/removed.ts", "resources"]) {
      expect(existsSync(join(dest, gone)), gone).toBe(false);
    }
    for (const kept of [
      "node_modules/x/index.js",
      "packages/core/node_modules/y/index.js",
      "packages/core/dist/index.mjs",
    ]) {
      expect(existsSync(join(dest, kept)), kept).toBe(true);
    }
  });

  it("refuses a manifest that lists a file the checkout does not have", () => {
    const src = checkout({ "package.json": "{}" }, ["package.json", "packages/core/src/gone.ts"]);
    expect(() => sync(src, emptyDir())).toThrow(/--write-manifest/);
  });

  it("never writes into the source", () => {
    const src = checkout({ "packages/core/a.ts": "a" });
    const before = filesUnder(src);
    sync(src, emptyDir());
    expect(filesUnder(src)).toEqual(before);
  });

  it("runs as a command even when reached through a symlinked path", () => {
    const src = checkout({ "packages/core/a.ts": "a", "services/sponsor/sponsor.env": "S" });
    const dest = join(emptyDir(), "workspace");
    const linked = join(emptyDir(), "scripts");
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), linked);
    const result = spawnSync(process.execPath, [join(linked, "compose-sync.mjs"), src, dest], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dest, "packages/core/a.ts"), "utf8")).toBe("a");
    expect(result.stderr).toContain("held back as a likely secret: services/sponsor/sponsor.env");
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

describe("the committed manifest", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

  it("lists exactly the tracked files under the paths the build reads", () => {
    const committed = readFileSync(join(repo, MANIFEST), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(committed, "out of date: run node scripts/compose-sync.mjs --write-manifest").toEqual(
      manifestFor([...new Set([...tracked, MANIFEST])]),
    );
  });

  it("syncs the real checkout to exactly those files, none held back", { timeout: 60_000 }, () => {
    const dest = emptyDir();
    const held = sync(repo, dest);
    expect(held).toEqual([]);
    const committed = readFileSync(join(repo, MANIFEST), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(filesUnder(dest, new Set(["node_modules", "dist", ".turbo", ".next"]))).toEqual(
      committed,
    );
  });
});
