// Builds the four surfaces and serves them for the browser tests. Playwright
// waits on one url, so the app (that url) starts only after the other three
// answer, and every spec finds all four up.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = Number(process.env.MAVNA_TEST_PORT ?? "4319");
const port = (offset) => String(base + offset);

const built = spawnSync(
  "pnpm",
  [
    "turbo",
    "run",
    "build",
    "--filter=@mavna/app...",
    "--filter=@mavna/playground...",
    "--filter=@mavna/web...",
    "--filter=@mavna/docs...",
  ],
  { cwd: root, stdio: "inherit" },
);
if (built.status !== 0) process.exit(built.status ?? 1);

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
