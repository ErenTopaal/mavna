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
  type ArrivingValue,
  belowFloorGuidance,
  type DestinationLane,
  inspectDestination,
  meetsFloor,
  quoteReserve,
  type RpcClient,
  valueInXlm,
  XlmPriceSource,
} from "@mavna/stellar";
import { Networks, Asset as StellarAsset } from "@stellar/stellar-sdk";
import {
  chainIdForLayerZeroKey,
  type EvmSource,
  explorerTxUrl,
  readableAmount,
  STELLAR_DECIMALS,
  STELLAR_SIDE,
  sourceChainsFor,
  sourceFor,
  stellarExplorerTxUrl,
} from "./config.js";
import { Discovery, type OftLocation, type ResolvedRoute } from "./discovery.js";
import { describeDvnStack } from "./dvn.js";
import {
  buildApproval,
  buildSendParam,
  decodeOftMessage,
  ERC20_ABI,
  executorLzReceiveOption,
  localToStellar,
  OFT_ABI,
  sharedToStellar,
  stellarRecipientToBytes32,
  stellarToLocal,
} from "./oft.js";
import { classifyScanStatus, remedyForStatus, ScanService, scanMessageUrl } from "./scan.js";

/**
 * LayerZero as a rail the routing engine can race.
 *
 * This is the only route to native USDT on Stellar, which is the reason it
 * exists at all. Everything specific to LayerZero lives in this package and
 * nothing outside it mentions LayerZero, which is the point of the adapter
 * interface and the reason a third rail was one more directory rather than a
 * change to the router.
 *
 * It differs from the CCTP rail in two ways worth knowing before reading on.
 * There is no off-chain quoting service, so pricing means calling a view
 * function on the source chain and the adapter needs a node. And the fee is paid
 * in the source chain's gas token rather than skimmed from the amount, so a
 * quote has two fees in two different currencies and neither is optional.
 */

/** Ten thousand basis points to the whole. */
const BPS = 10_000n;

export interface LayerZeroAdapterOptions {
  readonly network: NetworkId;
  /** Used to inspect the destination and to read the Stellar side of the pathway. */
  readonly rpc: RpcClient;
  /**
   * The network's base reserve, read from a ledger header rather than assumed.
   * It is a network parameter and has changed before.
   */
  readonly baseReserveStroops: number;
  /** Prices the arriving token in XLM, so the sponsorship floor can be compared. */
  readonly prices?: XlmPriceSource;
  /** Where the order book is read from. Defaults per network. */
  readonly horizonUrl?: string;
  /**
   * OFTs this caller knows about that LayerZero's registry does not.
   *
   * The registry covers no testnet at all, so on testnet this is the only way to
   * name a token. It is also the escape hatch for anyone running their own OFT
   * on mainnet.
   */
  readonly ofts?: readonly OftLocation[];
  /**
   * Gas to buy for `lzReceive` on Stellar, for an OFT that enforces none itself.
   *
   * No default, deliberately. Almost every deployed OFT sets enforced options
   * and this is then unused; where one does not, the right number depends on
   * that contract and guessing it either wastes the user's money or strands the
   * message with the executor unpaid. Refusing to quote is the honest answer.
   */
  readonly lzReceiveGas?: bigint;
  /** Injectable so a caller can bring their own nodes or their own transport. */
  readonly fetch?: typeof globalThis.fetch;
}

export class LayerZeroAdapter implements BridgeAdapter {
  readonly id = "layerzero";
  /**
   * A set of verifiers attests, and the token's owner chose which.
   *
   * Kept apart from `validator-set` because the difference is the user's to
   * weigh rather than ours to flatten. Axelar's validators are the network's and
   * are the same for everybody. A DVN set belongs to whoever deployed the token,
   * so two routes on this same rail can be verified by entirely different
   * parties, and `describeDvnStack` says which ones on every transaction this
   * adapter builds.
   */
  readonly trustModel: TrustModel = "dvn-stack";

  private readonly network: NetworkId;
  private readonly rpc: RpcClient;
  private readonly baseReserveStroops: number;
  private readonly prices: XlmPriceSource;
  private readonly lzReceiveGas: bigint | undefined;
  private readonly discovery: Discovery;
  private readonly scan: ScanService;
  private readonly passphrase: string;

