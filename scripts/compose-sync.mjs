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
 * build. Secrets in .env files are not copied; compose passes settings as
 * environment variables.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LEFT_OUT = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  ".git",
  "target",
  "test_snapshots",
  "test-results",
  "playwright-report",
  ".DS_Store",
]);

function leftOut(name) {
  if (LEFT_OUT.has(name)) return true;
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

export function sync(src, dest) {
  mkdirSync(dest, { recursive: true });
  const wanted = readdirSync(src).filter((name) => !leftOut(name));
  const keep = new Set(wanted);
  for (const name of readdirSync(dest)) {
    if (!keep.has(name) && !leftOut(name))
      rmSync(join(dest, name), { recursive: true, force: true });
  }
  for (const name of wanted) {
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
      sync(from, to);
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
