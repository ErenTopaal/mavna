import { MavnaError } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SELECTORS } from "./abi.js";
import { EvmReader, EvmRevert, fetchEthCall, forgetCheckedNodes } from "./evm.js";

/**
 * A node's JSON-RPC error is either the contract saying no or the node failing
 * to ask. Only the first is an answer about the token; the second is a retry.
 */

const NODE = "https://evm.test";
const SERVICE = "0xb5fb4be02232b1bba4dc8f81dc24c26980de9e3c";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function nodeAnswers(error: { code: number; message: string; data?: string }): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("JSON-RPC errors from an EVM node", () => {
  it("reads a revert as a revert", async () => {
    for (const error of [
      { code: 3, message: "execution reverted", data: "0x" },
      { code: -32000, message: "execution reverted" },
      { code: -32015, message: "VM execution error. Reverted 0x" },
    ]) {
      nodeAnswers(error);
      const failure = await fetchEthCall(NODE, SERVICE, "0x").catch((cause: unknown) => cause);
      expect(failure, error.message).toBeInstanceOf(EvmRevert);
    }
  });

  it("reads a busy or lagging node as a retry, not a revert", async () => {
    for (const error of [
      // observed from evm-rpc.sei-apis.com during the audit
      { code: -32000, message: "eth_call rejected due to rate limit: server busy" },
      { code: -32005, message: "limit exceeded" },
      { code: -32603, message: "internal error" },
      { code: -32000, message: "header not found" },
    ]) {
      nodeAnswers(error);
      const failure = await fetchEthCall(NODE, SERVICE, "0x").catch((cause: unknown) => cause);
      expect(failure, error.message).toBeInstanceOf(MavnaError);
      expect(failure, error.message).not.toBeInstanceOf(EvmRevert);
      expect((failure as MavnaError).retryable, error.message).toBe(true);
    }
  });
});

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");
const stringReturn = (value: string): string => {
  const hex = Array.from(new TextEncoder().encode(value), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `0x${word("20")}${word(value.length.toString(16))}${hex.padEnd(64, "0")}`;
};

describe("which token service version answers the trust question", () => {
  it("takes isTrustedChain from a 2.2.0 service", async () => {
    const reader = new EvmReader(NODE, async (_url, _to, data) => {
      if (data.startsWith(SELECTORS.isTrustedChain)) return `0x${word("1")}`;
      throw new Error("trustedAddress must not be asked when isTrustedChain answers");
    });
    expect(await reader.trustsChain(SERVICE, "stellar")).toBe(true);
  });

  it("falls back to trustedAddress on a 2.1 service, where isTrustedChain reverts", async () => {
    const answers = { hub: "hub", unknown: "" };
    for (const [answer, expected] of [
      [answers.hub, true],
      [answers.unknown, false],
    ] as const) {
      const reader = new EvmReader(NODE, async (_url, _to, data) => {
        if (data.startsWith(SELECTORS.isTrustedChain)) throw new EvmRevert("execution reverted");
        if (data.startsWith(SELECTORS.trustedAddress)) return stringReturn(answer);
        throw new Error("unexpected call");
      });
      expect(await reader.trustsChain(SERVICE, "stellar")).toBe(expected);
    }
  });

  it("does not fall back when the node is busy, because that is not a version answer", async () => {
    const reader = new EvmReader(NODE, async () => {
      throw new MavnaError("server busy", { retryable: true });
    });
    const failure = await reader.trustsChain(SERVICE, "stellar").catch((cause: unknown) => cause);
    expect(failure).not.toBeInstanceOf(EvmRevert);
    expect((failure as MavnaError).retryable).toBe(true);
  });
});

describe("failing over between a chain's nodes", () => {
  const BASE = 8453;
  const answers = (by: Record<string, number | Error>) => {
    const asked: string[] = [];
    const chainIdOf = async (url: string) => {
      asked.push(url);
      const answer = by[url];
      if (answer instanceof Error || answer === undefined) throw answer ?? new Error("no route");
      return answer;
    };
    return { asked, chainIdOf };
  };

  it("skips a dead node and one serving another chain, and reads through the next", async () => {
    forgetCheckedNodes();
    const { chainIdOf } = answers({
      "https://dead.invalid": new MavnaError("could not be reached", { retryable: true }),
      "https://wrong.chain": 10,
      "https://right.chain": BASE,
    });
    const called: string[] = [];
    const reader = new EvmReader(
      ["https://dead.invalid", "https://wrong.chain", "https://right.chain"],
      async (url) => {
        called.push(url);
        return `0x${word("1")}`;
      },
      { expectedChainId: BASE, chainIdOf },
    );
    expect(await reader.trustsChain(SERVICE, "stellar")).toBe(true);
    // nothing is read through a node until it has said it is this chain
    expect(called).toEqual(["https://right.chain"]);
  });

  it("asks each node its chain id once, not on every read", async () => {
    forgetCheckedNodes();
    const { asked, chainIdOf } = answers({ "https://right.chain": BASE });
    const read = () =>
      new EvmReader(["https://right.chain"], async () => `0x${word("1")}`, {
        expectedChainId: BASE,
        chainIdOf,
      }).trustsChain(SERVICE, "stellar");
    await read();
    await read();
    expect(asked).toEqual(["https://right.chain"]);
  });

  it("moves on when a confirmed node fails a read, but takes a revert as the answer", async () => {
    forgetCheckedNodes();
    const { chainIdOf } = answers({ "https://a.chain": BASE, "https://b.chain": BASE });
    const busyThenFine = new EvmReader(
      ["https://a.chain", "https://b.chain"],
      async (url) => {
        if (url === "https://a.chain") throw new MavnaError("server busy", { retryable: true });
        return `0x${word("1")}`;
      },
      { expectedChainId: BASE, chainIdOf },
    );
    expect(await busyThenFine.trustsChain(SERVICE, "stellar")).toBe(true);

    const called: string[] = [];
    const reverting = new EvmReader(
      ["https://a.chain", "https://b.chain"],
      async (url) => {
        called.push(url);
        throw new EvmRevert("execution reverted");
      },
      { expectedChainId: BASE, chainIdOf },
    );
    await expect(reverting.decimals(SERVICE)).rejects.toBeInstanceOf(EvmRevert);
    expect(called).toEqual(["https://a.chain"]);
  });

  it("is a retry when no node will say it is this chain", async () => {
    forgetCheckedNodes();
    const { chainIdOf } = answers({ "https://wrong.chain": 10 });
    const reader = new EvmReader(["https://wrong.chain"], async () => "0x", {
      expectedChainId: BASE,
      chainIdOf,
    });
    const failure = await reader.decimals(SERVICE).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
  });
});