  constructor(options: LayerZeroAdapterOptions) {
    this.network = options.network;
    this.rpc = options.rpc;
    this.baseReserveStroops = options.baseReserveStroops;
    this.prices =
      options.prices ??
      new XlmPriceSource({
        horizonUrl:
          options.horizonUrl ??
          (options.network === "mainnet"
            ? "https://horizon.stellar.org"
            : "https://horizon-testnet.stellar.org"),
      });
    this.lzReceiveGas = options.lzReceiveGas;
    this.passphrase = options.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    this.discovery = new Discovery({
      network: options.network,
      rpc: options.rpc,
      ...(options.ofts === undefined ? {} : { ofts: options.ofts }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.scan = new ScanService(
      options.network,
      options.fetch === undefined ? {} : { fetch: options.fetch },
    );
  }

  supportedChains(): Promise<readonly string[]> {
    return Promise.resolve(sourceChainsFor(this.network));
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    const stellarChainId = STELLAR_SIDE[this.network].chainId;

    if (request.to.chainId !== stellarChainId) {
      return this.decline("chain-unsupported", "This route only delivers to Stellar.");
    }
    const source = sourceFor(this.network, request.from.chainId);
    if (source === undefined) {
      return this.decline(
        "chain-unsupported",
        `Mavna does not move funds from ${request.from.chainId} over LayerZero yet.`,
      );
    }

    let route: ResolvedRoute;
    try {
      route = await this.discovery.routeFrom(request.from.chainId);
    } catch (cause) {
      // Discovery failing is not one kind of event. A node that would not answer
      // is temporary and ours; a token with no peer is permanent and the user's
      // to know about. Collapsing them would either tell someone to retry
      // forever or tell them a working route is broken.
      const retryable = cause instanceof MavnaError && cause.retryable;
      return this.decline(
        retryable ? "temporarily-unavailable" : "asset-unsupported",
        cause instanceof MavnaError
          ? cause.message
          : "LayerZero could not be read for this chain right now.",
      );
    }

    // The user names the source token by its contract address, and this rail
    // only moves the one the OFT is built around. Comparing the addresses rather
    // than the symbols is the whole point of the asset model: anyone can issue a
    // token called USDT0.
    if (request.from.id.toLowerCase() !== route.token.toLowerCase()) {
      return this.decline(
        "asset-unsupported",
        `LayerZero moves ${route.tokenSymbol} at ${route.token} from ${source.name}, not ` +
          `${request.from.symbol} at ${request.from.id}.`,
      );
    }

    // What the user asked to receive, checked against what the pathway actually
    // credits. The Stellar contract id of a classic asset is derived from the
    // asset itself, so this needs no network call and cannot be fooled by a
    // matching code.
    const wanted = this.stellarAssetOf(request.to);
    if (wanted === undefined) {
      return this.decline(
        "asset-unsupported",
        `A Stellar asset is written CODE:ISSUER, and "${request.to.id}" is not.`,
      );
    }
    if (wanted.contractId(this.passphrase) !== route.stellar.token) {
      return this.decline(
        "asset-unsupported",
        `This route delivers the token at ${route.stellar.token} on Stellar, which is not ` +
          `${request.to.id}.`,
      );
    }

    let destination: Awaited<ReturnType<typeof inspectDestination>>;
    try {
      destination = await inspectDestination(this.rpc, request.destination, wanted);
    } catch (cause) {
      // A node that is merely behind is NOT an address that cannot receive.
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
        // user pasted can be echoed back into the interface.
        cause instanceof MavnaError
          ? cause.message
          : "That is not an address that can receive a payment on Stellar.",
      );
    }
    if (destination.lane.kind === "unusable") {
      return this.decline("destination-unsupported", destination.lane.reason);
    }

    let extraOptions: `0x${string}`;
    try {
      extraOptions = this.optionsFor(route);
      // Fails here rather than at signing time for a muxed destination, which is
      // the one address form this rail genuinely cannot carry.
      stellarRecipientToBytes32(request.destination);
    } catch (cause) {
      return this.decline(
        "destination-unsupported",
        cause instanceof MavnaError ? cause.message : "This destination cannot be encoded.",
      );
    }

    const sends = BigInt(request.sends.baseUnits);
    if (sends <= 0n) {
      return this.decline("amount-too-small", "There is nothing to send.");
    }

    // The floor the user agreed to, from the slippage they chose. Passing zero
    // would mean accepting anything back, which on a rail whose token contract
    // may take a fee in transit is an unbounded loss nobody consented to.
    const minAmount = sends - (sends * BigInt(request.maxSlippageBps)) / BPS;

    const sendParam = buildSendParam({
      dstEid: STELLAR_SIDE[this.network].eid,
      stellarRecipient: request.destination,
      amount: sends,
      minAmount,
      extraOptions,
    });

    const [fee, deliveredLocal] = await Promise.all([
      this.discovery.quoteNativeFee(route, sendParam),
      this.discovery.quoteDelivered(route, sendParam),
    ]);

    if (fee === undefined || deliveredLocal === undefined) {
      // The contract refused to price it. On mainnet the documented cause is a
      // verifier set that resolves to a DVN which is not deployed, which cannot
      // be fixed from here and is not the user's doing.
      return this.decline(
        "temporarily-unavailable",
        `${source.name}'s ${route.tokenSymbol} contract would not price a transfer to Stellar ` +
          "right now. Nothing about the amount or the address is wrong.",
      );
    }

    const delivered = localToStellar(
      deliveredLocal,
      route.tokenDecimals,
      route.sharedDecimals,
      STELLAR_DECIMALS,
    );
    const guaranteed = localToStellar(
      minAmount,
      route.tokenDecimals,
      route.sharedDecimals,
      STELLAR_DECIMALS,
    );

    const reserve = quoteReserve({
      lane: destination.lane,
      // The rail delivers the asset the user asked for, so there is never a
      // second trustline to pay for on this route.
      destinationAssetDiffers: false,
      baseReserveStroops: this.baseReserveStroops,
    });

    if (delivered <= 0n) {
      return this.decline(
        "amount-too-small",
        "Nothing would arrive: the amount is smaller than this token's smallest transferable unit.",
      );
    }
    // Converted first. The floor is an amount of XLM and this is an amount of
    // whatever token the route carries; both are integers and neither says which
    // asset it is. Comparing them directly made the floor wrong by the exchange
    // rate, which for a dollar against XLM is about six times.
    let arriving: ArrivingValue;
    try {
      arriving = valueInXlm(
        delivered,
        request.to.decimals,
        await this.prices.xlmStroopsPerUnit(stellarAssetFor(request.to)),
      );
    } catch (cause) {
      return this.decline(
        "temporarily-unavailable",
        cause instanceof MavnaError
          ? cause.message
          : "Stellar's market is not answering, so the smallest workable transfer " +
              "cannot be worked out right now.",
      );
    }

    if (!meetsFloor(reserve, arriving)) {
      return this.decline("amount-too-small", belowFloorGuidance(reserve));
    }

    const steps = planTransfer({
      destination: readinessOf(destination.lane),
      bridgeDelivers: request.to.id,
      userWants: request.to.id,
      // A token is arriving, not XLM, so nothing about the account pays for itself.
      arrivingXlmCoversReserve: false,
      // Asked of the contract, never assumed from the deployment's name. USDT0
      // answers true on Ethereum, where it locks real USDT, and false on
      // Arbitrum, Optimism and Polygon, where it mints and burns.
      sourceNeedsApproval: route.approvalRequired,
    });

    const receives: Amount = { asset: request.to, baseUnits: delivered.toString() };
    const bridgeFeeLd = sends - deliveredLocal;

    return {
      id: `layerzero-${request.from.chainId}-${STELLAR_SIDE[this.network].chainId}`,
      source: this.id,
      trustModel: this.trustModel,
      fromChain: this.chainRefFor(request.from.chainId),
      toChain: this.chainRefFor(request.to.chainId),
      destination: request.destination,
      sends: request.sends,
      receives,
      // Not equal to `receives` on this rail, unlike a native mint. The token
      // contract can take a fee between quoting and sending, so the honest floor
      // is the minimum the send itself will enforce.
      receivesAtLeast: { asset: request.to, baseUnits: guaranteed.toString() },
      fees: [
        {
          kind: "gas",
          total: {
            asset: nativeAssetOf(request.from.chainId, source),
            baseUnits: fee.nativeFee.toString(),
          },
          recipients: [
            {
              name: "LayerZero verifiers and executor",
              amount: {
                asset: nativeAssetOf(request.from.chainId, source),
                baseUnits: fee.nativeFee.toString(),
              },
              address: undefined,
            },
          ],
          // Paid in the source chain's own gas token, separately from the
          // amount. Saying it is included would understate what leaves the
          // user's wallet.
          includedInQuote: false,
        },
        ...(bridgeFeeLd <= 0n
          ? []
          : [
              {
                kind: "bridge" as const,
                total: { asset: request.from, baseUnits: bridgeFeeLd.toString() },
                recipients: [
                  {
                    name: route.tokenSymbol,
                    amount: { asset: request.from, baseUnits: bridgeFeeLd.toString() },
                    address: route.oft,
                  },
                ],
                includedInQuote: true,
              },
            ]),
        ...(reserve.slots === 0
          ? []
          : [
              {
                kind: "account-reserve" as const,
                total: {
                  asset: xlmAsset(STELLAR_SIDE[this.network].chainId),
                  baseUnits: reserve.stroops.toString(),
                },
                recipients: [],
                includedInQuote: true,
              },
            ]),
      ],
      estimatedSeconds: this.estimateSeconds(route),
      steps: steps.map((step: PlannedStep, index: number) => ({
        id: `${step.kind}-${index}`,
        kind: step.kind,
        source: this.id,
        from: request.sends,
        to: receives,
        estimatedSeconds: step.kind === "bridge" ? this.estimateSeconds(route) : 30,
        execution: undefined,
      })),
      signaturesRequired: signatureCount(steps),
      // The fee is a live read off the source chain rather than a held quote, so
      // this is a refresh interval and not a promise that expires.
      expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
    };
  }

  async buildTransactions(route: Route): Promise<readonly UnsignedTransaction[]> {
    const resolved = await this.discovery.routeFrom(route.fromChain.id);
    const sends = BigInt(route.sends.baseUnits);
    // The floor the user was shown, carried back into the units the contract
    // enforces it in. Rebuilding it from the route rather than recomputing it
    // from a slippage figure means the transaction cannot promise less than the
    // quote did.
    const minAmount = stellarToLocal(
      BigInt(route.receivesAtLeast.baseUnits),
      resolved.tokenDecimals,
      resolved.sharedDecimals,
      STELLAR_DECIMALS,
    );

    const sendParam = buildSendParam({
      dstEid: STELLAR_SIDE[this.network].eid,
      stellarRecipient: route.destination,
      amount: sends,
      minAmount,
      extraOptions: this.optionsFor(resolved),
    });

    // Priced again rather than taken from the quote. `send` reverts when the
    // value attached is under the current fee, and a fee read a minute ago on a
    // chain whose gas moved is a transaction that fails having spent gas.
    const fee = await this.discovery.quoteNativeFee(resolved, sendParam);
    if (fee === undefined) {
      throw new MavnaError(
        `${resolved.source.name}'s ${resolved.tokenSymbol} contract will not price this ` +
          "transfer, so there is no fee to attach and the send would revert.",
        { retryable: true },
      );
    }

    const send: UnsignedTransaction = {
      chainId: route.fromChain.id,
      // The caller's wallet encodes this. The SDK never signs and never submits,
      // so it hands over what to call rather than a signed transaction.
      payload: JSON.stringify({
        to: resolved.oft,
        abi: OFT_ABI,
        functionName: "send",
        args: [
          {
            ...sendParam,
            amountLD: sendParam.amountLD.toString(),
            minAmountLD: sendParam.minAmountLD.toString(),
          },
          { nativeFee: fee.nativeFee.toString(), lzTokenFee: fee.lzTokenFee.toString() },
          // Refunded to the sender. Anything left of the fee comes back to the
          // wallet that paid it, which is the only address we are entitled to name.
          "SENDER",
        ],
        // `send` is payable and the fee rides on the call itself. A caller that
        // ignored this would have the transaction revert having spent gas.
        value: fee.nativeFee.toString(),
      }),
      format: "evm-tx",
      describes:
        `Send ${readableAmount(sends, resolved.tokenDecimals)} ${resolved.tokenSymbol} to ` +
        `${route.destination} on Stellar, via LayerZero. ${describeDvnStack(resolved.uln)}`,
      ephemeralSigners: [],
      unnecessaryWhen: undefined,
    };

    if (!resolved.approvalRequired) {
      // A mint-and-burn OFT destroys the sender's own balance, so there is no
      // allowance to grant and asking for one would cost gas for nothing.
      return [send];
    }

    const approval = buildApproval({
      token: resolved.token,
      // The OFT contract itself, not the token and not the endpoint. It is the
      // contract that calls transferFrom.
      spender: resolved.oft as `0x${string}`,
      amount: sends,
      decimals: resolved.tokenDecimals,
      symbol: resolved.tokenSymbol,
    });

    // Two transactions, in this order. The adapter pulls the funds with
    // transferFrom, so the allowance has to exist before the send goes out.
    return [
      {
        chainId: route.fromChain.id,
        payload: JSON.stringify({
          to: approval.contract,
          abi: ERC20_ABI,
          functionName: approval.functionName,
          args: [approval.args[0], approval.args[1].toString()],
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
      send,
    ];
  }

  /**
   * Where the cross-chain leg stands.
   *
   * LayerZero publishes no attestation, only an indexer, so this is one read
   * against it. The indexer lagging is the normal state for the first minute
   * after a send, and it is reported as pending rather than as anything having
   * gone wrong: telling someone their transfer failed when it is merely
   * unindexed is how they are talked into sending a second one.
   */
  async status(handle: TransferHandle): Promise<StepPhase> {
    if (handle.sourceTxHash === undefined) return { phase: "idle" };

    const messages = await this.scan.byTransaction(handle.sourceTxHash);
    // One transaction can carry several messages. Ours is the one bound for
    // Stellar; anything else in the same transaction is not this transfer.
    const stellarEid = STELLAR_SIDE[this.network].eid;
    const message = messages.find((m) => m.pathway?.dstEid === stellarEid) ?? messages[0];

    // Which chain it left from, taken from the message when the caller did not
    // say. Someone who closed the tab may have nothing but a hash, and this
    // product's stated advantage over the prior art is recovering from whatever
    // they still have rather than telling them it is lost.
    const chainId =
      handle.sourceChainId ??
      chainIdForLayerZeroKey(this.network, message?.pathway?.sender?.chain ?? "");

    const explorerUrl =
      chainId === undefined
        ? scanMessageUrl(this.network, handle.sourceTxHash)
        : explorerTxUrl(this.network, chainId, handle.sourceTxHash);
    const ref = {
      chainId: chainId ?? "unknown",
      txHash: handle.sourceTxHash,
      explorerUrl,
    };

    if (message === undefined) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    const name = message.status?.name;
    const outcome = classifyScanStatus(name);
    const scanUrl = scanMessageUrl(this.network, handle.sourceTxHash);

    if (outcome === "pending") {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    if (outcome === "stalled") {
      const sentAt = message.source?.tx?.blockTimestamp ?? 0;
      const now = Math.floor(Date.now() / 1000);
      return {
        phase: "stalled",
        ref,
        overdueSeconds: sentAt === 0 ? 0 : Math.max(0, now - sentAt),
        remedy: remedyForStatus(name, scanUrl, now),
      };
    }

    const deliveredTx = message.destination?.tx?.txHash;
    const received = await this.receivedFrom(message.source?.tx, chainId);
    if (received === undefined) {
      // Delivered, but the payload was not indexed with it, so the amount cannot
      // be stated. Claiming a number here would be inventing one.
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    return {
      phase: "done",
      ref: {
        chainId: STELLAR_SIDE[this.network].chainId,
        txHash: deliveredTx ?? handle.sourceTxHash,
        explorerUrl:
          deliveredTx === undefined ? scanUrl : stellarExplorerTxUrl(this.network, deliveredTx),
      },
      received,
    };
  }

  /**
   * What actually landed, decoded from the message rather than guessed.
   *
   * The wire payload carries the amount in shared decimals, which is the number
   * the destination credits after every fee and after the dust the contract
   * truncates. It is the only exact figure available, and reading the
   * recipient's balance instead would report their whole holding as if this
   * transfer had delivered it.
   */
  private async receivedFrom(
    tx: { readonly payload?: string } | undefined,
    chainId: string | undefined,
  ): Promise<Amount | undefined> {
    const payload = tx?.payload;
    if (payload === undefined || chainId === undefined) return undefined;

    let amountSd: bigint;
    try {
      amountSd = decodeOftMessage(payload).amountSd;
    } catch {
      return undefined;
    }

    // The payload counts in shared decimals and Stellar counts in seven, and
    // only the OFT knows the difference between them. Resolving rather than
    // reading a cache, because a caller polling status in a fresh process has
    // no cache and would otherwise watch a delivered transfer sit at pending
    // forever. Discovery caches it after the first call.
    let route: ResolvedRoute;
    try {
      route = await this.discovery.routeFrom(chainId);
    } catch {
      return undefined;
    }

    return {
      asset: {
        chainId: STELLAR_SIDE[this.network].chainId,
        id: route.stellar.token,
        symbol: route.tokenSymbol,
        decimals: STELLAR_DECIMALS,
        curatedBy: "LayerZero",
      },
      baseUnits: sharedToStellar(amountSd, route.stellar.decimalsDiff).toString(),
    };
  }

  /**
   * How long delivery should take, worked out rather than picked.
   *
   * A message is not verified until the source chain reaches the confirmation
   * depth the application configured, so the honest estimate is that depth in
   * blocks plus the executor's turnaround. USDT0 asks for 65 confirmations,
   * which is fifteen seconds on Arbitrum and twelve minutes on Ethereum. One
   * number for both would be wrong for both.
   */
  private estimateSeconds(route: ResolvedRoute): number {
    const confirmations = Number(route.uln.confirmations);
    const waiting = (confirmations * route.source.averageBlockMs) / 1000;
    // The executor still has to be paid attention to, build the Stellar
    // transaction and get it into a ledger. Sixty seconds is deliberately not
    // optimistic; a quote that promises fast and delivers slow is the failure
    // the status engine's stalled state exists to catch.
    return Math.round(waiting + 60);
  }

  /**
   * The executor options to send with, taken from the contract or refused.
   *
   * An OFT that enforces its own options needs none from us, and supplying them
   * anyway is not neutral: `combineOptions` prepends the enforced bytes to ours,
   * so we would be buying gas the contract already bought.
   */
  private optionsFor(route: ResolvedRoute): `0x${string}` {
    if (route.enforcedOptions.length > 2) return "0x";
    if (this.lzReceiveGas === undefined) {
      throw new MavnaError(
        `The OFT at ${route.oft} enforces no execution options for the Stellar pathway, so a ` +
          "gas limit has to come from somewhere. Pass `lzReceiveGas` to the adapter with a " +
          "figure that contract's own deployment uses. Guessing it here would either waste " +
          "the sender's money or leave the executor unpaid and the message undelivered.",
        { retryable: false },
      );
    }
    return executorLzReceiveOption(this.lzReceiveGas);
  }

  /** A Stellar asset from a `CODE:ISSUER` identifier, or undefined if it is not one. */
  private stellarAssetOf(asset: Asset): StellarAsset | undefined {
    const [code, issuer] = asset.id.split(":");
    if (code === undefined || issuer === undefined || issuer === "") return undefined;
    try {
      return new StellarAsset(code, issuer);
    } catch {
      return undefined;
    }
  }

  private chainRefFor(chainId: string): ChainRef {
    if (chainId === STELLAR_SIDE[this.network].chainId) {
      return {
        id: chainId,
        name: "Stellar",
        explorerTxUrl: (hash) => stellarExplorerTxUrl(this.network, hash),
      };
    }
    const source = sourceFor(this.network, chainId);
    return {
      id: chainId,
      name: source?.name ?? chainId,
      explorerTxUrl: (hash) => explorerTxUrl(this.network, chainId, hash),
    };
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

function nativeAssetOf(chainId: string, source: EvmSource): Asset {
  return {
    chainId,
    id: "native",
    symbol: source.nativeCurrency.symbol,
    decimals: source.nativeCurrency.decimals,
    curatedBy: undefined,
  };
}

function xlmAsset(chainId: string): Asset {
  return {
    chainId,
    id: "native",
    symbol: "XLM",
    decimals: STELLAR_DECIMALS,
    curatedBy: "Stellar",
  };
}

/**
 * The Stellar asset a route delivers, as the order book knows it.
 *
 * Asset ids here are `CODE:ISSUER`, which is the only unambiguous form: anyone
 * can issue an asset called USDC, so the code alone is not an identity.
 */
function stellarAssetFor(asset: { readonly id: string; readonly symbol: string }): StellarAsset {
  const [code, issuer] = asset.id.split(":");
  if (issuer === undefined || issuer === "") return StellarAsset.native();
  return new StellarAsset(code ?? asset.symbol, issuer);
}
