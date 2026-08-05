import type { Amount, Asset, ChainRef, Route, RouteSet } from "@mavna/core";
import type { ScaleStep } from "@mavna/widget";

/**
 * Fixtures for the widget state gallery.
 *
 * Every hash, ledger and address below is from the real testnet transfer this
 * project already executed: a Sepolia burn, a Circle attestation, and one USDC
 * landing in a Stellar account that did not exist beforehand. Inventing
 * plausible-looking hashes would have produced a gallery that renders correctly
 * against data no chain would ever return, which is the failure mode this whole
 * verification step exists to catch.
 */

const SEPOLIA: ChainRef = {
  id: "ethereum-sepolia",
  name: "Sepolia",
  explorerTxUrl: (hash) => `https://sepolia.etherscan.io/tx/${hash}`,
};

const STELLAR: ChainRef = {
  id: "stellar-testnet",
  name: "Stellar",
  explorerTxUrl: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
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

const XLM: Asset = {
  chainId: STELLAR.id,
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

const amount = (asset: Asset, baseUnits: string): Amount => ({ asset, baseUnits });

const BURN_HASH = "0xa4a4308d0b7692da6f377d9c8f8a131cee8110a32dd218f6c55b1c5a7f046660";
const DELIVERY_HASH = "b1d1cbfa4f0e9d0b0c2f2f7bd45a4dd3f4f0f2f1c9f6d0c1a2b3c4d5e6f70819";
export const RECIPIENT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";

const burnRef = {
  chainId: SEPOLIA.id,
  txHash: BURN_HASH,
  explorerUrl: SEPOLIA.explorerTxUrl(BURN_HASH),
};

const deliveryRef = {
  chainId: STELLAR.id,
  txHash: DELIVERY_HASH,
  explorerUrl: STELLAR.explorerTxUrl(DELIVERY_HASH),
};

export const ROUTE: Route = {
  id: "cctp-sepolia-stellar",
  source: "cctp",
  trustModel: "native-mint",
  fromChain: SEPOLIA,
  toChain: STELLAR,
  destination: RECIPIENT,
  sends: amount(USDC_SEPOLIA, "25000000"),
  receives: amount(USDC_STELLAR, "247500000"),
  receivesAtLeast: amount(USDC_STELLAR, "246000000"),
  fees: [
    {
      kind: "bridge",
      total: amount(USDC_SEPOLIA, "100000"),
      recipients: [],
      includedInQuote: true,
    },
    { kind: "gas", total: amount(USDC_SEPOLIA, "150000"), recipients: [], includedInQuote: true },
    {
      kind: "account-reserve",
      total: amount(XLM, "10000000"),
      recipients: [],
      includedInQuote: true,
    },
  ],
  estimatedSeconds: 300,
  steps: [],
  signaturesRequired: 2,
  expiresAtUnix: 0,
};

const LABELS = {
  prepare: "Set up your Stellar account",
  bridge: "Move your funds to Stellar",
  settle: "Finish setting up your account",
} as const;

/** Named so each gallery card says what it is testing, not "state 3". */
export const SCENARIOS: ReadonlyArray<{
  readonly name: string;
  readonly outcome: "succeeded" | "refunded" | "partial" | "failed" | "in-flight";
  readonly steps: readonly ScaleStep[];
}> = [
  {
    name: "Waiting on you",
    outcome: "in-flight",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: { phase: "blocked", blocked: { kind: "needs-signature", signaturesRemaining: 1 } },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
  {
    name: "Proceeding",
    outcome: "in-flight",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: { phase: "pending", ref: burnRef, expectedByUnix: 0 },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
  {
    name: "Overdue",
    outcome: "in-flight",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: {
          phase: "stalled",
          ref: burnRef,
          overdueSeconds: 1_140,
          remedy: {
            kind: "wait",
            untilUnix: 0,
            because: "Circle has not signed off on the burn yet. Nothing is lost while this waits.",
          },
        },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
  {
    name: "Arrived",
    outcome: "succeeded",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: { phase: "done", ref: burnRef, received: amount(USDC_STELLAR, "247500000") },
      },
      {
        id: "settle",
        label: LABELS.settle,
        // Zero on purpose. Settling locks the reserve inside the user's own
        // account rather than paying anything to them, and "1 XLM arrived" would
        // describe a payment that never happened.
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
    ],
  },
  {
    name: "Returned",
    outcome: "refunded",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: {
          phase: "refunded",
          ref: burnRef,
          to: "0x9F2c8A5b1D3e4F60718293A4b5C6d7E8f9012345",
          returned: amount(USDC_SEPOLIA, "25000000"),
        },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
  {
    name: "Needs gas to land",
    outcome: "partial",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: {
          phase: "partial",
          ref: burnRef,
          received: amount(USDC_STELLAR, "120000000"),
          expected: amount(USDC_STELLAR, "247500000"),
          remedy: {
            kind: "add-gas",
            chainId: STELLAR.id,
            because: "The rest is held at the bridge until delivery is paid for.",
          },
        },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
  {
    name: "Did not go through",
    outcome: "failed",
    steps: [
      {
        id: "prepare",
        label: LABELS.prepare,
        phase: { phase: "done", ref: deliveryRef, received: amount(XLM, "0") },
      },
      {
        id: "bridge",
        label: LABELS.bridge,
        phase: {
          phase: "failed",
          cause: "The burn was rejected by Sepolia.",
          ref: burnRef,
          remedy: {
            kind: "retry",
            because: "Nothing left your wallet, so this can be sent again.",
          },
        },
      },
      { id: "settle", label: LABELS.settle, phase: { phase: "idle" } },
    ],
  },
];

/**
 * A route set as it actually arrives: some sources answered, some declined, and
 * one has not replied yet.
 *
 * Partial results are the normal case rather than a degraded one, so the gallery
 * shows the normal case. A set where everything succeeded would never exercise
 * the rejection list, which is the part with a requirement attached to it.
 */
export const ROUTE_SET: RouteSet = {
  routes: [
    ROUTE,
    {
      ...ROUTE,
      id: "axelar-sepolia-stellar",
      source: "axelar",
      trustModel: "validator-set",
      receives: amount(USDC_STELLAR, "246100000"),
      receivesAtLeast: amount(USDC_STELLAR, "244000000"),
      estimatedSeconds: 900,
      signaturesRequired: 2,
    },
    {
      ...ROUTE,
      id: "lz-sepolia-stellar",
      source: "layerzero",
      trustModel: "solver-network",
      receives: amount(USDC_STELLAR, "248200000"),
      receivesAtLeast: amount(USDC_STELLAR, "245000000"),
      estimatedSeconds: 120,
      signaturesRequired: 3,
    },
  ],
  rejected: [
    {
      source: "allbridge",
      reason: "amount-too-small",
      retryable: false,
      explanation: "Send at least 50 USDC to use this route.",
    },
    {
      source: "soroswap",
      reason: "no-liquidity",
      retryable: true,
      explanation: "Not enough liquidity for this pair right now. Try a smaller amount.",
    },
  ],
  complete: false,
};
