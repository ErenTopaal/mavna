import { MavnaError } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttestationService } from "./attestation.js";

/**
 * Circle's service is the sole price source on this rail and the only way a
 * burn is found again. One that accepts the connection and then says nothing
 * must not hold a quote or a status check forever.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A host that takes the request and never answers, unless the caller gives up. */
function silentHost(): number[] {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const asked: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    asked.push(ms);
    return original(1);
  });
  vi.stubGlobal(
    "fetch",
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  return asked;
}

describe("timeouts on Circle's attestation service", () => {
  it("gives up on a burn lookup and says so as retryable", async () => {
    const asked = silentHost();
    const failure = await new AttestationService("testnet")
      .byTransaction(0, `0x${"ab".repeat(32)}`)
      .catch((cause: unknown) => cause);

    expect(asked).toEqual([15_000]);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
  });

  it("gives up on a fee lookup and says so as retryable", async () => {
    const asked = silentHost();
    const failure = await new AttestationService("testnet")
      .fees(0, 27)
      .catch((cause: unknown) => cause);

    expect(asked).toEqual([15_000]);
    expect(failure).toBeInstanceOf(MavnaError);
    expect((failure as MavnaError).retryable).toBe(true);
  });

  it("reports a host that cannot be reached as retryable rather than a raw TypeError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    for (const call of [
      () => new AttestationService("testnet").byNonce(0, "0x01"),
      () => new AttestationService("testnet").fees(0, 27),
    ]) {
      const failure = await call().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(MavnaError);
      expect((failure as MavnaError).retryable).toBe(true);
    }
  });

  it("treats a rate limited fee lookup as a retry", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    const failure = await new AttestationService("testnet")
      .fees(0, 27)
      .catch((cause: unknown) => cause);
    expect((failure as MavnaError).retryable).toBe(true);
  });
});
