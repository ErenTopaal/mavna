import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    "apps/docs/dist-test/client/index.html": "<html>",
    "apps/docs/dist-test/client/assets/LiveWidget-1.js": `fetch("${docsSponsor}/health")`,
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
      files[path.replace("/dist-test/", "/dist/")] = text;
    }
    expect(testBuildProblem(tree(files), SPONSOR)).toMatch(/missing|no build/);
  });
});

describe("the host build's fingerprint", () => {
  it("changes when anything in dist/ changes, and not for the test directories", () => {
    const root = tree({
      "apps/app/dist/index.html": "a",
      "apps/docs/dist/client/index.html": "1",
    });
    const before = hostBuildFingerprint(root);
    mkdirSync(join(root, "apps/web/dist-test"), { recursive: true });
    writeFileSync(join(root, "apps/web/dist-test/index.html"), "test");
    expect(hostBuildFingerprint(root)).toBe(before);
    writeFileSync(join(root, "apps/app/dist/index.html"), "b-longer");
    expect(hostBuildFingerprint(root)).not.toBe(before);
    const docsBefore = hostBuildFingerprint(root);
    writeFileSync(join(root, "apps/docs/dist/client/index.html"), "2-longer");
    expect(hostBuildFingerprint(root)).not.toBe(docsBefore);
  });
});

describe("what a cached browser-test build may restore", () => {
  // turbo restores a task's declared outputs from its cache, from whichever
  // checkout made them; the test build must declare only its own directories
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const tasks = (app: string) =>
    (
      JSON.parse(readFileSync(join(repo, "apps", app, "turbo.json"), "utf8")) as {
        tasks: Record<string, { outputs?: string[] }>;
      }
    ).tasks;
  const host = ["dist/", "public/"];

  it.each(["app", "playground", "web", "docs"])("is only the test directories for %s", (app) => {
    const test = tasks(app)["build:test"]?.outputs ?? [];
    expect(test.length).toBeGreaterThan(0);
    expect(test.filter((glob) => host.some((dir) => glob.startsWith(dir)))).toEqual([]);
    const build = tasks(app).build?.outputs ?? [];
    expect(build.filter((glob) => /-test/.test(glob))).toEqual([]);
  });

  it("is what the browser tests build", () => {
    const script = readFileSync(join(repo, "scripts/browser-test-build.mjs"), "utf8");
    expect(script).toMatch(/"build:test"/);
    expect(script).not.toMatch(/"run",\s*"build",/);
  });
});
