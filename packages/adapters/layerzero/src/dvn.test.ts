import { describe, expect, it } from "vitest";
import {
  assertDvnStackIsSound,
  buildUlnSetConfig,
  CONFIG_TYPE_EXECUTOR,
  CONFIG_TYPE_ULN,
  describeDvnStack,
  isExplicitlyConfigured,
  type UlnConfig,
  verifierThreshold,
} from "./dvn.js";

/**
 * The verifier set, which is what the trust model actually is.
 *
 * The configuration used as the good case below is not invented: it is what
 * Tether's USDT0 adapter on Ethereum returns for the Stellar pathway, three
 * required DVNs at 65 confirmations, with the app's own config identical to the
 * merged one because it set every field itself.
 */

const usdt0OnEthereum: UlnConfig = {
  confirmations: 65n,
  requiredDVNCount: 3,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: [
    "0x3b0531eB02Ab4aD72e7a531180beeF9493a00dD2",
    "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
    "0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd",
  ],
  optionalDVNs: [],
};

/** Every count at zero. UlnBase reads that as "inherit", not as "none". */
const inheriting: UlnConfig = {
  confirmations: 0n,
  requiredDVNCount: 0,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: [],
  optionalDVNs: [],
};

describe("telling a chosen verifier set from an inherited one", () => {
  it("recognises a set the application configured", () => {
    expect(isExplicitlyConfigured(usdt0OnEthereum)).toBe(true);
  });

  /**
   * The distinction the whole module exists for. An application that set
   * nothing comes back from the endpoint looking fully configured, because
   * `getConfig` returns the merged result. Only the raw config shows the zeros.
   */
  it("recognises an application that set nothing", () => {
    expect(isExplicitlyConfigured(inheriting)).toBe(false);
  });

  it("counts required plus the optional threshold, not the optional pool", () => {
    expect(verifierThreshold(usdt0OnEthereum)).toBe(3);
    expect(
      verifierThreshold({
        ...usdt0OnEthereum,
        requiredDVNCount: 1,
        optionalDVNCount: 5,
        optionalDVNThreshold: 2,
      }),
    ).toBe(3);
  });
});

describe("refusing to send through a set nobody chose", () => {
  it("accepts a real, explicitly configured stack", () => {
    expect(() =>
      assertDvnStackIsSound({
        effective: usdt0OnEthereum,
        app: usdt0OnEthereum,
        oft: "0x6c96de32cea08842dcc4058c14d3aaad7fa41dee",
        eid: 30600,
      }),
    ).not.toThrow();
  });

  it("stops when the application is inheriting the network default", () => {
    expect(() =>
      assertDvnStackIsSound({
        // Merged, so it looks configured. This is exactly the trap.
        effective: usdt0OnEthereum,
        app: inheriting,
        oft: "0x0000000000000000000000000000000000000001",
        eid: 30600,
      }),
    ).toThrow(/inheriting the network default/);
  });

  it("stops when nothing at all would have to attest", () => {
    expect(() =>
      assertDvnStackIsSound({
        effective: { ...inheriting, requiredDVNCount: 255 },
        app: { ...inheriting, requiredDVNCount: 255 },
        oft: "0x0000000000000000000000000000000000000001",
        eid: 30600,
      }),
    ).toThrow(/no verifier that must attest/);
  });
});

