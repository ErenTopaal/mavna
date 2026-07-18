import type {
  Amount,
  Asset,
  BridgeAdapter,
  NetworkId,
  QuoteRequest,
  Route,
  RouteRejection,
  StepPhase,
  TransferHandle,
  TrustModel,
  UnsignedTransaction,
} from "@mavna/core";
import { type PlannedStep, planTransfer, signatureCount } from "@mavna/routing";
import {
  belowFloorGuidance,
  type DestinationLane,
  inspectDestination,
  meetsFloor,
  quoteReserve,
  type RpcClient,
} from "@mavna/stellar";
import { Asset as StellarAsset } from "@stellar/stellar-sdk";
import { AttestationService } from "./attestation.js";
import { buildBurn, EVM_TESTNET, FINALITY, TOKEN_MESSENGER_ABI } from "./burn.js";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { canonicalToLocal } from "./delivery.js";

/**
 * CCTP as a rail the routing engine can race.
 *
 * Everything specific to Circle lives in this package and nothing outside it
 * mentions Circle at all. That is the point of the adapter interface, and it is
 * what makes adding LayerZero later a matter of writing one more file rather
 * than editing the router.
 */

/**
 * The chains this adapter can actually build a burn for, which is NOT the same
 * as the chains Circle routes from.
 *
 * Circle routes into Stellar from twenty-six domains. `buildBurn` targets one
 * deployment, Ethereum Sepolia, which is the one that has been exercised end to
 * end. Claiming the other twenty-five and failing at signing time would be worse
 * than declining them here with a reason, so this map is the honest set and it
 * grows only as each chain is actually tested.
 */
const SOURCE_CHAINS: Readonly<Record<NetworkId, Readonly<Record<string, number>>>> = {
  testnet: { "ethereum-sepolia": EVM_TESTNET.domain },
  mainnet: {},
};

/** Circle quotes `minimumFee` in basis points of the amount burned. */
const BPS = 10_000n;

export interface CctpAdapterOptions {
  readonly network: NetworkId;
  /** Used to inspect the destination, through the freshness guard. */
  readonly rpc: RpcClient;
  /**
   * The network's base reserve, read from a ledger header rather than assumed.
   * It is a network parameter and has changed before.
   */
  readonly baseReserveStroops: number;
  /** Injectable so tests do not have to reach Circle to exercise the quoting. */
  readonly attestations?: AttestationService;
}

export class CctpAdapter implements BridgeAdapter {
  readonly id = "cctp";
  /** The issuer destroys and reissues. Nobody is holding the money in between. */
  readonly trustModel: TrustModel = "native-mint";

  private readonly network: NetworkId;
  private readonly rpc: RpcClient;
  private readonly baseReserveStroops: number;
  private readonly attestations: AttestationService;
  private readonly stellarUsdc: StellarAsset;

  constructor(options: CctpAdapterOptions) {
    this.network = options.network;
    this.rpc = options.rpc;
    this.baseReserveStroops = options.baseReserveStroops;
    this.attestations = options.attestations ?? new AttestationService(options.network);
    this.stellarUsdc = new StellarAsset("USDC", CCTP_CONTRACTS[options.network].usdcIssuer);
  }

