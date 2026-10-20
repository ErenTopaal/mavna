import { afterEach, describe, expect, it, vi } from "vitest";
import { OneClickApi } from "./api.js";

/**
 * A browser's `fetch` throws "Illegal invocation" unless `this` is the window
 * or nothing; Node's does not care. This one behaves like the browser's.
 */
function strictFetch(): typeof globalThis.fetch {
  return function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  } as typeof globalThis.fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("1Click, with a browser's fetch", () => {
  it("reads the token list through an injected fetch", async () => {
    await expect(new OneClickApi({ fetch: strictFetch() }).tokens()).resolves.toEqual([]);
  });

  it("reads the token list through the global fetch", async () => {
    vi.stubGlobal("fetch", strictFetch());
    await expect(new OneClickApi().tokens()).resolves.toEqual([]);
  });
});
