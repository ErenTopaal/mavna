import type {
  Amount,
  Asset,
  BridgeAdapter,
  BuildContext,
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
import {
  ARRIVAL_CONTRACT_IDS,
  arrivalContractRefusal,
  MavnaError,
  rejectionIsRetryable,
} from "@mavna/core";
import { type PlannedStep, planTransfer, signatureCount } from "@mavna/routing";
import {
  type ArrivingValue,
  belowFloorGuidance,
  type DestinationLane,
  inspectDestination,
  meetsFloor,
  quoteReserve,
  type RpcClient,
  recipientRefusal,
  valueInXlm,
  XlmPriceSource,
} from "@mavna/stellar";
import { Asset as StellarAsset } from "@stellar/stellar-sdk";
import { assetsAreCanonical, sourceUsdcFor } from "./assets.js";
import { type Attestation, AttestationService } from "./attestation.js";
import { buildApproval, buildBurn, ERC20_ABI, FINALITY, TOKEN_MESSENGER_ABI } from "./burn.js";
import { deploymentFor, EVM_DEPLOYMENTS, explorerTxUrl, sourceChainsFor } from "./chains.js";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { canonicalToLocal } from "./delivery.js";
import { expectedBridgeSeconds } from "./finality.js";
import { fromHex, parseForwarderHookData } from "./hook.js";
import { nonEvmChainFor, nonEvmChainsFor, nonEvmExplorerTxUrl } from "./nonevm.js";
import { DeliveryProof } from "./proof.js";

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

/**
 * What a non-EVM chain needs that a route cannot carry on its own.
 *
 * Also accepts the shared build context, so the generic path that hands every
 * rail the connected wallet can hand it here too. This rail does not need it.
 */
export interface BuildOptions extends Partial<BuildContext> {
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
   * The network's base reserve, as configured. Nothing here reads it from the
   * ledger: callers pass `NetworkConfig.baseReserveStroops`, which defaults to
   * the 0.5 XLM last confirmed on both networks and is overridable because it
   * is a network parameter and has changed before.
   */
  readonly baseReserveStroops: number;
  /** Injectable so tests do not have to reach Circle to exercise the quoting. */
  readonly attestations?: AttestationService;
  /**
   * Prices the arriving asset in XLM, so the sponsorship floor can be compared
   * against it. Injectable for the same reason as the attestation service.
   */
  readonly prices?: XlmPriceSource;
  /** Where the order book is read from. Defaults per network. */
  readonly horizonUrl?: string;
  /** Circle's attestation service. Overridable to an integrator's own proxy. */
  readonly irisUrl?: string;
  /**
   * A Mavna Arrival Contract in use besides the one deployed on this network,
   * which is refused by default. A plain transfer to either would be stuck
   * there, so both are refused as destinations.
   */
  readonly arrivalContract?: string;
}

export class CctpAdapter implements BridgeAdapter {
  readonly id = "cctp";
  /** The issuer destroys and reissues. Nobody is holding the money in between. */
  readonly trustModel: TrustModel = "native-mint";

  private readonly network: NetworkId;
  private readonly arrivalContract: string | undefined;
  private readonly rpc: RpcClient;
  private readonly baseReserveStroops: number;
  private readonly attestations: AttestationService;
  private readonly stellarUsdc: StellarAsset;
  private readonly prices: XlmPriceSource;
  private readonly horizonUrl: string;
  private readonly proof: DeliveryProof;

  constructor(options: CctpAdapterOptions) {
    this.arrivalContract = options.arrivalContract;
    this.network = options.network;
    this.rpc = options.rpc;
    this.baseReserveStroops = options.baseReserveStroops;
    this.attestations =
      options.attestations ?? new AttestationService(options.network, options.irisUrl);
    this.stellarUsdc = new StellarAsset("USDC", CCTP_CONTRACTS[options.network].usdcIssuer);
    this.horizonUrl =
      options.horizonUrl ??
      (options.network === "mainnet"
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org");
    this.prices =
      options.prices ??
      new XlmPriceSource({
        horizonUrl:
          options.horizonUrl ??
          (options.network === "mainnet"
            ? "https://horizon.stellar.org"
            : "https://horizon-testnet.stellar.org"),
      });
    this.proof = new DeliveryProof({
      rpc: options.rpc,
      horizonUrl: this.horizonUrl,
      network: options.network,
    });
  }

  supportedChains(): Promise<readonly string[]> {
    return Promise.resolve([...sourceChainsFor(this.network), ...nonEvmChainsFor(this.network)]);
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    const stuck = arrivalContractRefusal(request.destination, [
      ARRIVAL_CONTRACT_IDS[this.network],
      this.arrivalContract,
    ]);
    if (stuck !== undefined) return this.decline("destination-unsupported", stuck);
    // asked before any network, in the words every rail uses for the same input
    const unfit = recipientRefusal(request.destination);
    if (unfit !== undefined) return this.decline("destination-unsupported", unfit);
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
    // By address and issuer, never symbol: the burn spends the canonical USDC
    // whatever the request names, so a lookalike would be quoted as one asset
    // and move another.
    const sourceUsdc = sourceUsdcFor(this.network, request.from.chainId);
    if (
      sourceUsdc === undefined ||
      !assetsAreCanonical(request, sourceUsdc, `USDC:${CCTP_CONTRACTS[this.network].usdcIssuer}`)
    ) {
      return this.decline(
        "asset-unsupported",
        "Circle moves Circle's own USDC only, and that is not the token this request names.",
      );
    }

    const fee = await this.bridgeFee(domain, BigInt(request.sends.baseUnits));
    if (typeof fee !== "bigint") return fee;

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

    // A destination that cannot receive is ordinary user input, not an exceptional
    // condition, and the interface is explicit that a rejection carrying a reason
    // beats a throw: the reason is shown to somebody. `classifyAddress` throws on
    // the dangerous forms -- a secret key most of all -- so that is caught here and
    // turned back into an answer.
    let destination: Awaited<ReturnType<typeof inspectDestination>>;
    try {
      // a mint above the room left under the trustline's limit fails after the burn
      destination = await inspectDestination(this.rpc, request.destination, this.stellarUsdc, {
        amountStroops: BigInt(delivered),
      });
    } catch (cause) {
      // A node that is merely behind is NOT an address that cannot receive.
      //
      // The freshness guard refuses a read taken from a lagging node, which is
      // right, but reporting that as "destination-unsupported" tells a user their
      // address is unusable when the truth is "ask again in a moment". The two
      // are opposite in every way that matters: one is permanent and their fault,
      // the other is transient and ours.
      if (cause instanceof MavnaError && cause.retryable) {
        return this.decline(
          "temporarily-unavailable",
          "Stellar did not answer freshly enough to check that address. Nothing is wrong " +
            "with it; try again in a moment.",
        );
      }
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

    const reserve = quoteReserve({
      lane: destination.lane,
      // CCTP delivers USDC and the user asked for USDC, so there is never a
      // second trustline to pay for on this rail.
      destinationAssetDiffers: false,
      baseReserveStroops: this.baseReserveStroops,
    });

    // Converted before comparing, because the floor is an amount of XLM and this
    // is an amount of USDC. Both are integers with seven decimals on Stellar and
    // neither announces which asset it is, which is exactly how they came to be
    // compared directly: the floor was roughly six times too strict and told
    // people their transfer was too small when it was not.
    let arriving: ArrivingValue;
    try {
      arriving = valueInXlm(
        BigInt(delivered),
        request.to.decimals,
        await this.prices.xlmStroopsPerUnit(this.stellarUsdc),
      );
    } catch (cause) {
      return this.decline(
        "temporarily-unavailable",
        "Stellar's market is not answering, so the smallest workable transfer cannot be " +
          "worked out right now.",
        detailOf(cause),
      );
    }

    if (!meetsFloor(reserve, arriving)) {
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
      // Only EVM makes the approval a transaction of its own. Starknet folds it
      // into the same invoke and Solana needs none at all.
      sourceNeedsApproval: nonEvmChainFor(this.network, request.from.chainId) === undefined,
    });

    const receives: Amount = { asset: request.to, baseUnits: delivered };
    // the bridge step waits out the source chain's finality before Circle attests
    const stepSeconds = (kind: string): number =>
      kind === "bridge" ? expectedBridgeSeconds(domain) : 30;

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
      deliveredAtLeast: receives,
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
      estimatedSeconds: steps.reduce((sum, step) => sum + stepSeconds(step.kind), 0),
      steps: steps.map((step: PlannedStep, index: number) => ({
        id: `${step.kind}-${index}`,
        kind: step.kind,
        source: this.id,
        from: request.sends,
        to: receives,
        estimatedSeconds: stepSeconds(step.kind),
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
    // a route is data the caller hands back, so this is checked again
    const stuck = arrivalContractRefusal(route.destination, [
      ARRIVAL_CONTRACT_IDS[this.network],
      this.arrivalContract,
    ]);
    if (stuck !== undefined) throw new MavnaError(stuck, { retryable: false });
    // A rail builds its own routes and nobody else's. Without this, handing a
    // route quoted by another adapter to this one produces a Circle burn priced
    // against a fee that rail never charged, while the interface tells the user
    // they chose the other one. It is masked today only because the other rails
    // happen to decline the pairs this app asks about, which is an accident and
    // not a guard.
    if (route.source !== this.id) {
      throw new MavnaError(
        `This route came from ${route.source}, so ${this.id} cannot build it. ` +
          "Ask the adapter that quoted it.",
        { retryable: false },
      );
    }

    const sends = BigInt(route.sends.baseUnits);
    const bridgeFee = route.fees.find((f) => f.kind === "bridge");
    const maxFee = bridgeFee === undefined ? 0n : BigInt(bridgeFee.total.baseUnits);

    const nonEvm = nonEvmChainFor(this.network, route.fromChain.id);
    if (nonEvm?.family === "solana") {
      return [await this.buildSolana(route, sends, maxFee, options)];
    }
    if (nonEvm?.family === "starknet") {
      return [await this.buildStarknet(route, sends, maxFee)];
    }

    const params = {
      amount: sends,
      stellarRecipient: route.destination,
      network: this.network === "mainnet" ? ("mainnet" as const) : ("testnet" as const),
      sourceChainId: route.fromChain.id,
      finality: FINALITY.standard,
      maxFee,
    };

    const approval = buildApproval(params);
    const call = buildBurn(params);

    // Only the source chain's transactions. The Stellar side, preparing the
    // account and settling the deposit, deliberately does NOT come from here:
    // the cost decision requires preparation as late as the ordering allows,
    // after Circle's attestation exists, and a transaction built now would
    // carry a sponsor sequence number minutes stale by then. The sponsor
    // service builds those at their moment; the steps and the signature count
    // on the route are the promise, and the service is who keeps it.
    return [
      {
        chainId: route.fromChain.id,
        payload: JSON.stringify({
          to: approval.contract,
          abi: ERC20_ABI,
          functionName: approval.functionName,
          args: approval.args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
        }),
        format: "evm-tx",
        describes: approval.describes,
        ephemeralSigners: [],
        // A wallet that has approved this much already should not be asked again.
        unnecessaryWhen: {
          kind: "erc20-allowance",
          token: approval.contract,
          spender: approval.args[0],
          atLeastBaseUnits: sends.toString(),
        },
      },
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
        unnecessaryWhen: undefined,
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
      // The burn's authority is the owner, who is already signing, so there is
      // no delegate to set up and nothing to skip.
      unnecessaryWhen: undefined,
    };
  }

  /**
   * The Starknet burn, with its builder loaded only now.
   *
   * Two calls rather than one: Starknet has no allowance-free transfer, so USDC
   * has to be approved for the messenger first. Wallets there send several calls
   * in one transaction as a matter of course, so it is still a single signature.
   */
  private async buildStarknet(
    route: Route,
    sends: bigint,
    maxFee: bigint,
  ): Promise<UnsignedTransaction> {
    const { buildStarknetBurn } = await import("./starknet.js");
    const invoke = buildStarknetBurn({
      amount: sends,
      stellarRecipient: route.destination,
      network: this.network,
      maxFee,
      finality: FINALITY.standard,
    });

    return {
      chainId: route.fromChain.id,
      payload: JSON.stringify(invoke.calls),
      format: "starknet-invoke",
      describes: invoke.describes,
      ephemeralSigners: [],
      // The approval is one of the calls inside this invoke, so it is already here.
      unnecessaryWhen: undefined,
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
   * the funds then LANDED is a Stellar-side fact, so it is read from Stellar, from
   * the forwarder's delivery of this exact message (see proof.ts); a
   * completed attestation with nothing delivered is precisely the case the status
   * machine escalates from pending to stalled, which is the whole reason that
   * distinction exists.
   */
  async status(handle: TransferHandle): Promise<StepPhase> {
    if (handle.sourceTxHash === undefined) {
      // Circle's index is keyed on the burn, so an address alone cannot name a
      // transfer. The forwarder's past deliveries to it may belong to any
      // transfer at all, so reporting one of them, as done or in flight, would
      // describe a transfer nobody asked about. Only the burn hash can prove one.
      return { phase: "idle" };
    }

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

    const { attestations, chainId } = found;
    const ref = {
      chainId,
      txHash: handle.sourceTxHash,
      explorerUrl:
        nonEvmChainFor(this.network, chainId) === undefined
          ? explorerTxUrl(this.network, chainId, handle.sourceTxHash)
          : nonEvmExplorerTxUrl(this.network, chainId, handle.sourceTxHash),
    };

    // The recipient is read from each attested message rather than the handle,
    // since the message is what the forwarder delivers to. A batch can pay
    // several people, so when the handle names its recipient only the burns to
    // that recipient are this transfer; one whose recipient cannot be read yet
    // is kept, so it is waited for rather than skipped.
    const recipientOf = (attestation: Attestation): string | undefined =>
      attestation.hookData === undefined
        ? undefined
        : parseForwarderHookData(fromHex(attestation.hookData)).recipient;
    const destination = handle.destinationAddress;
    const ours = attestations.filter((attestation) => {
      const recipient = recipientOf(attestation);
      return destination === undefined || recipient === undefined || recipient === destination;
    });
    if (ours.length === 0) {
      throw new MavnaError(
        `This transaction burns USDC for Stellar, and none of it is for ${destination}.`,
        { retryable: false },
      );
    }

    // Every one of them has to have landed before the transfer is done, and
    // what arrived is all of them together.
    let received = 0n;
    for (const attestation of ours) {
      if (attestation.status !== "complete" || attestation.message === undefined) {
        return { phase: "pending", ref, expectedByUnix: 0 };
      }
      const delivery = await this.proof.find(attestation.message, recipientOf(attestation));
      if (delivery === undefined) return { phase: "pending", ref, expectedByUnix: 0 };
      received += delivery.amount;
    }

    return {
      phase: "done",
      ref,
      received: { asset: this.stellarUsdcAsset(), baseUnits: received.toString() },
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
  ): Promise<{ attestations: readonly Attestation[]; chainId: string } | undefined> {
    const candidates =
      sourceChainId === undefined
        ? [...sourceChainsFor(this.network), ...nonEvmChainsFor(this.network)]
        : [sourceChainId].filter((id) => this.domainOf(id) !== undefined);

    const lookups = candidates.map(async (chainId) => {
      const domain = this.domainOf(chainId);
      if (domain === undefined) return undefined;
      const rows = await this.attestations.byTransaction(domain, txHash);
      // Only burns to Stellar are this rail's. A transaction can carry several
      // (a smart wallet batching), and a burn to another chain is never one.
      const attestations = rows.filter((row) => row.destinationDomain === STELLAR_DOMAIN);
      return attestations.length === 0 ? undefined : { attestations, chainId };
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
  private async bridgeFee(sourceDomain: number, amount: bigint): Promise<bigint | RouteRejection> {
    let options: readonly { finalityThreshold: number; minimumFee: number }[];
    try {
      options = await this.attestations.fees(sourceDomain, STELLAR_DOMAIN);
    } catch (cause) {
      // Circle's 400 is a pair it does not route, which no retry changes. Only
      // an outage or a rate limit is worth trying again.
      if (cause instanceof MavnaError && !cause.retryable) {
        // Circle's own explanation is the operator's to read
        return this.decline(
          "chain-unsupported",
          "Circle does not move USDC from this chain to Stellar. Another route may.",
          detailOf(cause),
        );
      }
      return this.decline(
        "temporarily-unavailable",
        "Circle is not quoting this route right now. It is worth trying again shortly.",
      );
    }
    const standard = options.find((o) => o.finalityThreshold === FINALITY.standard);
    if (standard === undefined) {
      return this.decline(
        "temporarily-unavailable",
        "Circle is not quoting the standard path for this route right now.",
      );
    }
    try {
      return circleFee(amount, standard.minimumFee);
    } catch (cause) {
      // A rate that cannot be read exactly is not priced in a guess, and a
      // quote answers with a reason rather than throwing.
      return this.decline(
        "temporarily-unavailable",
        "Circle quoted a fee that could not be read. It is worth trying again shortly.",
        detailOf(cause),
      );
    }
  }

  private stellarUsdcAsset(): Asset {
    return {
      chainId: stellarChainId(this.network),
      id: `USDC:${CCTP_CONTRACTS[this.network].usdcIssuer}`,
      symbol: "USDC",
      decimals: 7,
      curatedBy: "Circle",
    };
  }

  /** `detail` is for whoever runs the integration and is never shown to the user. */
  private decline(
    reason: RouteRejection["reason"],
    explanation: string,
    detail?: string,
  ): RouteRejection {
    return {
      source: this.id,
      reason,
      explanation,
      retryable: rejectionIsRetryable(reason),
      ...(detail === undefined ? {} : { detail }),
    };
  }
}

/**
 * Circle's fee on an amount, from a rate in basis points that may be fractional.
 *
 * Rounded up. maxFee is set from this, and a maxFee below Circle's fee leaves
 * the burn waiting or reverting, while one unit over costs nothing extra since
 * Circle takes only what it charges. The rate is read from its decimal form
 * rather than through float arithmetic, and a form that is not a plain decimal
 * is refused rather than approximated.
 */
export function circleFee(amount: bigint, minimumFeeBps: number): bigint {
  const text = String(minimumFeeBps);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new MavnaError(`Circle quoted a fee rate this cannot read exactly: ${text}.`, {
      retryable: false,
    });
  }
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${match[1]}${fraction}`);
  const denominator = BPS * 10n ** BigInt(fraction.length);
  return (amount * numerator + denominator - 1n) / denominator;
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

/** A failure's own words, kept for the operator in a rejection's `detail`. */
function detailOf(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
