import { ReferenceAdapter, referenceRequest } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { ALWAYS_OPEN, createCircuitBreaker, parseDisabledSources } from "./circuit.js";
import { raceAdapters } from "./race.js";

/**
 * Turning a source off without a release.
 *
 * The security rules require a way to stop routing through a degraded third
 * party that does not need a deploy, because the gap between knowing and being
 * able to ship is exactly when money is lost.
 */

describe("taking a source out of rotation", () => {
  it("declines with a reason rather than quietly disappearing", async () => {
    const adapter = new ReferenceAdapter();
    const result = await raceAdapters([adapter], referenceRequest, {
      breaker: createCircuitBreaker(() => [
        { adapterId: adapter.id, userFacingReason: "Circle is not available right now." },
      ]),
    });

    // A route that silently stops appearing reads as a product that has quietly
    // got worse. One that says it is off reads as a product that knows.
    expect(result.routes).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.explanation).toBe("Circle is not available right now.");
    expect(result.complete).toBe(true);
  });

  it("lets everything through when nobody has configured one", async () => {
    const result = await raceAdapters([new ReferenceAdapter()], referenceRequest, {
      breaker: ALWAYS_OPEN,
    });
    expect(result.routes.length + result.rejected.length).toBe(1);
  });

  it("reads the list at quote time, so a change needs no restart", () => {
    // Captured once, clearing it would need a redeploy, which is the entire
    // thing this exists to avoid.
    let disabled = [{ adapterId: "cctp", userFacingReason: "off" }];
    const breaker = createCircuitBreaker(() => disabled);

    expect(breaker.allows("cctp")).toBe(false);
    disabled = [];
    expect(breaker.allows("cctp")).toBe(true);
  });
});

describe("reading the list an operator typed under pressure", () => {
  it("takes ids with reasons", () => {
    expect(parseDisabledSources("cctp:Circle is degraded, axelar:relayers are down")).toEqual([
      { adapterId: "cctp", userFacingReason: "Circle is degraded" },
      { adapterId: "axelar", userFacingReason: "relayers are down" },
    ]);
  });

  it("still turns a source off when the reason was left out", () => {
    // A missing explanation is not a reason to keep routing money through
    // something somebody just switched off.
    expect(parseDisabledSources("cctp")).toEqual([
      { adapterId: "cctp", userFacingReason: "This route is turned off right now." },
    ]);
    expect(parseDisabledSources("cctp:")).toEqual([
      { adapterId: "cctp", userFacingReason: "This route is turned off right now." },
    ]);
  });

  it("treats nothing as nothing disabled", () => {
    expect(parseDisabledSources(undefined)).toEqual([]);
    expect(parseDisabledSources("")).toEqual([]);
    expect(parseDisabledSources("  ,  ")).toEqual([]);
  });
});
