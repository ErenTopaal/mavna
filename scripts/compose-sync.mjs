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
 * the root, and packages/, apps/, services/, scripts/ and contracts/. Inside
 * those, nothing git ignores (the checkout's own .gitignore) and nothing that
 * looks like a secret (.env files, *.env, keys) travels: compose passes settings
 * as environment variables, and the volume is mounted into the app container.
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

function isSecret(name) {
  return name !== ".env.example" && SECRET.some((pattern) => pattern.test(name));
}

/**
 * The checkout's .gitignore, as tests on a path relative to the root: a plain
 * name matches at any depth, a pattern with a slash from the root, `*` within a
 * segment, `!` re-includes. Enough for this repository's file, which is all it
 * has to read.
 */
function gitignored(src) {
  const file = join(src, ".gitignore");
  if (!existsSync(file)) return () => false;
  const rules = readFileSync(file, "utf8")
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
      return { negated, test: new RegExp(anchored ? `^${glob}$` : `(^|/)${glob}$`) };
    });
  return (path) => {
    let ignored = false;
    for (const rule of rules) if (rule.test.test(path)) ignored = !rule.negated;
    return ignored;
  };
}

export function sync(src, dest) {
  const ignored = gitignored(src);
  const wanted = (rel, name) =>
    !VOLUME_OWN.has(name) &&
    !isSecret(name) &&
    !ignored(rel === "" ? name : `${rel}/${name}`) &&
    (rel !== "" || ROOT_ALLOWED.has(name));
  mirror(src, dest, "", wanted);
}

function mirror(src, dest, rel, wanted) {
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(src).filter((name) => wanted(rel, name));
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
      mirror(from, to, rel === "" ? name : `${rel}/${name}`, wanted);
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
