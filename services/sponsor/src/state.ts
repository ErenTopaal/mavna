import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapStore, CapUsage } from "./caps.js";

/**
 * Where the sponsor keeps what must outlive the process: the caps, what it
 * built, the settlements it holds and the channels those settlements sit on.
 *
 * Losing any of these on a restart costs money or users. A cap that resets is
 * no cap; a held settlement that vanishes leaves a reserve unrepaid; a channel
 * key that vanishes leaves a funded account nobody can use, and a lease that
 * vanishes hands a live sequence to a second settlement.
 *
 * Whole documents rather than records, because each is small (bounded by the
 * channel pool and the caps) and a whole-document write is atomic on a rename.
 */
export interface DocumentStore {
  /** The document as last written, or undefined if it never was. */
  read(name: string): Promise<unknown>;
  /** Replace the document. Resolves once it would survive a crash. */
  write(name: string, value: unknown): Promise<void>;
}

/** For tests and for running without a state directory. Dies with the process. */
export class MemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, string>();

  async read(name: string): Promise<unknown> {
    const text = this.documents.get(name);
    return text === undefined ? undefined : JSON.parse(text);
  }

  async write(name: string, value: unknown): Promise<void> {
    // Serialised, so a caller that keeps mutating the object it passed cannot
    // change what was stored, the same as with the file store.
    this.documents.set(name, JSON.stringify(value));
  }
}

const DOCUMENT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * One JSON file per document in a directory only the process owner can read,
 * since the channel document holds secret keys.
 *
 * Each write goes to a temporary file that is then renamed over the old one,
 * so a crash mid-write leaves the previous version rather than half of each.
 * Writes to one document are queued, so the last one asked for is the one that
 * lands.
 */
export class FileDocumentStore implements DocumentStore {
  private readonly dir: string;
  private ready: Promise<void> | undefined;
  private readonly queues = new Map<string, Promise<void>>();
  private sequence = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  async read(name: string): Promise<unknown> {
    const path = this.pathFor(name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      // Starting empty would forget held settlements and reset the caps, which
      // is the failure this store exists to prevent, so it stops here instead.
      throw new Error(`The sponsor's ${name} state at ${path} is not readable JSON.`, { cause });
    }
  }

  write(name: string, value: unknown): Promise<void> {
    let path: string;
    try {
      path = this.pathFor(name);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await this.ensureDir();
        this.sequence += 1;
        const temporary = `${path}.${process.pid}.${this.sequence}.tmp`;
        await writeFile(temporary, text, { mode: 0o600, flush: true });
        await rename(temporary, path);
      });
    this.queues.set(name, next);
    void next.finally(() => {
      if (this.queues.get(name) === next) this.queues.delete(name);
    });
    return next;
  }

  private pathFor(name: string): string {
    if (!DOCUMENT_NAME.test(name)) throw new Error(`Not a usable document name: "${name}".`);
    return join(this.dir, `${name}.json`);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() =>
      // mkdir's mode is masked by the umask, and an existing directory keeps
      // whatever it had, so the permission is set outright.
      chmod(this.dir, 0o700),
    );
    return this.ready;
  }
}

/** How many days of cap counts are kept. Only today's is ever read. */
const CAP_DAYS_KEPT = 3;

/** The caps' storage, as one document of recent days. */
export class DocumentCapStore implements CapStore {
  private readonly store: DocumentStore;

  constructor(store: DocumentStore) {
    this.store = store;
  }

  async load(day: string): Promise<CapUsage | undefined> {
    return (await this.days())[day];
  }

  async save(usage: CapUsage): Promise<void> {
    const days = { ...(await this.days()), [usage.day]: usage };
    const kept = Object.keys(days).sort().slice(-CAP_DAYS_KEPT);
    await this.store.write("caps", Object.fromEntries(kept.map((day) => [day, days[day]])));
  }

  private async days(): Promise<Record<string, CapUsage>> {
    return ((await this.store.read("caps")) as Record<string, CapUsage> | undefined) ?? {};
  }
}
