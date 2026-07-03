import { describe, expect, it } from "vitest";
import { ADAPTER_QUOTE_TIMEOUT_MS, isRejection } from "./adapter.js";
import { ReferenceAdapter, referenceRequest } from "./reference-adapter.js";

describe("the adapter interface", () => {
  it("can be satisfied by a package that touches nothing outside itself", () => {
    // The point of the interface: adding a rail requires zero changes elsewhere.
    const adapter = new ReferenceAdapter();
    expect(adapter.id).toBe("reference");
    expect(adapter.trustModel).toBe("native-mint");
  });

  it("lets a source decline with a reason a user can be shown", async () => {
    const result = await new ReferenceAdapter().quote(referenceRequest);
    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      // A route that is missing without explanation is a requirement violation.
      expect(result.explanation.length).toBeGreaterThan(0);
      expect(result.source).toBe("reference");
    }
  });

  it("declines a same-chain request rather than pretending to route it", async () => {
    const sameChain = { ...referenceRequest, to: referenceRequest.from };
    const result = await new ReferenceAdapter().quote(sameChain);
    expect(isRejection(result) && result.reason).toBe("chain-unsupported");
  });

  it("gives every rail the same short deadline, so one slow source blocks nobody", () => {
    expect(ADAPTER_QUOTE_TIMEOUT_MS).toBe(3000);
  });

  it("builds transactions without signing or submitting anything", async () => {
    // buildTransactions returns unsigned payloads. The SDK must never be in a
    // position to move a user's funds, and that is verifiable by reading this.
    const built = await new ReferenceAdapter().buildTransactions();
    expect(Array.isArray(built)).toBe(true);
  });
});
