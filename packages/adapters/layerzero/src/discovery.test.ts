import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { Discovery } from "./discovery.js";

/**
 * Discovery must not remember its own bad moments.
 *
 * A registry that failed once is not a registry that is gone, and a node that
 * would not answer is not a token with no route. Only the network is doubled.
 */

const REGISTRY = {
  "stellar-testnet": {
    deployments: [
      {
        version: 2,
        eid: "40600",
        endpointV2: { address: "CENDPOINT" },
        sendUln302: { address: "CULN" },
        executor: { address: "CEXEC" },
      },
    ],
  },
};

const rpc = new RpcClient({ url: "https://rpc.invalid" });

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("registry failures are not cached", () => {
  it("retries the stellar deployment after a rejected first fetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok(REGISTRY);
    };
    const discovery = new Discovery({ network: "testnet", rpc, fetch: fetchImpl });

    await expect(discovery.stellar()).rejects.toThrow();
    await expect(discovery.stellar()).resolves.toMatchObject({ eid: 40600, endpoint: "CENDPOINT" });
  });

  it("retries the oft registry after a rejected first fetch", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok({
        USDT0: [
          {
            name: "USDT0",
            deployments: {
              ethereum: { address: "0x0000000000000000000000000000000000000001" },
            },
          },
        ],
      });
    };
    const discovery = new Discovery({ network: "mainnet", rpc, fetch: fetchImpl });

    await expect(discovery.candidatesFor("ethereum")).rejects.toThrow();
    const found = await discovery.candidatesFor("ethereum");
    expect(found).toHaveLength(1);
  });
});

describe("a route that fails for a reason that may pass", () => {
  const oft = {
    chainId: "ethereum-sepolia",
    address: "0x0000000000000000000000000000000000000002" as const,
    symbol: "TEST",
  };

  it("surfaces node failures as retryable", async () => {
    const fetchImpl: typeof fetch = async () => ok(REGISTRY);
    const evmFetch: typeof fetch = async () => new Response("down", { status: 503 });
    const discovery = new Discovery({
      network: "testnet",
      rpc,
      fetch: fetchImpl,
      evm: { fetch: evmFetch },
      ofts: [oft],
    });

    await expect(discovery.routeFrom("ethereum-sepolia")).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("stays permanent when every candidate is refused for good", async () => {
    const fetchImpl: typeof fetch = async () => ok(REGISTRY);
    // chain id right, no code at the address: a settled answer.
    const evmFetch: typeof fetch = async (_url, init) => {
      const { method } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method: string;
      };
      return ok({ result: method === "eth_chainId" ? "0xaa36a7" : "0x" });
    };
    const discovery = new Discovery({
      network: "testnet",
      rpc,
      fetch: fetchImpl,
      evm: { fetch: evmFetch },
      ofts: [oft],
    });

    await expect(discovery.routeFrom("ethereum-sepolia")).rejects.toMatchObject({
      retryable: false,
    });
  });
});
