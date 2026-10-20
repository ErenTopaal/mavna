import { RpcClient } from "@mavna/stellar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAYERZERO_METADATA_URL } from "./config.js";
import { Discovery } from "./discovery.js";
import { EvmReader } from "./evm.js";
import { ScanService } from "./scan.js";

/**
 * Fetch, called the way a browser insists on.
 *
 * A browser's `fetch` throws "Illegal invocation" unless `this` is the window
 * or nothing, and Node's does not care, so storing it on an object and calling
 * it as a method passed every test here while every quote in Chromium failed.
 * This fetch behaves like the browser's.
 */
function strictFetch(answer: (url: string) => unknown): typeof globalThis.fetch {
  return function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const url = input instanceof Request ? input.url : input.toString();
    const body =
      init?.body === undefined
        ? undefined
        : JSON.parse(typeof init.body === "string" ? init.body : "{}");
    return Promise.resolve(
      new Response(JSON.stringify(answer(body?.method ?? url)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } as typeof globalThis.fetch;
}

const registry = {
  "stellar-mainnet": {
    deployments: [
      {
        version: 2,
        eid: "30600",
        endpointV2: { address: "CENDPOINT" },
        sendUln302: { address: "CSEND" },
        executor: { address: "CEXEC" },
      },
    ],
  },
};
const answer = (what: string): unknown => {
  if (what === LAYERZERO_METADATA_URL) return registry;
  if (what === "eth_chainId") return { jsonrpc: "2.0", id: 1, result: "0xa4b1" };
  if (what === "eth_getCode") return { jsonrpc: "2.0", id: 1, result: "0x6080" };
  return { data: [] };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  ["injected", (f: typeof globalThis.fetch) => ({ fetch: f })],
  [
    "the global",
    (f: typeof globalThis.fetch) => {
      vi.stubGlobal("fetch", f);
      return {};
    },
  ],
])("with a browser's fetch, %s", (_, wire) => {
  it("reads LayerZero's registry", async () => {
    const options = wire(strictFetch(answer));
    const discovery = new Discovery({
      network: "mainnet",
      rpc: new RpcClient({ url: "https://soroban.test" }),
      ...options,
    });
    await expect(discovery.stellar()).resolves.toMatchObject({ eid: 30600 });
  });

  it("asks LayerZero Scan", async () => {
    const options = wire(strictFetch(answer));
    await expect(new ScanService("mainnet", options).byTransaction("0xab")).resolves.toEqual([]);
  });

  it("asks an EVM node", async () => {
    const options = wire(strictFetch(answer));
    const reader = new EvmReader(["https://arb.test"], 42161, options);
    await expect(reader.hasCode("0x0000000000000000000000000000000000000001")).resolves.toBe(true);
  });
});
