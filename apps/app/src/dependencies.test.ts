import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// every runtime dependency is install surface on the app that moves money, so
// one the source does not import is one to drop
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const imported = new Set(
  sources(join(root, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*"((?:@[^/"]+\/)?[^/"]+)/g)].map(
      (match) => match[1],
    ),
  ),
);

describe("the app's runtime dependencies", () => {
  it("are each imported by its source", () => {
    const unused = Object.keys(manifest.dependencies ?? {}).filter((name) => !imported.has(name));
    expect(unused).toEqual([]);
  });
});
