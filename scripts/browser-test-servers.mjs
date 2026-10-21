// Serves the four test builds (each app's dist-test/) for the browser tests. It does not build:
// scripts/browser-test-build.mjs does, first, so Playwright's webServer timeout
// covers serving only. Playwright waits on one url, so the app (that url)
// starts only after the other three answer, and every spec finds all four up.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPONSOR_URL } from "../tests/env.ts";
import { DOCS_SITE, testBuildProblem, VITE_TEST_OUT } from "./browser-test-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = Number(process.env.MAVNA_TEST_PORT ?? "4319");
const port = (offset) => String(base + offset);

const problem = testBuildProblem(root, SPONSOR_URL);
if (problem !== undefined) {
  console.error(
    `${problem}. Run \`pnpm test:browser\`, which builds the surfaces for the tests first.`,
  );
  process.exit(1);
}

const children = [];
function serve(pkg, args) {
  const child = spawn("pnpm", ["--filter", pkg, "exec", ...args], {
    cwd: root,
    stdio: "inherit",
  });
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

serve("@mavna/playground", [
  "vite",
  "preview",
  "--outDir",
  VITE_TEST_OUT,
  "--port",
  port(1),
  "--strictPort",
]);
serve("@mavna/web", [
  "vite",
  "preview",
  "--outDir",
  VITE_TEST_OUT,
  "--port",
  port(2),
  "--strictPort",
]);
// the docs are static files, served the way the production proxy serves them
serve("@mavna/docs", ["node", "scripts/serve.mjs", `${VITE_TEST_OUT}/${DOCS_SITE}`, port(3)]);

const others = [1, 2, 3].map((offset) => `http://localhost:${port(offset)}`);
const deadline = Date.now() + 120_000;
while (!(await Promise.all(others.map(answers))).every(Boolean)) {
  if (Date.now() > deadline) {
    console.error(`not all of ${others.join(", ")} answered within two minutes`);
    stop(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

serve("@mavna/app", [
  "vite",
  "preview",
  "--outDir",
  VITE_TEST_OUT,
  "--port",
  port(0),
  "--strictPort",
]);
