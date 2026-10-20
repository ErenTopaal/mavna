import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// compose bind-mounts the checkout and installs inside a Linux container. Every
// node_modules the install writes must be a named volume, so the container's
// Linux packages and a host's own never share a directory.
const repo = fileURLToPath(new URL("..", import.meta.url));

interface Compose {
  services: Record<string, { volumes?: string[] }>;
  volumes?: Record<string, unknown>;
}

function workspaceDirs(): string[] {
  const { packages } = parse(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8")) as {
    packages: string[];
  };
  return packages.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) throw new Error(`unexpected workspace pattern ${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(join(repo, parent), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(repo, parent, e.name, "package.json")))
      .map((e) => `${parent}/${e.name}`);
  });
}

const compose = parse(readFileSync(join(repo, "docker-compose.yml"), "utf8")) as Compose;
const named = new Set(Object.keys(compose.volumes ?? {}));
const dirs = ["", ...workspaceDirs()];

describe("docker compose", () => {
  const mounting = Object.entries(compose.services).flatMap(([name, service]) => {
    const binds = (service.volumes ?? [])
      .map((entry) => entry.split(":"))
      .filter(([source]) => source === "." || source === "./");
    return binds.map(([, target]) => ({
      name,
      target: target ?? "",
      volumes: service.volumes ?? [],
    }));
  });

  it("bind-mounts the checkout somewhere", () => {
    expect(mounting.length).toBeGreaterThan(0);
    expect(dirs.length).toBeGreaterThan(10);
  });

  for (const { name, target, volumes } of mounting) {
    it(`${name} keeps every node_modules under ${target} on a named volume`, () => {
      const byTarget = new Map(volumes.map((entry) => [entry.split(":")[1], entry.split(":")[0]]));
      const shared = dirs
        .map((dir) => `${target}${dir === "" ? "" : `/${dir}`}/node_modules`)
        .filter((path) => !named.has(byTarget.get(path) ?? ""));
      expect(shared).toEqual([]);
    });
  }
});
