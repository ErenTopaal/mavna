/**
 * Mirror the checkout into the volume compose builds in.
 *
 *   node scripts/compose-sync.mjs /src /repo       (inside the build container)
 *   node scripts/compose-sync.mjs --write-manifest  (on the host, after adding or
 *                                                    removing a tracked file)
 *
 * Compose mounts the checkout read-only and builds in a named volume, so the
 * container never writes into the host's tree: no Linux packages in its
 * node_modules, no root-owned directories, no build output.
 *
 * What is copied is exactly the tracked files under the paths the build reads,
 * as listed in scripts/compose-files.txt. The image has no git, so the list is
 * computed on the host from `git ls-files` and committed, and
 * compose-sync.manifest.test.ts fails when it falls behind. Name rules guessed
 * wrong both ways: they dropped real source named like a secret and let secrets
 * named like config through. A secret denylist stays as a second guard, for a
 * secret someone tracked by mistake, and every file it holds back is printed.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = "scripts/compose-files.txt";

// the root files and directories the build reads
const ALLOWED = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "biome.json",
  "vitest.config.ts",
  ".nvmrc",
  "packages",
  "apps",
  "services",
  "scripts",
  "contracts",
]);

// what the volume makes for itself; never copied, never deleted from it
const VOLUME_OWN = new Set(["node_modules", "dist", ".turbo", ".next"]);

// source the build compiles is never held back for its name
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs)$/;

const SECRET = [
  /^\.env(\..*)?$/,
  /\.env(\.|$)/,
  /\.(pem|key|p12|pfx|jks|keystore)$/,
  /^id_(rsa|ecdsa|ed25519)/,
  /^\.(npmrc|envrc|netrc|pgpass)$/,
  /secret|credential|keypair|creds|apikey|api[-_]key|service[-_]account|private[-_]key/i,
  /^auth\.json$/i,
];

/** Whether a tracked file looks like a secret and stays out of the volume. */
export function heldBack(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === ".env.example") return false;
  if (SOURCE.test(name)) return false;
  return SECRET.some((pattern) => pattern.test(name));
}

/** The tracked paths compose copies, from a `git ls-files` list. */
export function manifestFor(tracked) {
  return tracked.filter((path) => ALLOWED.has(path.split("/")[0] ?? "")).sort();
}

function readManifest(src) {
  const file = join(src, MANIFEST);
  if (!existsSync(file)) {
    throw new Error(`${MANIFEST} is missing; run node scripts/compose-sync.mjs --write-manifest`);
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * Copy the manifest's files from src to dest and remove from dest what it does
 * not list, leaving the volume's own install and build. Returns the files held
 * back as likely secrets.
 */
export function sync(src, dest) {
  const listed = readManifest(src);
  const missing = listed.filter((path) => !existsSync(join(src, path)));
  if (missing.length > 0) {
    throw new Error(
      `${MANIFEST} lists files the checkout does not have (${missing.slice(0, 5).join(", ")}); ` +
        "run node scripts/compose-sync.mjs --write-manifest",
    );
  }
  const held = listed.filter(heldBack);
  const copied = new Set(listed.filter((path) => !heldBack(path)));

  mkdirSync(dest, { recursive: true });
  prune(dest, "", copied);
  for (const path of copied) {
    const from = join(src, path);
    const to = join(dest, path);
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  return held;
}

/** Remove what the manifest does not list; true when the directory is left empty. */
function prune(dir, rel, copied) {
  let empty = true;
  for (const name of readdirSync(dir)) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const full = join(dir, name);
    if (VOLUME_OWN.has(name)) {
      empty = false;
    } else if (lstatSync(full).isDirectory()) {
      if (prune(full, path, copied)) rmdirSync(full);
      else empty = false;
    } else if (copied.has(path)) {
      empty = false;
    } else {
      rmSync(full, { force: true });
    }
  }
  return empty && rel !== "";
}

// compared as real paths: a script reached through a symlink (/tmp on macOS, a
// mount) would otherwise not recognise itself and quietly do nothing
const invoked = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--write-manifest") {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "");
    // the manifest is tracked too, so it lists itself
    const listed = manifestFor([...new Set([...tracked, MANIFEST])]);
    writeFileSync(join(root, MANIFEST), `${listed.join("\n")}\n`);
    console.log(`  wrote ${MANIFEST}: ${listed.length} files`);
  } else {
    const [src, dest] = args;
    if (src === undefined || dest === undefined) {
      console.error("usage: node scripts/compose-sync.mjs <checkout> <volume>");
      process.exit(2);
    }
    for (const path of sync(src, dest)) {
      console.error(`  held back as a likely secret: ${path}`);
    }
  }
}
