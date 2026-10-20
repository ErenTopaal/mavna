import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostBuildFingerprint, testBuildProblem } from "./browser-test-guard.mjs";

const SPONSOR = "https://sponsor.mavna.test";
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mavna-guard-"));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A complete test build, every surface made for `docsSponsor` or SPONSOR. */
function testBuild(docsSponsor = SPONSOR): Record<string, string> {
  const files: Record<string, string> = {
    "apps/app/dist-test/harness/buffer-free.html": "<html>",
    "apps/docs/.next-test/BUILD_ID": "x",
    "apps/docs/.next-test/static/chunks/app/widget/page-1.js": `fetch("${docsSponsor}/health")`,
  };
  for (const app of ["app", "playground", "web"]) {
    files[`apps/${app}/dist-test/index.html`] =
      '<script type="module" crossorigin src="/assets/index-a.js"></script>';
    files[`apps/${app}/dist-test/assets/index-a.js`] = `fetch("${SPONSOR}/health")`;
  }
  return files;
}

describe("the browser tests' build guard", () => {
  it("accepts a test build in the test directories", () => {
    expect(testBuildProblem(tree(testBuild()), SPONSOR)).toBeUndefined();
  });

  it("refuses docs built for another sponsor, not only docs with no build", () => {
    expect(testBuildProblem(tree(testBuild("https://sponsor.mavna.app")), SPONSOR)).toMatch(
      /apps\/docs.*another sponsor/,
    );
  });

  it("refuses when only a host build exists, whatever it was built for", () => {
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(testBuild())) {
      files[path.replace("/dist-test/", "/dist/").replace("/.next-test/", "/.next/")] = text;
    }
    expect(testBuildProblem(tree(files), SPONSOR)).toMatch(/missing|no build/);
  });
});

describe("the host build's fingerprint", () => {
  it("changes when anything in dist/ or .next changes, and not for the test directories", () => {
    const root = tree({
      "apps/app/dist/index.html": "a",
      "apps/docs/.next/BUILD_ID": "1",
    });
    const before = hostBuildFingerprint(root);
    mkdirSync(join(root, "apps/web/dist-test"), { recursive: true });
    writeFileSync(join(root, "apps/web/dist-test/index.html"), "test");
    expect(hostBuildFingerprint(root)).toBe(before);
    writeFileSync(join(root, "apps/app/dist/index.html"), "b-longer");
    expect(hostBuildFingerprint(root)).not.toBe(before);
  });
});
