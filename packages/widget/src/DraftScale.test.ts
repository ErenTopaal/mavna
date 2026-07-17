import type { Amount, Asset, OnChainRef, Remedy } from "@mavna/core";
import { describe, expect, it } from "vitest";
import { actionLabel, blockedNote, humanDuration, needsUser, noteFor } from "./DraftScale.js";

const USDC: Asset = {
  chainId: "stellar-testnet",
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

const XLM: Asset = { ...USDC, id: "native", symbol: "XLM", curatedBy: "Stellar" };

const amount = (asset: Asset, baseUnits: string): Amount => ({ asset, baseUnits });

const ref: OnChainRef = {
  chainId: "ethereum-sepolia",
  txHash: "0xa4a4308d0b7692da6f377d9c8f8a131cee8110a32dd218f6c55b1c5a7f046660",
  explorerUrl: "https://sepolia.etherscan.io/tx/0xa4a4",
};

describe("needsUser", () => {
  it("is true exactly when nothing more happens without the user", () => {
    expect(needsUser({ phase: "pending", ref, expectedByUnix: 0 })).toBe(false);
    expect(needsUser({ phase: "idle" })).toBe(false);
    expect(needsUser({ phase: "done", ref, received: amount(USDC, "1") })).toBe(false);
    expect(
      needsUser({ phase: "blocked", blocked: { kind: "needs-signature", signaturesRemaining: 1 } }),
    ).toBe(true);
  });
});

describe("noteFor", () => {
  const step = (phase: Parameters<typeof noteFor>[0]["phase"]) => ({
    id: "bridge",
    label: "Move your funds to Stellar",
    phase,
  });

  it("says nothing about a step that has not started", () => {
    expect(noteFor(step({ phase: "idle" }))).toBeUndefined();
  });

  /**
   * Preparing and settling an account receive nothing. "0 XLM arrived" described
   * a payment that never happened, and shipped once before this test existed.
   */
  it("omits the amount on a done step that received nothing", () => {
    expect(noteFor(step({ phase: "done", ref, received: amount(XLM, "0") }))).toBeUndefined();
  });

  it("reports what arrived when something did", () => {
    expect(noteFor(step({ phase: "done", ref, received: amount(USDC, "247500000") }))).toBe(
      "24.75 USDC arrived.",
    );
  });

  it("names where a refund went, since that is the one thing a user checks", () => {
    const note = noteFor(
      step({
        phase: "refunded",
        ref,
        to: "0x9F2c8A5b1D3e4F60718293A4b5C6d7E8f9012345",
        returned: amount(USDC, "250000000"),
      }),
    );
    expect(note).toBe("Returned to 0x9F…2345. 25 USDC came back.");
  });

  it("carries the reason forward on a stall rather than only the delay", () => {
    const note = noteFor(
      step({
        phase: "stalled",
        ref,
        overdueSeconds: 1_140,
        remedy: { kind: "wait", untilUnix: 0, because: "Circle has not signed off yet." },
      }),
    );
    expect(note).toBe(
      "Still waiting after 19 minutes longer than expected. Circle has not signed off yet.",
    );
  });

  it("states both halves of a partial delivery", () => {
    const note = noteFor(
      step({
        phase: "partial",
        ref,
        received: amount(USDC, "120000000"),
        expected: amount(USDC, "247500000"),
        remedy: { kind: "add-gas", chainId: "stellar-testnet", because: "Held at the bridge." },
      }),
    );
    expect(note).toContain("12 of 24.75 USDC");
  });
});

describe("blockedNote", () => {
  it("gives the count only when there is more than one left to sign", () => {
    expect(blockedNote({ kind: "needs-signature", signaturesRemaining: 1 })).toBe(
      "Approve this in your wallet.",
    );
    expect(blockedNote({ kind: "needs-signature", signaturesRemaining: 2 })).toBe(
      "Approve this in your wallet. 2 approvals left.",
    );
  });

  it("names both networks on a switch, so the instruction is followable", () => {
    expect(
      blockedNote({
        kind: "needs-network-switch",
        currentChainId: "ethereum",
        requiredChainId: "ethereum-sepolia",
      }),
    ).toBe("Switch your wallet from ethereum to ethereum-sepolia.");
  });
});

describe("actionLabel", () => {
  /**
   * "Add gas" is what every other bridge writes on this button. It names a
   * mechanism the user did not ask about; they are paying so the transfer
   * finishes, so the button says that.
   */
  it("names the outcome rather than the mechanism for a gas top-up", () => {
    const remedy: Remedy = { kind: "add-gas", chainId: "stellar", because: "" };
    expect(actionLabel(remedy)).toBe("Pay to finish delivery");
  });

  it("gives an unrecoverable failure an action anyway", () => {
    expect(actionLabel({ kind: "unrecoverable", because: "" })).toBe("See what happened");
  });
});

describe("humanDuration", () => {
  it("uses the unit a person would say out loud", () => {
    expect(humanDuration(45)).toBe("45 seconds");
    expect(humanDuration(1_140)).toBe("19 minutes");
    expect(humanDuration(7_200)).toBe("2 hours");
    expect(humanDuration(259_200)).toBe("3 days");
  });

  it("never reports a negative wait", () => {
    expect(humanDuration(-30)).toBe("0 seconds");
  });
});
