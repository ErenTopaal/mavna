import type {
  Amount,
  Asset,
  BridgeAdapter,
  ChainRef,
  NetworkId,
  QuoteRequest,
  Route,
  RouteRejection,
  StepPhase,
  TransferHandle,
  TrustModel,
  UnsignedTransaction,
} from "@mavna/core";
import { MavnaError } from "@mavna/core";
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
import { type Attestation, AttestationService } from "./attestation.js";
import { buildBurn, FINALITY, TOKEN_MESSENGER_ABI } from "./burn.js";
import { deploymentFor, EVM_DEPLOYMENTS, explorerTxUrl, sourceChainsFor } from "./chains.js";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { canonicalToLocal } from "./delivery.js";
import { nonEvmChainFor, nonEvmChainsFor, nonEvmExplorerTxUrl } from "./nonevm.js";

/**
 * CCTP as a rail the routing engine can race.
 *
 * Everything specific to Circle lives in this package and nothing outside it
 * mentions Circle at all. That is the point of the adapter interface, and it is
 * what makes adding LayerZero later a matter of writing one more file rather
 * than editing the router.
 */

/** Circle quotes `minimumFee` in basis points of the amount burned. */
const BPS = 10_000n;

/** What a non-EVM chain needs that a route cannot carry on its own. */
export interface BuildOptions {
  readonly solana?: {
    /** The wallet paying and signing, base58. */
    readonly owner: string;
    /**
     * A fresh keypair's public key. The caller creates it and signs with it; the
     * burn writes its message into that brand new account.
     */
    readonly messageSentEventData: string;
    /** Undefined uses the owner's associated token account for USDC. */
    readonly burnTokenAccount?: string | undefined;
  };
}

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
    return Promise.resolve([...sourceChainsFor(this.network), ...nonEvmChainsFor(this.network)]);
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    // Circle's domain is all quoting needs; how the burn is built is a question
    // for later and differs per family.
    const domain = this.domainOf(request.from.chainId);
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

    // A destination that cannot receive is ordinary user input, not an exceptional
    // condition, and the interface is explicit that a rejection carrying a reason
    // beats a throw: the reason is shown to somebody. `classifyAddress` throws on
    // the dangerous forms -- a secret key most of all -- so that is caught here and
    // turned back into an answer.
    let destination: Awaited<ReturnType<typeof inspectDestination>>;
    try {
      destination = await inspectDestination(this.rpc, request.destination, this.stellarUsdc);
    } catch (cause) {
      return this.decline(
        "destination-unsupported",
        // Our own wording, never the raw error, so nothing about the address the
        // user pasted can end up echoed back into the interface.
        cause instanceof MavnaError
          ? cause.message
          : "That is not an address that can receive a payment on Stellar.",
      );
    }
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
      fromChain: chainRefFor(this.network, request.from.chainId),
      toChain: chainRefFor(this.network, request.to.chainId),
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

  async buildTransactions(
    route: Route,
    options: BuildOptions = {},
  ): Promise<readonly UnsignedTransaction[]> {
    const sends = BigInt(route.sends.baseUnits);
    const bridgeFee = route.fees.find((f) => f.kind === "bridge");
    const maxFee = bridgeFee === undefined ? 0n : BigInt(bridgeFee.total.baseUnits);

    const nonEvm = nonEvmChainFor(this.network, route.fromChain.id);
    if (nonEvm?.family === "solana") {
      return [await this.buildSolana(route, sends, maxFee, options)];
    }

    const call = buildBurn({
      amount: sends,
      stellarRecipient: route.destination,
      network: this.network === "mainnet" ? "mainnet" : "testnet",
      sourceChainId: route.fromChain.id,
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
        ephemeralSigners: [],
      },
    ];
  }

  /**
   * The Solana burn, with its builder loaded only now.
   *
   * A dynamic import keeps Solana's address library out of the bundle of every
   * integrator who never sends from Solana, which is most of them. The plan asks
   * for adapters that do not ship what they do not use, and this is the same idea
   * one level down.
   */
  private async buildSolana(
    route: Route,
    sends: bigint,
    maxFee: bigint,
    options: BuildOptions,
  ): Promise<UnsignedTransaction> {
    if (options.solana === undefined) {
      throw new MavnaError(
        "Sending from Solana needs the wallet's address and a fresh keypair for the " +
          "message account. Pass them as `solana` to buildTransactions; the SDK will " +
          "not create a keypair, because creating one means holding a secret key.",
        { retryable: false },
      );
    }

    const { buildSolanaBurn } = await import("./solana.js");
    const instruction = await buildSolanaBurn({
      amount: sends,
      stellarRecipient: route.destination,
      network: this.network,
      owner: options.solana.owner,
      messageSentEventData: options.solana.messageSentEventData,
      burnTokenAccount: options.solana.burnTokenAccount,
      maxFee,
      finality: FINALITY.standard,
    });

    return {
      chainId: route.fromChain.id,
      payload: JSON.stringify({
        programId: instruction.programId,
        keys: instruction.keys,
        data: instruction.data,
      }),
      format: "solana-instruction",
      describes: instruction.describes,
      ephemeralSigners: instruction.ephemeralSigners,
    };
  }

  /** Circle's domain for a chain, whichever family it belongs to. */
  private domainOf(chainId: string): number | undefined {
    return (
      deploymentFor(this.network, chainId)?.domain ?? nonEvmChainFor(this.network, chainId)?.domain
    );
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

    const found = await this.findBurn(handle.sourceTxHash, handle.sourceChainId);
    if (found === undefined) {
      // Not indexed yet, or on a chain we do not route from. Either way there is
      // no evidence it failed, and reporting failure without evidence is how a
      // user is talked into sending a second payment.
      return {
        phase: "pending",
        ref: {
          chainId: handle.sourceChainId ?? "unknown",
          txHash: handle.sourceTxHash,
          explorerUrl: "",
        },
        expectedByUnix: 0,
      };
    }

    const { attestation, chainId } = found;
    const ref = {
      chainId,
      txHash: handle.sourceTxHash,
      explorerUrl:
        nonEvmChainFor(this.network, chainId) === undefined
          ? explorerTxUrl(this.network, chainId, handle.sourceTxHash)
          : nonEvmExplorerTxUrl(this.network, chainId, handle.sourceTxHash),
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
   * Find a burn, searching every chain we route from when told none.
   *
   * Circle's lookup is keyed by source domain, so a hash alone is not enough to
   * ask the question. A user who closed the tab may have nothing but that hash,
   * and this product's stated advantage over the prior art is that it recovers
   * from whatever they still have. Twenty-one parallel requests is a small price
   * for not telling that person their transfer cannot be found.
   */
  private async findBurn(
    txHash: string,
    sourceChainId: string | undefined,
  ): Promise<{ attestation: Attestation; chainId: string } | undefined> {
    const candidates =
      sourceChainId === undefined
        ? [...sourceChainsFor(this.network), ...nonEvmChainsFor(this.network)]
        : [sourceChainId].filter((id) => this.domainOf(id) !== undefined);

    const lookups = candidates.map(async (chainId) => {
      const domain = this.domainOf(chainId);
      if (domain === undefined) return undefined;
      const rows = await this.attestations.byTransaction(domain, txHash);
      const attestation = rows.find((row) => row.destinationDomain === STELLAR_DOMAIN) ?? rows[0];
      return attestation === undefined ? undefined : { attestation, chainId };
    });

    const settled = await Promise.allSettled(lookups);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value !== undefined) return outcome.value;
    }
    return undefined;
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

function chainRefFor(network: NetworkId, chainId: string): ChainRef {
  if (chainId === stellarChainId(network)) {
    const path = network === "mainnet" ? "public" : "testnet";
    return {
      id: chainId,
      name: "Stellar",
      explorerTxUrl: (hash) => `https://stellar.expert/explorer/${path}/tx/${hash}`,
    };
  }

  const nonEvm = nonEvmChainFor(network, chainId);
  if (nonEvm !== undefined) {
    return {
      id: chainId,
      name: nonEvm.name,
      explorerTxUrl: (hash) => nonEvmExplorerTxUrl(network, chainId, hash),
    };
  }

  const deployment = EVM_DEPLOYMENTS[network][chainId];
  return {
    id: chainId,
    name: deployment?.name ?? chainId,
    explorerTxUrl: (hash) => explorerTxUrl(network, chainId, hash),
  };
}
