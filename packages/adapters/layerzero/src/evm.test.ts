import { describe, expect, it } from "vitest";
import { EvmReader } from "./evm.js";

/**
 * Which failures make a node untrustworthy and which are just a bad moment.
 *
 * Only the chain id disagreeing proves a URL is serving the wrong chain. A
 * dropped connection says nothing about the node, and ruling it out for good
 * would leave the reader with no endpoints after a brief network blip.
 */

const URL_A = "https://a.example";
const URL_B = "https://b.example";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("EvmReader endpoint trust", () => {
  it("keeps an endpoint after a transport error on eth_chainId", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { method } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method: string;
      };
      if (method === "eth_chainId") {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return json({ result: "0xaa36a7" });
      }
      return json({ result: "0x1234" });
    };
    const reader = new EvmReader([URL_A], 11155111, { fetch: fetchImpl });

    await expect(reader.call("0x01", "0x")).rejects.toMatchObject({ retryable: true });
    await expect(reader.call("0x01", "0x")).resolves.toBe("0x1234");
  });

  it("drops an endpoint that serves a different chain", async () => {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      const { method } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method: string;
      };
      if (method === "eth_chainId") {
        return json({ result: url === URL_A ? "0xa" : "0xaa36a7" });
      }
      return json({ result: "0x1234" });
    };
    const reader = new EvmReader([URL_A, URL_B], 11155111, { fetch: fetchImpl });

    await expect(reader.call("0x01", "0x")).resolves.toBe("0x1234");
    asked.length = 0;
    await reader.call("0x01", "0x");
    expect(asked.every((u) => u === URL_B)).toBe(true);
  });
});
