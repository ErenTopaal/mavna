import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The repository is Apache-2.0 (LICENSE). Every manifest that publishes a
 * license, npm or cargo, has to say the same, or a package goes out under terms
 * the repository does not grant.
 */
const repo = fileURLToPath(new URL("..", import.meta.url));
const tracked = (pattern: string): string[] =>
  execFileSync("git", ["ls-files", pattern], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "");

describe("the license every manifest declares", () => {
  it("is the repository's own", () => {
    expect(readFileSync(`${repo}/LICENSE`, "utf8")).toMatch(/Apache License\s+Version 2\.0/);
  });

  it("is Apache-2.0 in every npm package that declares one", () => {
    const declared = tracked("*package.json").flatMap((path) => {
      const license = (JSON.parse(readFileSync(`${repo}/${path}`, "utf8")) as { license?: string })
        .license;
      return license === undefined ? [] : [[path, license]];
    });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(([, license]) => license !== "Apache-2.0")).toEqual([]);
  });

  it("is Apache-2.0 in every crate", () => {
    const crates = tracked("*Cargo.toml").flatMap((path) => {
      const match = /^license\s*=\s*"([^"]*)"/m.exec(readFileSync(`${repo}/${path}`, "utf8"));
      return match === null ? [] : [[path, match[1]]];
    });
    expect(crates.length).toBeGreaterThan(0);
    expect(crates.filter(([, license]) => license !== "Apache-2.0")).toEqual([]);
  });
});
