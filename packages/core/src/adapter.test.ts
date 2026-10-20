import { describe, expect, it } from "vitest";
import { isRejection } from "./adapter.js";
import { ReferenceAdapter, referenceRequest } from "./reference-adapter.js";

describe("the adapter interface", () => {
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
});
