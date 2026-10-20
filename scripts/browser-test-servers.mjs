// Serves the four built surfaces for the browser tests. It does not build:
// scripts/browser-test-build.mjs does, first, so Playwright's webServer timeout
// covers serving only. Playwright waits on one url, so the app (that url)
// starts only after the other three answer, and every spec finds all four up.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPONSOR_URL } from "../tests/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = Number(process.env.MAVNA_TEST_PORT ?? "4319");
const port = (offset) => String(base + offset);

/**
 * The builds the specs need: made for the test sponsor, with the harness page.
 * A build made for anything else (the gate's own `pnpm build`, say) would fail
 * the specs for a reason that has nothing to do with them, so it is refused here.
 */
function testBuildProblem() {
  for (const app of ["app", "playground", "web"]) {
    const dist = join(root, "apps", app, "dist");
    const page = join(dist, "index.html");
    if (!existsSync(page)) return `apps/${app}/dist is missing`;
    // the entry the page loads, not any file in assets/: a cache restore lays a
    // build over the last one without clearing it, so old chunks can linger
    const entry = /<script[^>]*src="\/?([^"]+\.js)"/.exec(readFileSync(page, "utf8"))?.[1];
    if (entry === undefined || !existsSync(join(dist, entry))) {
      return `apps/${app}/dist/index.html loads no script`;
    }
    if (!readFileSync(join(dist, entry), "utf8").includes(SPONSOR_URL)) {
      return `apps/${app}/dist was built for another sponsor`;
    }
  }
  if (!existsSync(join(root, "apps/app/dist/harness/buffer-free.html"))) {
    return "apps/app/dist has no harness page";
  }
  if (!existsSync(join(root, "apps/docs/.next/BUILD_ID"))) return "apps/docs has no build";
  return undefined;
}

const problem = testBuildProblem();
if (problem !== undefined) {
  console.error(
    `${problem}. Run \`pnpm test:browser\`, which builds the surfaces for the tests first.`,
  );
  process.exit(1);
}

const children = [];
function serve(pkg, args) {
  const child = spawn("pnpm", ["--filter", pkg, "exec", ...args], { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => {
    // a server that dies takes the run with it, rather than leaving tests to time out
    if (code !== null && code !== 0) {
      console.error(`${pkg} server exited with ${code}`);
      stop(1);
    }
  });
  children.push(child);
}

function stop(code) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));

async function answers(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

serve("@mavna/playground", ["vite", "preview", "--port", port(1), "--strictPort"]);
serve("@mavna/web", ["vite", "preview", "--port", port(2), "--strictPort"]);
serve("@mavna/docs", ["next", "start", "--port", port(3)]);

const others = [1, 2, 3].map((offset) => `http://localhost:${port(offset)}`);
const deadline = Date.now() + 120_000;
while (!(await Promise.all(others.map(answers))).every(Boolean)) {
  if (Date.now() > deadline) {
    console.error(`not all of ${others.join(", ")} answered within two minutes`);
    stop(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

serve("@mavna/app", ["vite", "preview", "--port", port(0), "--strictPort"]);