  supportedChains(): Promise<readonly string[]> {
    return Promise.resolve(Object.keys(SOURCE_CHAINS[this.network]));
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    const domain = SOURCE_CHAINS[this.network][request.from.chainId];
    if (domain === undefined) {
      return this.decline(
        "chain-unsupported",
        `Mavna does not move funds from ${request.from.chainId} yet.`,
      );
    }
    if (request.to.chainId !== stellarChainId(this.network)) {
      return this.decline("chain-unsupported", "This route only delivers to Stellar.");
    }
    if (request.from.symbol !== "USDC" || request.to.symbol !== "USDC") {
      return this.decline("asset-unsupported", "Circle moves USDC only.");
    }

    const destination = await inspectDestination(this.rpc, request.destination, this.stellarUsdc);
    if (destination.lane.kind === "unusable") {
      return this.decline("destination-unsupported", destination.lane.reason);
    }

    const fee = await this.bridgeFee(domain, BigInt(request.sends.baseUnits));
    if (fee === undefined) {
      return this.decline(
        "temporarily-unavailable",
        "Circle is not quoting this route right now. It is worth trying again shortly.",
      );
    }

    const reserve = quoteReserve({
      lane: destination.lane,
      // CCTP delivers USDC and the user asked for USDC, so there is never a
      // second trustline to pay for on this rail.
      destinationAssetDiffers: false,
      baseReserveStroops: this.baseReserveStroops,
    });

    const sends = BigInt(request.sends.baseUnits);
    if (fee >= sends) {
      return this.decline(
        "amount-too-small",
        "The fee for this transfer is larger than the amount being sent.",
      );
    }

    // Six decimals on the way in, seven on the way out. Doing this with numbers
    // instead of BigInt is how a transfer quietly loses its last digit.
    const delivered = canonicalToLocal((sends - fee).toString());

    if (!meetsFloor(reserve, BigInt(delivered))) {
      // The designed copy, reused rather than reworded: it offers a way forward
      // instead of refusing, which is the whole point of checking at quote time.
      return this.decline("amount-too-small", belowFloorGuidance(reserve));
    }

    const steps = planTransfer({
      destination: readinessOf(destination.lane),
      bridgeDelivers: request.to.id,
      userWants: request.to.id,
      // USDC is arriving, not XLM, so nothing about the account pays for itself.
      arrivingXlmCoversReserve: false,
    });

    const receives: Amount = { asset: request.to, baseUnits: delivered };

    return {
      id: `cctp-${request.from.chainId}-stellar`,
      source: this.id,
      trustModel: this.trustModel,
      fromChain: chainRefFor(request.from.chainId),
      toChain: chainRefFor(request.to.chainId),
      destination: request.destination,
      sends: request.sends,
      receives,
      // A native mint delivers an exact amount. There is no pool to move against
      // and no slippage to allow for, so promising less than this would be a
      // hedge against a risk that does not exist on this rail.
      receivesAtLeast: receives,
      fees: [
        {
          kind: "bridge",
          total: { asset: request.from, baseUnits: fee.toString() },
          recipients: [
            {
              name: "Circle",
              amount: { asset: request.from, baseUnits: fee.toString() },
              address: undefined,
            },
          ],
          includedInQuote: true,
        },
        ...(reserve.slots === 0
          ? []
          : [
              {
                kind: "account-reserve" as const,
                total: { asset: xlmAsset(this.network), baseUnits: reserve.stroops.toString() },
                recipients: [],
                includedInQuote: true,
              },
            ]),
      ],
      estimatedSeconds: 300,
      steps: steps.map((step: PlannedStep, index: number) => ({
        id: `${step.kind}-${index}`,
        kind: step.kind,
        source: this.id,
        from: request.sends,
        to: receives,
        estimatedSeconds: step.kind === "bridge" ? 240 : 30,
        execution: undefined,
      })),
      signaturesRequired: signatureCount(steps),
      // Circle's fee is a published rate rather than a held quote, so this is a
      // refresh interval rather than a promise that expires.
      expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
    };
  }

  async buildTransactions(route: Route): Promise<readonly UnsignedTransaction[]> {
    const sends = BigInt(route.sends.baseUnits);
    const bridgeFee = route.fees.find((f) => f.kind === "bridge");
    const maxFee = bridgeFee === undefined ? 0n : BigInt(bridgeFee.total.baseUnits);

    const call = buildBurn({
      amount: sends,
      stellarRecipient: route.destination,
      network: this.network === "mainnet" ? "mainnet" : "testnet",
      finality: FINALITY.standard,
      maxFee,
    });

    return [
      {
        chainId: route.fromChain.id,
        // The caller's wallet encodes this. The SDK never signs and never submits,
        // so it hands over what to call rather than a signed transaction.
        payload: JSON.stringify({
          to: call.contract,
          abi: TOKEN_MESSENGER_ABI,
          functionName: call.functionName,
          args: call.args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
        }),
        format: "evm-tx",
        describes: call.describes,
      },
    ];
  }

