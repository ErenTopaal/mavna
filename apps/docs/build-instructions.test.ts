import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// a production build of the app, playground, landing and docs stops without a
// sponsor url, so every documented `pnpm build` has to set both first
const repo = fileURLToPath(new URL("../..", import.meta.url));
const PAGES = ["README.md", "apps/docs/content/developers/install.mdx"];

function blocksWithBuild(text: string): string[] {
  return [...text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .filter((block) => /^pnpm build\b/m.test(block));
}

describe("documented builds", () => {
  for (const page of PAGES) {
    it(`${page} sets both sponsor urls before pnpm build`, () => {
      const blocks = blocksWithBuild(readFileSync(`${repo}${page}`, "utf8"));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const before = block.slice(0, block.search(/^pnpm build\b/m));
        expect(before).toMatch(/VITE_MAVNA_SPONSOR_URL=\S+/);
        expect(before).toMatch(/NEXT_PUBLIC_MAVNA_SPONSOR_URL=\S+/);
      }
    });
  }
});
