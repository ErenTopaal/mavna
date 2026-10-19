/**
 * Every package index must re-export every module beside it.
 *
 * This exists because an incomplete index is invisible to every other gate: it
 * compiles, it lints, and the tests pass, because tests import modules directly
 * rather than through the index. It cost real time once, when a command that
 * wrote an index was rejected wholesale and only part of it was re-run.
 */
// Every package's index must actually export its modules. A silently-empty index
// compiles and tests fine, because tests import modules directly.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const roots = ["packages", "packages/adapters", "services"];
let bad = 0;
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const pkg of readdirSync(root)) {
    const src = `${root}/${pkg}/src`;
    if (!existsSync(src) || !existsSync(`${src}/index.ts`)) continue;
    // a package can opt out when its public index is deliberately a hand-picked
    // surface (the widget exports two components, not every internal module).
    const manifest = `${root}/${pkg}/package.json`;
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).mavna?.publicIndex === "explicit"
    )
      continue;
    const modules = readdirSync(src).filter(
      (f) =>
        // .tsx counts. It was omitted at first, which meant the widget's two
        // components -- the entire public surface of that package -- were exempt
        // from the one check that exists to catch an incomplete index.
        (f.endsWith(".ts") || f.endsWith(".tsx")) &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx") &&
        !f.endsWith(".test-d.ts") &&
        // Declaration files declare, they do not export anything an index could
        // re-export. Requiring one here would be a rule with no failure behind it.
        !f.endsWith(".d.ts") &&
        // An entry point is run, not imported. Re-exporting one from the index
        // would execute its side effects in every consumer that touches the
        // package, which for the sponsor's main means starting a server.
        f !== "main.ts" &&
        f !== "index.ts",
    );
    const index = readFileSync(`${src}/index.ts`, "utf8");
    const missing = modules.filter((m) => !index.includes(`./${m.replace(/\.tsx?$/, ".js")}`));
    if (missing.length) {
      console.log(`  ${root}/${pkg}: index omits ${missing.join(", ")}`);
      bad++;
    }
  }
}
console.log(
  bad === 0
    ? "  every index re-exports every module"
    : `  ${bad} package(s) with an incomplete index`,
);
process.exit(bad === 0 ? 0 : 1);
