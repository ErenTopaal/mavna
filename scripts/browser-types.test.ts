import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * These packages run in browsers, which have no Node globals. Their shipped
 * source is checked against browser types only, so the type checker itself
 * refuses a `Buffer` or a `process` before a bundle ever meets a page.
 * Tests and fixtures keep Node types through each package's tsconfig.test.json.
 */
const repo = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(repo, "node_modules", ".bin", "tsc");

const SHIPPED = [
  "packages/core",
  "packages/stellar",
  "packages/routing",
  "packages/status",
  "packages/swap",
  "packages/widget",
  "packages/adapters/axelar",
  "packages/adapters/cctp",
  "packages/adapters/layerzero",
  "packages/adapters/near-intents",
];

/** Type-check one file under a package's shipped settings. */
function check(pkg: string, source: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(repo, pkg, ".probe-"));
  try {
    writeFileSync(join(dir, "probe.ts"), source);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { rootDir: ".", isolatedDeclarations: false },
        include: ["probe.ts"],
      }),
    );
    const result = spawnSync(tsc, ["--noEmit", "-p", dir], { encoding: "utf8" });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(SHIPPED)("the shipped source of %s", (pkg) => {
  it("may not use Node's Buffer or process", { timeout: 60_000 }, () => {
    const result = check(
      pkg,
      'export const bytes = Buffer.from("x");\nexport const mode = process.env.NODE_ENV;\n',
    );
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Cannot find name 'Buffer'");
    expect(result.out).toContain("Cannot find name 'process'");
  });

  it("still has what browsers provide", { timeout: 60_000 }, () => {
    const result = check(
      pkg,
      'export const asked = (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(1) });\nexport const bytes: Uint8Array = new TextEncoder().encode("x");\n',
    );
    expect(result.out).toBe("");
    expect(result.status).toBe(0);
  });
});
