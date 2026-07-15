/**
 * Refresh the vendored shadcn stylesheet.
 *
 * Vendoring is deliberate (see the header of the file this writes), but vendored
 * code rots silently unless refreshing it is one command. This prints a diff
 * rather than applying anything, because the point is to read what changed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = process.argv[2] ?? "4.16.2";
const TARGET = "apps/app/src/styles/shadcn.css";

const meta = await (await fetch(`https://registry.npmjs.org/shadcn/${VERSION}`)).json();
const dir = mkdtempSync(join(tmpdir(), "shadcn-css-"));
const tgz = join(dir, "p.tgz");
writeFileSync(tgz, Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer()));
execFileSync("tar", ["xzf", tgz, "-C", dir]);

const fresh = readFileSync(join(dir, "package/dist/tailwind.css"), "utf8");
const current = readFileSync(TARGET, "utf8");
const header = current.slice(0, current.indexOf("*/") + 3);
const body = current.slice(header.length);

if (body.trimEnd() === fresh.trimEnd()) {
  console.log(`  ${TARGET} matches shadcn@${VERSION}`);
  process.exit(0);
}

writeFileSync(join(dir, "fresh.css"), fresh);
writeFileSync(join(dir, "current.css"), body);
console.log(`  ${TARGET} differs from shadcn@${VERSION}:`);
try {
  execFileSync("diff", ["-u", join(dir, "current.css"), join(dir, "fresh.css")], {
    stdio: "inherit",
  });
} catch {
  // diff exits non-zero when files differ, which is the expected path here.
}
process.exit(1);
