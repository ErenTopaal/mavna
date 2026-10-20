import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Compose installs inside a Linux container. Mounted writable, or with volumes
// nested in it, the checkout would get Linux packages in its node_modules and,
// on a Linux host, root-owned mount points Docker creates for nested volumes.
// So the checkout is mounted read-only, nothing is mounted inside it, and the
// build copies it into a volume of its own.
const repo = fileURLToPath(new URL("..", import.meta.url));

interface Service {
  volumes?: string[];
  command?: string;
}
const compose = parse(readFileSync(join(repo, "docker-compose.yml"), "utf8")) as {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};
const named = new Set(Object.keys(compose.volumes ?? {}));

function mounts(service: Service): { source: string; target: string; mode: string }[] {
  return (service.volumes ?? []).map((entry) => {
    const [source = "", target = "", mode = "rw"] = entry.split(":");
    return { source, target, mode };
  });
}

const isHostPath = (source: string): boolean => !named.has(source);
const inside = (path: string, parent: string): boolean =>
  path !== parent && path.startsWith(`${parent.replace(/\/$/, "")}/`);

describe("docker compose", () => {
  const services = Object.entries(compose.services);

  it("mounts every host path read-only", () => {
    const writable = services.flatMap(([name, service]) =>
      mounts(service)
        .filter((m) => isHostPath(m.source) && m.mode !== "ro")
        .map((m) => `${name}: ${m.source}:${m.target}`),
    );
    expect(writable).toEqual([]);
  });

  it("mounts nothing inside a host path", () => {
    const nested = services.flatMap(([name, service]) => {
      const all = mounts(service);
      const hostTargets = all.filter((m) => isHostPath(m.source)).map((m) => m.target);
      return all
        .filter((m) => hostTargets.some((t) => inside(m.target, t)))
        .map((m) => `${name}: ${m.target}`);
    });
    expect(nested).toEqual([]);
  });

  it("copies the checkout into the build volume before installing", () => {
    const command = compose.services.build?.command ?? "";
    const synced = command.indexOf("compose-sync.mjs /src /repo");
    expect(synced).toBeGreaterThanOrEqual(0);
    expect(synced).toBeLessThan(command.indexOf("pnpm install"));
  });

  it("serves the app and the sponsor from what the build built", () => {
    const repoVolume = (service: Service | undefined) =>
      mounts(service ?? {}).find((m) => m.target === "/repo")?.source;
    const built = repoVolume(compose.services.build);
    expect(built !== undefined && named.has(built)).toBe(true);
    expect(repoVolume(compose.services.app)).toBe(built);
    expect(repoVolume(compose.services.sponsor)).toBe(built);
  });
});
