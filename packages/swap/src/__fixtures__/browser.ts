import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { build } from "tsdown";

/**
 * Bundles `entry` for the browser and evaluates it in a context with no
 * `Buffer`, returning what the entry exports.
 *
 * Deleting the global in this process is not enough: stellar-sdk's node build
 * (through base32.js) uses it, while its browser build does not, so only a
 * browser-resolved bundle tells our code apart from the sdk's.
 */
export async function loadInBrowser<T>(
  entry: string,
  globals: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const outDir = mkdtempSync(join(tmpdir(), "mavna-browser-"));
  try {
    await build({
      entry: { bundle: entry },
      outDir,
      platform: "browser",
      format: "iife",
      globalName: "bundle",
      noExternal: [/./],
      dts: false,
      config: false,
      logLevel: "silent",
    });
    const file = readdirSync(outDir).find((f) => f.endsWith(".js"));
    if (file === undefined) throw new Error(`bundling ${entry} produced no script`);
    const context = vm.createContext({
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      Response,
      Headers,
      URL,
      crypto,
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      fetch: () => Promise.reject(new Error("this test did not expect a request")),
      ...globals,
    });
    vm.runInContext(readFileSync(join(outDir, file), "utf8"), context);
    if (vm.runInContext("typeof Buffer", context) !== "undefined") {
      throw new Error("the bundle defined a Buffer global, so this proves nothing");
    }
    return context.bundle as T;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