  /**
   * Where the cross-chain leg stands.
   *
   * Attestation state is the authoritative signal and comes from Circle. Whether
   * the funds then LANDED is a Stellar-side fact, so it is read from Stellar; a
   * completed attestation with nothing delivered is precisely the case the status
   * machine escalates from pending to stalled, which is the whole reason that
   * distinction exists.
   */
  async status(handle: TransferHandle): Promise<StepPhase> {
    if (handle.sourceTxHash === undefined) return { phase: "idle" };

    const rows = await this.attestations.byTransaction(EVM_TESTNET.domain, handle.sourceTxHash);
    const attestation = rows.find((row) => row.destinationDomain === STELLAR_DOMAIN) ?? rows[0];

    const ref = {
      chainId: "ethereum-sepolia",
      txHash: handle.sourceTxHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${handle.sourceTxHash}`,
    };

    if (attestation === undefined || attestation.status !== "complete") {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    if (handle.destinationAddress === undefined) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    const destination = await inspectDestination(
      this.rpc,
      handle.destinationAddress,
      this.stellarUsdc,
    );
    const balance = destination.trustline?.balanceStroops;
    if (balance === undefined || BigInt(balance) === 0n) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    return {
      phase: "done",
      ref,
      received: {
        asset: {
          chainId: stellarChainId(this.network),
          id: `USDC:${CCTP_CONTRACTS[this.network].usdcIssuer}`,
          symbol: "USDC",
          decimals: 7,
          curatedBy: "Circle",
        },
        baseUnits: balance,
      },
    };
  }

  /**
   * Circle's fee for this pair, in base units of the amount being sent.
   *
   * The standard path is free from every chain that reaches Stellar, which is the
   * whole commercial argument: a reseller has to add their margin on top of zero.
   * Returning undefined means Circle declined to quote, which is temporary and
   * different from a pair that does not route at all.
   */
  private async bridgeFee(sourceDomain: number, amount: bigint): Promise<bigint | undefined> {
    try {
      const options = await this.attestations.fees(sourceDomain, STELLAR_DOMAIN);
      const standard = options.find((o) => o.finalityThreshold === FINALITY.standard);
      if (standard === undefined) return undefined;
      return (amount * BigInt(Math.round(standard.minimumFee))) / BPS;
    } catch {
      return undefined;
    }
  }

  private decline(reason: RouteRejection["reason"], explanation: string): RouteRejection {
    return { source: this.id, reason, explanation };
  }
}

/** The plan layer speaks in readiness, the Stellar layer in reserve slots. */
function readinessOf(lane: DestinationLane): "ready" | "needs-trustline" | "needs-account" {
  switch (lane.kind) {
    case "needs-account":
      return "needs-account";
    case "needs-trustline":
      return "needs-trustline";
    default:
      return "ready";
  }
}

function stellarChainId(network: NetworkId): string {
  return network === "mainnet" ? "stellar" : "stellar-testnet";
}

function xlmAsset(network: NetworkId): Asset {
  return {
    chainId: stellarChainId(network),
    id: "native",
    symbol: "XLM",
    decimals: 7,
    curatedBy: "Stellar",
  };
}

function chainRefFor(chainId: string) {
  const explorers: Readonly<Record<string, (hash: string) => string>> = {
    "ethereum-sepolia": (h) => `https://sepolia.etherscan.io/tx/${h}`,
    "stellar-testnet": (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
    stellar: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
  };
  const names: Readonly<Record<string, string>> = {
    "ethereum-sepolia": "Sepolia",
    "stellar-testnet": "Stellar",
    stellar: "Stellar",
  };
  return {
    id: chainId,
    name: names[chainId] ?? chainId,
    explorerTxUrl: explorers[chainId] ?? ((h: string) => h),
  };
}
