import { MavnaError } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SELECTORS } from "./abi.js";
import { EvmReader, EvmRevert, fetchEthCall } from "./evm.js";

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
