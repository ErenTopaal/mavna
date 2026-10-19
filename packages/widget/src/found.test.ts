import type { Asset, StepPhase } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { foundFor } from "./found";

const USDC: Asset = {
  chainId: "stellar-testnet",
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

const ADDRESS_NOTE =
  "An address alone cannot identify a Circle transfer. Paste the source transaction hash to check one.";

describe("foundFor", () => {
  it("says an address cannot identify a transfer, and offers no finish", () => {
    for (const kind of ["destination-address", "deposit-address"] as const) {
      expect(foundFor({ phase: "idle" }, kind)).toEqual({
        tone: "wait",
        note: ADDRESS_NOTE,
        canFinish: false,
      });
    }
  });

  it("keeps the existing wording for a hash that has nothing yet", () => {
    expect(foundFor({ phase: "idle" }, "source-tx")).toEqual({
      tone: "wait",
      note: "Nothing has reached this address yet.",
      canFinish: true,
    });
  });

  it("reports a proven delivery the same whatever the key", () => {
    const done: StepPhase = {
      phase: "done",
      ref: { chainId: "ethereum-sepolia", txHash: "0x2811", explorerUrl: "" },
      received: { asset: USDC, baseUnits: "10000000" },
    };
    for (const kind of ["source-tx", "destination-address"] as const) {
      expect(foundFor(done, kind)).toEqual({
        tone: "ok",
        note: "Delivered on Stellar. 1.00 USDC arrived.",
        canFinish: false,
      });
    }
  });
});
