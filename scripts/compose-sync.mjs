/**
 * Mirror the checkout into the volume compose builds in.
 *
 *   node scripts/compose-sync.mjs /src /repo
 *
 * Compose mounts the checkout read-only and builds in a named volume, so the
 * container never writes into the host's tree: no Linux packages in its
 * node_modules, no root-owned directories, no build output. This copies the
 * sources across and deletes from the volume what the checkout no longer has,
 * while leaving alone what only the volume should hold: its own install and
 * build.
 *
 * Only what the build reads is copied: the workspace manifests and configs at
 * the root, and inside packages/, apps/, services/, scripts/ and contracts/ only
 * the file types a build reads (sources, manifests, styles, assets). On top of
 * that, nothing any .gitignore ignores and nothing that looks like a secret
 * (.env files, *.env, keys, *secret*, *credential*) travels: compose passes
 * settings as environment variables, and the volume is mounted into the app
 * container.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// at the root, only these
const ROOT_ALLOWED = new Set([
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

const SECRET = [
  /^\.env(\..*)?$/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/,
  /^id_(rsa|ecdsa|ed25519)/,
];

// inside the allowed directories, only the file types a build reads
const BUILD_FILE = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "md",
  "mdx",
  "css",
  "html",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "toml",
  "rs",
  "lock",
  "yaml",
  "yml",
  "sh",
  "wasm",
]);

function isSecret(name) {
  if (name === ".env.example") return false;
  return SECRET.some((pattern) => pattern.test(name)) || /secret|credential/i.test(name);
}

function isBuildFile(name) {
  const dot = name.lastIndexOf(".");
  // no extension, or only a leading dot (.npmrc, .envrc): not a build file
  return dot > 0 && BUILD_FILE.has(name.slice(dot + 1).toLowerCase());
}

/**
 * One .gitignore's rules, as tests on a path relative to the directory it sits
 * in: a plain name matches at any depth below it, a pattern with a slash from
 * that directory, `*` within a segment, `!` re-includes. Enough for this
 * repository's files, which is all it has to read.
 */
function rulesIn(dir, base) {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const body = (negated ? line.slice(1) : line).replace(/\/$/, "").replace(/^\//, "");
      const glob = body
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      const anchored = body.includes("/");
      return { base, negated, test: new RegExp(anchored ? `^${glob}$` : `(^|/)${glob}$`) };
    });
}

function ignoredBy(rules, path) {
  let ignored = false;
  for (const rule of rules) {
    const prefix = rule.base === "" ? "" : `${rule.base}/`;
    if (!path.startsWith(prefix)) continue;
    if (rule.test.test(path.slice(prefix.length))) ignored = !rule.negated;
  }
  return ignored;
}

export function sync(src, dest) {
  mirror(src, dest, "", rulesIn(src, ""));
}

function wanted(rel, name, isDirectory, rules) {
  const path = rel === "" ? name : `${rel}/${name}`;
  if (VOLUME_OWN.has(name) || isSecret(name) || ignoredBy(rules, path)) return false;
  if (rel === "") return ROOT_ALLOWED.has(name);
  return isDirectory || isBuildFile(name);
}

function mirror(src, dest, rel, inherited) {
  mkdirSync(dest, { recursive: true });
  const rules = rel === "" ? inherited : [...inherited, ...rulesIn(src, rel)];
  const names = readdirSync(src).filter((name) =>
    wanted(rel, name, lstatSync(join(src, name)).isDirectory(), rules),
  );
  const keep = new Set(names);
  for (const name of readdirSync(dest)) {
    if (!keep.has(name) && !VOLUME_OWN.has(name)) {
      rmSync(join(dest, name), { recursive: true, force: true });
    }
  }
  for (const name of names) {
    const from = join(src, name);
    const to = join(dest, name);
    const kind = lstatSync(from);
    let there;
    try {
      there = lstatSync(to);
    } catch {
      there = undefined;
    }
    if (kind.isDirectory()) {
      if (there !== undefined && !there.isDirectory()) rmSync(to, { force: true });
      mirror(from, to, rel === "" ? name : `${rel}/${name}`, rules);
    } else {
      if (there !== undefined) rmSync(to, { recursive: true, force: true });
      if (kind.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else copyFileSync(from, to);
    }
  }
}

// compared as real paths: a script reached through a symlink (/tmp on macOS, a
// mount) would otherwise not recognise itself and quietly do nothing
const invoked = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const [src, dest] = process.argv.slice(2);
  if (src === undefined || dest === undefined) {
    console.error("usage: node scripts/compose-sync.mjs <checkout> <volume>");
    process.exit(2);
  }
  sync(src, dest);
}
