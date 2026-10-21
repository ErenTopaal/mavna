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

const ALL = ["cctp", "axelar", "layerzero"];

describe("foundFor", () => {
  it("says an address cannot identify a transfer, naming the rail when only one was asked", () => {
    for (const kind of ["destination-address", "deposit-address"] as const) {
      expect(foundFor({ phase: "idle" }, kind, ["cctp"])).toEqual({
        tone: "wait",
        note: "An address alone cannot identify a Circle transfer. Paste the source transaction hash to check one.",
        canFinish: false,
      });
      expect(foundFor({ phase: "idle" }, kind, ["layerzero"]).note).toBe(
        "An address alone cannot identify a LayerZero transfer. Paste the source transaction hash to check one.",
      );
      expect(foundFor({ phase: "idle" }, kind, ALL)).toEqual({
        tone: "wait",
        note: "An address alone cannot identify a transfer. Paste the source transaction hash to check one.",
        canFinish: false,
      });
    }
  });

  it("treats a NEAR Intents deposit address as the key it is, not as an address alone", () => {
    for (const rails of [["near-intents"], [...ALL, "near-intents"]]) {
      expect(foundFor({ phase: "idle" }, "deposit-address", rails)).toEqual({
        tone: "wait",
        note: "Nothing has been found for this deposit address yet.",
        canFinish: false,
      });
    }
    // A Stellar address still names no NEAR Intents deposit.
    expect(foundFor({ phase: "idle" }, "destination-address", ["near-intents"]).note).toBe(
      "An address alone cannot identify a NEAR Intents transfer. Paste the source transaction hash to check one.",
    );
  });

  // no rail has a record of the hash: it is not on its way, and there is no
  // delivery to finish, so neither is said nor offered
  it("says a hash no rail knows was not found, and offers nothing to finish", () => {
    expect(foundFor({ phase: "idle" }, "source-tx", ALL)).toEqual({
      tone: "wait",
      note:
        "No rail has a record of this transaction. One sent in the last minute may not be " +
        "listed yet, so check again shortly; otherwise check it is the hash from the chain " +
        "you sent from.",
      canFinish: false,
    });
  });

  it("offers to finish only where finishing means something, which is a Circle delivery", () => {
    const ref = { chainId: "arbitrum-sepolia", txHash: "0xab", explorerUrl: "" };
    const stalled: StepPhase = {
      phase: "stalled",
      ref,
      overdueSeconds: 900,
      remedy: {
        kind: "add-gas",
        chainId: "arbitrum-sepolia",
        because: "Paying the rest releases it.",
      },
    };
    expect(foundFor(stalled, "source-tx", ["cctp"])).toEqual({
      tone: "wait",
      note: "Taking longer than usual. Finishing the delivery is safe to try.",
      canFinish: true,
    });
    expect(foundFor(stalled, "source-tx", ["axelar"])).toEqual({
      tone: "wait",
      note: "Taking longer than usual. Paying the rest releases it.",
      canFinish: false,
    });
    const onItsWay: StepPhase = { phase: "pending", ref, expectedByUnix: 0 };
    expect(foundFor(onItsWay, "source-tx", ["layerzero"]).canFinish).toBe(false);
    expect(foundFor(onItsWay, "source-tx", ALL).canFinish).toBe(true);
    expect(foundFor({ phase: "idle" }, "source-tx", ["axelar"]).canFinish).toBe(false);
  });

  it("reports a proven delivery the same whatever the key", () => {
    const done: StepPhase = {
      phase: "done",
      ref: { chainId: "ethereum-sepolia", txHash: "0x2811", explorerUrl: "" },
      received: { asset: USDC, baseUnits: "10000000" },
    };
    for (const kind of ["source-tx", "destination-address"] as const) {
      expect(foundFor(done, kind, ALL)).toEqual({
        tone: "ok",
        note: "Delivered on Stellar. 1.00 USDC arrived.",
        canFinish: false,
      });
    }
  });

  it("shows a delivery it cannot read back as information, with the transaction to check", () => {
    const found = foundFor(UNVERIFIED, "source-tx", ["axelar"]);
    expect(found.tone).toBe("info");
    expect(found.canFinish).toBe(false);
    expect(found.note).toContain("too old to read back");
    expect(found.link).toEqual({
      href: UNVERIFIED.ref.explorerUrl,
      label: "See the Stellar transaction",
    });
  });
});

const UNVERIFIED = {
  phase: "delivered-unverified",
  ref: {
    chainId: "stellar",
    txHash: "9f3c11aa22bb33cc44dd55ee66ff77009f3c11aa22bb33cc44dd55ee66ff7700",
    explorerUrl:
      "https://stellar.expert/explorer/public/tx/9f3c11aa22bb33cc44dd55ee66ff77009f3c11aa22bb33cc44dd55ee66ff7700",
  },
  because: "Axelar records it executed on Stellar, and that transaction is too old to read back.",
} as const satisfies StepPhase;
