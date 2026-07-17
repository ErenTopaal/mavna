import { describe, expect, it } from "vitest";
import { AttestationService } from "./attestation.js";
import { CCTP_DOMAINS, STELLAR_DOMAIN } from "./config.js";

/**
 * Against Circle's live attestation service. Public, no key required.
 *
 * Deliberately gentle: the service blocks ALL requests for five minutes once its
 * rate limit trips, so a test that hammers it would poison every later run.
 */

const service = new AttestationService("testnet");

describe("Circle's fee service, live", () => {
  it("prices the standard transfer at zero from Ethereum", async () => {
    const fees = await service.fees(0, STELLAR_DOMAIN);
    const standard = fees.find((f) => f.finalityThreshold === 2000);
    expect(standard).toBeDefined();
    // Free is the whole commercial argument: anyone reselling this route has to
    // add their margin on top of zero.
    expect(standard?.minimumFee).toBe(0);
  });

  it("offers exactly two thresholds and no more", async () => {
    const fees = await service.fees(0, STELLAR_DOMAIN);
    // An explicit comparator, because the default sorts numbers as strings and
    // would happily pass on [1000, 2000] while silently mis-ordering any other
    // pair of thresholds Circle might introduce.
    expect(fees.map((f) => f.finalityThreshold).sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  it("refuses a pair it does not route rather than returning a misleading zero", async () => {
    // BNB Smart Chain is documented as supported but is not routable to Stellar.
    await expect(service.fees(17, STELLAR_DOMAIN)).rejects.toThrow(/does not route/);
  });

  it("offers the fast path FROM Stellar too, contradicting the project spec", async () => {
    // The specification says Stellar is standard-only as a source. It is not:
    // Circle marks fast "not necessary" there because Stellar finalises in about
    // five seconds, which is a different claim from unavailable.
    const fees = await service.fees(STELLAR_DOMAIN, 0);
    expect(fees.find((f) => f.finalityThreshold === 1000)?.minimumFee).toBe(0);
  });

  it("treats an unseen transfer as not-yet-known rather than an error", async () => {
    const none = await service.byTransaction(
      0,
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    // A transfer the service has not indexed yet is the normal state for the
    // first minutes. It must never be reported as a failure.
    expect(none).toEqual([]);
  });
});

describe("the domain table", () => {
  it("omits BNB, which Circle documents but does not route to Stellar", () => {
    expect(CCTP_DOMAINS[17]).toBeUndefined();
  });

  it("covers the chains that were measured as routable", () => {
    for (const domain of [0, 1, 3, 5, 6, 7, 25]) {
      expect(CCTP_DOMAINS[domain], `domain ${domain} should be known`).toBeDefined();
    }
  });
});