describe("saying the trust model out loud", () => {
  // LayerZero's DVN metadata for ethereum, as it answered on 20 October 2026
  const names = new Map([
    ["0x3b0531eb02ab4ad72e7a531180beef9493a00dd2", "USDT0"],
    ["0x589dedbd617e0cbcb916a9223f4d1300c294236b", "LayerZero Labs"],
    ["0xa4fe5a5b9a846458a70cd0748228aed3bf65c2cd", "Canary"],
  ]);

  it("names every required verifier", () => {
    expect(describeDvnStack(usdt0OnEthereum, names)).toBe(
      "3 verifiers must all agree (USDT0, LayerZero Labs, Canary), after 65 source-chain " +
        "confirmations.",
    );
  });

  it("names one LayerZero does not list by its address, never by a guess", () => {
    const partial = new Map([...names].slice(1));
    expect(describeDvnStack(usdt0OnEthereum, partial)).toContain(
      "(0x3b0531eB02Ab4aD72e7a531180beeF9493a00dD2, LayerZero Labs, Canary)",
    );
  });

  it("gets the singular right, because copy a user reads should not be broken", () => {
    expect(
      describeDvnStack(
        {
          ...usdt0OnEthereum,
          requiredDVNCount: 1,
          requiredDVNs: ["0x589dEDbD617e0CBcB916A9223F4d1300c294236b"],
          confirmations: 1n,
        },
        names,
      ),
    ).toBe("1 verifier must agree (LayerZero Labs), after 1 source-chain confirmation.");
  });

  it("names an optional pool with no required verifier beside it", () => {
    expect(
      describeDvnStack(
        {
          ...usdt0OnEthereum,
          requiredDVNCount: 0,
          requiredDVNs: [],
          optionalDVNCount: 2,
          optionalDVNThreshold: 2,
          optionalDVNs: [
            "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
            "0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd",
          ],
        },
        names,
      ),
    ).toBe(
      "2 of 2 verifiers must agree (LayerZero Labs, Canary), after 65 source-chain confirmations.",
    );
  });

  it("names the optional pool and how many of it must agree", () => {
    expect(
      describeDvnStack(
        {
          ...usdt0OnEthereum,
          requiredDVNCount: 1,
          requiredDVNs: ["0x3b0531eB02Ab4aD72e7a531180beeF9493a00dD2"],
          optionalDVNCount: 2,
          optionalDVNThreshold: 1,
          optionalDVNs: [
            "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
            "0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd",
          ],
        },
        names,
      ),
    ).toBe(
      "1 verifier must agree (USDT0), and 1 more of 2 (LayerZero Labs, Canary), after 65 " +
        "source-chain confirmations.",
    );
  });
});

describe("setting a verifier set explicitly", () => {
  it("encodes a config the send library will accept", () => {
    const param = buildUlnSetConfig({
      eid: 30600,
      confirmations: 65n,
      requiredDVNs: [
        "0x3b0531eb02ab4ad72e7a531180beef9493a00dd2",
        "0x589dedbd617e0cbcb916a9223f4d1300c294236b",
      ],
    });
    expect(param.eid).toBe(30600);
    expect(param.configType).toBe(CONFIG_TYPE_ULN);
    expect(CONFIG_TYPE_EXECUTOR).toBe(1);
    // Head of a single dynamic tuple, so the first word is the offset 0x20.
    expect(param.config.slice(0, 66)).toBe(`0x${"0".repeat(62)}20`);
    expect(param.config).toContain("3b0531eb02ab4ad72e7a531180beef9493a00dd2");
  });

  /**
   * The contract sorts nothing and reverts on the first pair out of order, so
   * catching it here is the difference between a message that explains itself
   * and a revert that does not.
   */
  it("refuses an unsorted list, which the contract would reject anyway", () => {
    expect(() =>
      buildUlnSetConfig({
        eid: 30600,
        confirmations: 65n,
        requiredDVNs: [
          "0x589dedbd617e0cbcb916a9223f4d1300c294236b",
          "0x3b0531eb02ab4ad72e7a531180beef9493a00dd2",
        ],
      }),
    ).toThrow(/sorted ascending/);
  });

  it("refuses a duplicate, which sorting alone would not catch", () => {
    expect(() =>
      buildUlnSetConfig({
        eid: 30600,
        confirmations: 65n,
        requiredDVNs: [
          "0x3b0531eb02ab4ad72e7a531180beef9493a00dd2",
          "0x3b0531eb02ab4ad72e7a531180beef9493a00dd2",
        ],
      }),
    ).toThrow(/no duplicates/);
  });

  it("refuses a configuration that would verify nothing", () => {
    expect(() => buildUlnSetConfig({ eid: 30600, confirmations: 65n, requiredDVNs: [] })).toThrow(
      /verifies nothing/,
    );
  });

  it("refuses a threshold more optional DVNs than exist could meet", () => {
    expect(() =>
      buildUlnSetConfig({
        eid: 30600,
        confirmations: 65n,
        requiredDVNs: ["0x3b0531eb02ab4ad72e7a531180beef9493a00dd2"],
        optionalDVNs: ["0x589dedbd617e0cbcb916a9223f4d1300c294236b"],
        optionalThreshold: 2,
      }),
    ).toThrow(/cannot be met/);
  });
});
