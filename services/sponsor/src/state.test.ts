import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapLedger } from "./caps.js";
import { DocumentCapStore, FileDocumentStore, MemoryDocumentStore } from "./state.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mavna-state-"));
  dirs.push(dir);
  return join(dir, "state");
}

describe("a file-backed store keeps what it was given across processes", () => {
  it("reads back a document written by another instance on the same directory", async () => {
    const dir = await freshDir();
    await new FileDocumentStore(dir).write("held", { a: 1 });
    expect(await new FileDocumentStore(dir).read("held")).toEqual({ a: 1 });
  });

  it("answers undefined for a document never written", async () => {
    expect(await new FileDocumentStore(await freshDir()).read("caps")).toBeUndefined();
  });

  it("keeps only the last of several writes made at once", async () => {
    const dir = await freshDir();
    const store = new FileDocumentStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, n) => store.write("built", { n })));
    expect(await new FileDocumentStore(dir).read("built")).toEqual({ n: 19 });
    // no temporary files left behind
    expect((await readdir(dir)).sort()).toEqual(["built.json"]);
  });

  it("keeps the directory and its files private to the process owner", async () => {
    const dir = await freshDir();
    await new FileDocumentStore(dir).write("channels", { secret: "S..." });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "channels.json"))).mode & 0o777).toBe(0o600);
  });

  it("refuses a document name that could leave the directory", async () => {
    const store = new FileDocumentStore(await freshDir());
    await expect(store.write("../escape", {})).rejects.toThrow(/document name/);
  });

  it("throws on a document that is not JSON rather than starting empty", async () => {
    const dir = await freshDir();
    const store = new FileDocumentStore(dir);
    await store.write("caps", {});
    await writeFile(join(dir, "caps.json"), "{not json");
    await expect(new FileDocumentStore(dir).read("caps")).rejects.toThrow(/caps/);
  });

  it("writes JSON a person can read", async () => {
    const dir = await freshDir();
    await new FileDocumentStore(dir).write("held", { b: [1, 2] });
    expect(JSON.parse(await readFile(join(dir, "held.json"), "utf8"))).toEqual({ b: [1, 2] });
  });
});

describe("an in-memory store", () => {
  it("hands back a copy, so a caller mutating its value cannot change what was stored", async () => {
    const store = new MemoryDocumentStore();
    const value = { list: [1] };
    await store.write("held", value);
    value.list.push(2);
    const read = (await store.read("held")) as { list: number[] };
    read.list.push(3);
    expect(await store.read("held")).toEqual({ list: [1] });
  });
});

describe("caps kept in a document store survive a restart", () => {
  it("counts a stranding recorded before the restart", async () => {
    const dir = await freshDir();
    const today = () => "2026-10-19";
    await new CapLedger(
      new DocumentCapStore(new FileDocumentStore(dir)),
      undefined,
      today,
    ).recordStranded();
    const after = new CapLedger(new DocumentCapStore(new FileDocumentStore(dir)), undefined, today);
    expect((await after.usage()).stranded).toBe(1);
  });

  it("keeps only the last few days", async () => {
    const backing = new MemoryDocumentStore();
    const caps = new DocumentCapStore(backing);
    for (let day = 1; day <= 10; day += 1) {
      await caps.save({
        day: `2026-10-${String(day).padStart(2, "0")}`,
        started: { "expensive-gas": 0, "cheap-gas": 0 },
        stranded: day,
      });
    }
    const kept = (await backing.read("caps")) as Record<string, unknown>;
    expect(Object.keys(kept).sort()).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
    expect((await caps.load("2026-10-10"))?.stranded).toBe(10);
  });
});
