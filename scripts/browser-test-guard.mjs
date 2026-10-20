// What the browser tests check before serving and after building: that the
// surfaces they serve were built for the test sponsor, in the test directories,
// and that the host builds in dist/ and .next were not touched doing it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const VITE_APPS = ["app", "playground", "web"];
export const VITE_TEST_OUT = "dist-test";
export const NEXT_TEST_OUT = ".next-test";

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Why the test build cannot be served, or undefined when it can. */
export function testBuildProblem(root, sponsorUrl) {
  for (const app of VITE_APPS) {
    const dist = join(root, "apps", app, VITE_TEST_OUT);
    const page = join(dist, "index.html");
    if (!existsSync(page)) return `apps/${app}/${VITE_TEST_OUT} is missing`;
    // the entry the page loads, not any file in assets/: a cache restore lays a
    // build over the last one without clearing it, so old chunks can linger
    const entry = /<script[^>]*src="\/?([^"]+\.js)"/.exec(readFileSync(page, "utf8"))?.[1];
    if (entry === undefined || !existsSync(join(dist, entry))) {
      return `apps/${app}/${VITE_TEST_OUT}/index.html loads no script`;
    }
    if (!readFileSync(join(dist, entry), "utf8").includes(sponsorUrl)) {
      return `apps/${app}/${VITE_TEST_OUT} was built for another sponsor`;
    }
  }
  if (!existsSync(join(root, "apps/app", VITE_TEST_OUT, "harness/buffer-free.html"))) {
    return `apps/app/${VITE_TEST_OUT} has no harness page`;
  }
  const docs = join(root, "apps/docs", NEXT_TEST_OUT);
  if (!existsSync(join(docs, "BUILD_ID"))) return `apps/docs/${NEXT_TEST_OUT} has no build`;
  // next clears its output directory on every build, so any client chunk
  // naming the sponsor is this build's
  const named = filesUnder(join(docs, "static"))
    .filter((file) => file.endsWith(".js"))
    .some((file) => readFileSync(file, "utf8").includes(sponsorUrl));
  if (!named) return `apps/docs/${NEXT_TEST_OUT} was built for another sponsor`;
  return undefined;
}

/** A digest of every file in the host builds (dist/ and .next), by path, size and time. */
export function hostBuildFingerprint(root) {
  const hash = createHash("sha256");
  const dirs = [
    ...VITE_APPS.map((app) => join(root, "apps", app, "dist")),
    join(root, "apps/docs/.next"),
  ];
  for (const dir of dirs) {
    for (const file of filesUnder(dir)) {
      const { size, mtimeMs } = statSync(file);
      hash.update(`${file}\0${size}\0${mtimeMs}\n`);
    }
  }
  return hash.digest("hex");
}
