import type { Amount, Asset, ChainRef, OnChainRef, Route } from "@mavna/core";
import { describe, expect, it } from "vitest";
import type { ScaleStep } from "./DraftScale.js";
import { settledAmount } from "./TransferPanel.js";

const SEPOLIA: ChainRef = {
  id: "ethereum-sepolia",
  name: "Sepolia",
  explorerTxUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
};

const STELLAR: ChainRef = {
  id: "stellar-testnet",
  name: "Stellar",
  explorerTxUrl: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
};

const USDC_SEPOLIA: Asset = {
  chainId: SEPOLIA.id,
  id: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};

const USDC_STELLAR: Asset = {
  chainId: STELLAR.id,
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

const amount = (asset: Asset, baseUnits: string): Amount => ({ asset, baseUnits });

const ref: OnChainRef = {
  chainId: SEPOLIA.id,
  txHash: "0xa4a4",
  explorerUrl: "https://sepolia.etherscan.io/tx/0xa4a4",
};

/** The account the real testnet transfer actually landed in. */
const STELLAR_RECIPIENT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";

const ROUTE: Route = {
  id: "r",
  source: "cctp",
  trustModel: "native-mint",
  fromChain: SEPOLIA,
  toChain: STELLAR,
  destination: STELLAR_RECIPIENT,
  sends: amount(USDC_SEPOLIA, "25000000"),
  receives: amount(USDC_STELLAR, "247500000"),
  receivesAtLeast: amount(USDC_STELLAR, "246000000"),
  fees: [],
  estimatedSeconds: 300,
  steps: [],
  signaturesRequired: 2,
  expiresAtUnix: 0,
};

const bridgeStep = (phase: ScaleStep["phase"]): readonly ScaleStep[] => [
  { id: "bridge", label: "Move your funds to Stellar", phase },
];

/**
 * The headline figure, which is the one number a user reads off this widget.
 *
 * These cases exist because the first version showed the QUOTED amount on every
 * terminal outcome. A returned transfer headlined "24.75 USDC" above the word
 * "Returned", which reads as money received. It is the most consequential number
 * in the product and the easiest one to leave stale.
 */
describe("settledAmount", () => {
  it("shows the quote while the transfer is still in flight", () => {
    expect(settledAmount("in-flight", ROUTE, undefined)).toBe(ROUTE.receives);
  });

  it("shows what came back on a refund, not what was quoted", () => {
    const returned = amount(USDC_SEPOLIA, "25000000");
    const steps = bridgeStep({ phase: "refunded", ref, to: "0x9F2c", returned });
    expect(settledAmount("refunded", ROUTE, steps)).toBe(returned);
  });

  it("shows what actually landed on a partial delivery", () => {
    const received = amount(USDC_STELLAR, "120000000");
    const steps = bridgeStep({
      phase: "partial",
      ref,
      received,
      expected: ROUTE.receives,
      remedy: { kind: "add-gas", chainId: STELLAR.id, because: "" },
    });
    expect(settledAmount("partial", ROUTE, steps)).toBe(received);
  });

  it("has no figure at all for a failure, so none is rendered", () => {
    const steps = bridgeStep({
      phase: "failed",
      cause: "Rejected.",
      ref,
      remedy: { kind: "retry", because: "" },
    });
    expect(settledAmount("failed", ROUTE, steps)).toBeUndefined();
  });

  it("falls back to nothing rather than to the quote when the step is missing", () => {
    // A refunded outcome whose steps carry no refunded phase is inconsistent
    // state. Reporting the quoted amount there would be the original bug wearing
    // a different hat, so it reports nothing instead.
    expect(settledAmount("refunded", ROUTE, bridgeStep({ phase: "idle" }))).toBeUndefined();
  });
});
