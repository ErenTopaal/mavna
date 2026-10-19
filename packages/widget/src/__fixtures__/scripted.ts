import { buildSendParam, OFT_ABI } from "@mavna/adapter-layerzero";
import {
  type Asset,
  type BridgeAdapter,
  type Route,
  type RouteRejection,
  SENDER_ADDRESS,
  type StepPhase,
  type TransferHandle,
  type TrustModel,
  type UnsignedTransaction,
} from "@mavna/core";

interface ScriptOptions {
  readonly chains?: readonly string[] | Error;
  readonly transactions?: readonly UnsignedTransaction[];
  readonly onStatus?: () => void;
  /** Never answer status, like an indexer that accepted the connection and went quiet. */
  readonly hang?: boolean;
}

/**
 * A rail that answers from a script, for driving the widget's runner without a
 * network. Everything it does is what the interface allows a real rail to do.
 */
export class ScriptedAdapter implements BridgeAdapter {
  readonly id: string;
  readonly trustModel: TrustModel = "dvn-stack";
  readonly asked: TransferHandle[] = [];
  built = 0;
  private readonly script: Array<StepPhase | Error>;
  private readonly options: ScriptOptions;

  constructor(id: string, script: Array<StepPhase | Error>, options: ScriptOptions = {}) {
    this.id = id;
    this.script = script;
    this.options = options;
  }

  async supportedChains(): Promise<readonly string[]> {
    const chains = this.options.chains ?? ["arbitrum-sepolia"];
    if (chains instanceof Error) throw chains;
    return chains;
  }

  async quote(): Promise<RouteRejection> {
    return {
      source: this.id,
      reason: "temporarily-unavailable",
      explanation: "This rail only answers status.",
      retryable: true,
    };
  }

  async buildTransactions(): Promise<readonly UnsignedTransaction[]> {
    this.built += 1;
    return this.options.transactions ?? [];
  }

  /** Walks the script, then repeats its last entry. */
  async status(handle: TransferHandle): Promise<StepPhase> {
    this.asked.push(handle);
    this.options.onStatus?.();
    if (this.options.hang === true) return new Promise<StepPhase>(() => {});
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next === undefined) throw new Error("the script is empty");
    if (next instanceof Error) throw next;
    return next;
  }
}

export const DESTINATION = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const SOURCE_USDC: Asset = {
  chainId: "arbitrum-sepolia",
  id: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};

export const STELLAR_USDC: Asset = {
  chainId: "stellar-testnet",
  id: `USDC:${USDC_ISSUER}`,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

export const STELLAR_XLM: Asset = {
  chainId: "stellar-testnet",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

const ARBISCAN = "https://sepolia.arbiscan.io/tx/";

/** A route shaped the way the rails build them, with the parts a test varies. */
export function routeFor(
  source: string,
  options: {
    readonly newAccount?: boolean;
    readonly approve?: boolean;
    readonly swap?: boolean;
    readonly delivers?: Asset;
  } = {},
): Route {
  const delivers = options.delivers ?? STELLAR_USDC;
  const sends = { asset: SOURCE_USDC, baseUnits: "5000000" };
  const receives = { asset: delivers, baseUnits: "50000000" };
  const step = (kind: Route["steps"][number]["kind"], index: number) => ({
    id: `${kind}-${index}`,
    kind,
    source,
    from: sends,
    to: receives,
    estimatedSeconds: 60,
    execution: undefined,
  });
  const steps = [
    ...(options.newAccount === true ? [step("prepare-account", 0)] : []),
    ...(options.approve === true ? [step("approve-source", 1)] : []),
    step("bridge", 2),
    ...(options.newAccount === true ? [step("settle-account", 3)] : []),
    ...(options.swap === true ? [step("swap", 4)] : []),
  ];
  return {
    id: `${source}-arbitrum-sepolia-stellar-testnet`,
    source,
    trustModel: "dvn-stack",
    fromChain: {
      id: "arbitrum-sepolia",
      name: "Arbitrum Sepolia",
      explorerTxUrl: (hash) => `${ARBISCAN}${hash}`,
    },
    toChain: {
      id: "stellar-testnet",
      name: "Stellar",
      explorerTxUrl: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    },
    destination: DESTINATION,
    sends,
    receives,
    receivesAtLeast: receives,
    deliveredAtLeast: receives,
    fees: [],
    estimatedSeconds: 120,
    steps,
    signaturesRequired: 1,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
  };
}

const OFT = "0x2222222222222222222222222222222222222222";

/** The send a LayerZero route builds, in the payload shape its adapter emits. */
export function layerZeroSend(fee: string): UnsignedTransaction {
  const sendParam = buildSendParam({
    dstEid: 40_420,
    stellarRecipient: DESTINATION,
    amount: 5_000_000n,
    minAmount: 4_975_000n,
    extraOptions: "0x",
  });
  return {
    chainId: "arbitrum-sepolia",
    payload: JSON.stringify({
      to: OFT,
      abi: OFT_ABI,
      functionName: "send",
      args: [
        { ...sendParam, amountLD: "5000000", minAmountLD: "4975000" },
        { nativeFee: fee, lzTokenFee: "0" },
        SENDER_ADDRESS,
      ],
      value: fee,
    }),
    format: "evm-tx",
    describes: "Send 5 USDC to Stellar.",
    unnecessaryWhen: undefined,
    ephemeralSigners: [],
  };
}

export const SEND_HASH = `0x${"ab".repeat(32)}`;

export function pending(): StepPhase {
  return {
    phase: "pending",
    ref: { chainId: "arbitrum-sepolia", txHash: SEND_HASH, explorerUrl: `${ARBISCAN}${SEND_HASH}` },
    expectedByUnix: 0,
  };
}

export function delivered(txHash = "f00d"): StepPhase {
  return {
    phase: "done",
    ref: {
      chainId: "stellar-testnet",
      txHash,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    },
    received: { asset: STELLAR_USDC, baseUnits: "50000000" },
  };
}

export function failed(cause: string): StepPhase {
  return {
    phase: "failed",
    cause,
    remedy: { kind: "retry", because: "Nothing further happens on its own." },
    ref: undefined,
  };
}
