import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// the reference page claims every export of every package, so a published
// package it leaves out is a page saying something false
const repo = fileURLToPath(new URL("../..", import.meta.url));
const docs = fileURLToPath(new URL(".", import.meta.url));

function published(dir: string): string[] {
  return readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    let manifest: { name?: string; private?: boolean };
    try {
      manifest = JSON.parse(readFileSync(join(repo, dir, entry.name, "package.json"), "utf8"));
    } catch {
      return [];
    }
    return manifest.private === true || manifest.name === undefined ? [] : [manifest.name];
  });
}

const packages = [...published("packages"), ...published("packages/adapters")].sort();

describe("the package reference", () => {
  it("generates exports for every published package", () => {
    const script = readFileSync(join(docs, "scripts/sync-reference.mjs"), "utf8");
    const listed = [...script.matchAll(/name: "(@mavna\/[^"]+)"/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(packages);
  });

  it("shows every published package on the packages page", () => {
    const page = readFileSync(join(docs, "content/developers/reference/packages.mdx"), "utf8");
    const shown = [...page.matchAll(/^## (@mavna\/\S+)$/gm)].map((m) => m[1]).sort();
    expect(shown).toEqual(packages);
  });
});
