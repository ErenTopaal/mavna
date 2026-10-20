import type {
  AllowanceCheck,
  Amount,
  Asset,
  BridgeAdapter,
  ChainRef,
  ComposeArrival,
  ComposeQuoteRequest,
  NetworkId,
  OnChainRef,
  QuoteRequest,
  Route,
  RouteRejection,
  StepPhase,
  TransferHandle,
  TrustModel,
  UnsignedTransaction,
} from "@mavna/core";
import { MavnaError, rejectionIsRetryable, SENDER_ADDRESS } from "@mavna/core";
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
import { encodePacked, isAddress, isHex, keccak256, pad } from "viem";
import { decodeOftComposePayload } from "./compose.js";
import {
  type ArrivalSetup,
  type ComposeContext,
  composedElsewhere,
  composePhase,
  composeSendFor,
  quoteComposeRoute,
} from "./compose-route.js";
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
import {
  Discovery,
  type OftLocation,
  type ResolvedRoute,
  readStellarOft,
  readStellarToken,
} from "./discovery.js";
import { describeDvnStack } from "./dvn.js";
import {
  badSlippage,
  buildApproval,
  buildSendParam,
  bytes32ToStellarContract,
  decodeOftMessage,
  ERC20_ABI,
  executorLzReceiveOption,
  localToStellar,
  minAmountFor,
  OFT_ABI,
  sharedToStellar,
  stellarRecipientToBytes32,
} from "./oft.js";
import {
  classifyScanStatus,
  remedyForStatus,
  type ScanMessage,
  ScanService,
  scanMessageUrl,
} from "./scan.js";

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

/** The native fee is attached with a tenth on top, refunded when unused. */
const FEE_HEADROOM_DIVISOR = 10n;

export interface LayerZeroAdapterOptions {
  readonly network: NetworkId;
  /** Used to inspect the destination and to read the Stellar side of the pathway. */
  readonly rpc: RpcClient;
  /**
   * The network's base reserve, as configured. Nothing here reads it from the
   * ledger: callers pass `NetworkConfig.baseReserveStroops`, which defaults to
   * the 0.5 XLM last confirmed on both networks and is overridable because it
   * is a network parameter and has changed before.
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
  /**
   * The Mavna Arrival Contract and the venue it converts through. Without it
   * this rail offers no compose routes, which is the case on every network
   * until a contract is deployed there.
   */
  readonly arrival?: ArrivalSetup;
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
   * parties, and `describeDvnStack` names them on every send this adapter
   * builds.
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
  private readonly composing: ComposeContext | undefined;

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
    this.composing =
      options.arrival === undefined
        ? undefined
        : {
            network: options.network,
            rpc: options.rpc,
            passphrase: this.passphrase,
            discovery: this.discovery,
            arrival: options.arrival,
            lzReceiveGas: options.lzReceiveGas,
            decline: (reason, explanation) => this.decline(reason, explanation),
          };
  }

  /**
   * The same send, delivered to the Arrival Contract with instructions to
   * convert on arrival, so the user signs once and needs no Stellar wallet.
   */
  async quoteCompose(request: ComposeQuoteRequest): Promise<Route | RouteRejection | undefined> {
    if (this.composing === undefined) {
      // said rather than left out, so the user sees why only the plain route is there
      return this.decline(
        "chain-unsupported",
        `There is no Arrival Contract on ${this.network} yet, so nothing converts on arrival ` +
          "here: deploying one needs a signature on that network this app does not make. The " +
          "plain route still delivers, and the conversion is signed on Stellar.",
      );
    }
    return quoteComposeRoute(this.composing, request);
  }

  supportedChains(): Promise<readonly string[]> {
    return Promise.resolve(sourceChainsFor(this.network));
  }

  /**
   * What a user on this chain can send over this rail, and what it lands as.
   *
   * Both sides come from the deployment rather than from a table: the source
   * token is whatever the OFT's own `token()` answers, and the Stellar asset is
   * read from the storage of the token the Stellar OFT credits. An app building
   * a quote request from this cannot name a token by symbol, which matters on a
   * rail whose token anyone could imitate. Rejects, in words a person can read,
   * when the chain has no route or what lands has no classic identity.
   */
  async sendableAssets(chainId: string): Promise<{ readonly from: Asset; readonly to: Asset }> {
    const route = await this.discovery.routeFrom(chainId);
    if (route.delivers === undefined) {
      throw new MavnaError(
        `${route.tokenSymbol} from ${route.source.name} lands on Stellar as the token contract ` +
          `${route.stellar.token}, which is not a Stellar asset with a code and an issuer, so ` +
          "this app cannot check or show the account it would arrive in.",
        { retryable: false },
      );
    }
    return {
      from: {
        chainId,
        id: route.token,
        symbol: route.tokenSymbol,
        decimals: route.tokenDecimals,
        curatedBy: "LayerZero",
      },
      to: {
        chainId: STELLAR_SIDE[this.network].chainId,
        id: route.delivers.id,
        symbol: route.delivers.code,
        decimals: STELLAR_DECIMALS,
        curatedBy: "LayerZero",
      },
    };
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    const stellarChainId = STELLAR_SIDE[this.network].chainId;
    const slippage = badSlippage(request.maxSlippageBps);
    if (slippage !== undefined) {
      // the caller's input, so asking again will not help
      return { ...this.decline("errored", slippage), retryable: false };
    }

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
    // Labelled with what the token itself says it is, so a request that named
    // the right asset under some other symbol still shows the real one.
    const arrives: Asset =
      route.delivers === undefined
        ? request.to
        : {
            ...request.to,
            id: route.delivers.id,
            symbol: route.delivers.code,
            decimals: STELLAR_DECIMALS,
          };

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

    const [fee, oftQuote] = await Promise.all([
      this.discovery.quoteNativeFee(route, sendParam),
      this.discovery.quoteDelivered(route, sendParam),
    ]);

    if (fee === undefined || oftQuote === undefined) {
      // The contract refused to price it. On mainnet the documented cause is a
      // verifier set that resolves to a DVN which is not deployed, which cannot
      // be fixed from here and is not the user's doing.
      return this.decline(
        "temporarily-unavailable",
        `${source.name}'s ${route.tokenSymbol} contract would not price a transfer to Stellar ` +
          "right now. Nothing about the amount or the address is wrong.",
      );
    }

    const deliveredLocal = oftQuote.received;
    if (sends > oftQuote.maxAmountLD) {
      return this.decline(
        "amount-too-large",
        `${source.name}'s ${route.tokenSymbol} contract carries at most ` +
          `${readableAmount(oftQuote.maxAmountLD, route.tokenDecimals)} ${route.tokenSymbol} in one ` +
          "transfer. Send less, or split it.",
      );
    }
    if (sends < oftQuote.minAmountLD) {
      return this.decline(
        "amount-too-small",
        `${source.name}'s ${route.tokenSymbol} contract carries at least ` +
          `${readableAmount(oftQuote.minAmountLD, route.tokenDecimals)} ${route.tokenSymbol} in one transfer.`,
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

    let destination: Awaited<ReturnType<typeof inspectDestination>>;
    try {
      // read once the amount is known, so a trustline is held to what lands
      destination = await inspectDestination(this.rpc, request.destination, wanted, {
        amountStroops: delivered,
      });
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

    let inbound: { readonly paused: boolean; readonly capacity: bigint };
    try {
      inbound = await this.discovery.stellarInbound(route);
    } catch (cause) {
      return this.decline(
        "temporarily-unavailable",
        cause instanceof MavnaError
          ? cause.message
          : "The Stellar side of this route could not be read right now.",
      );
    }
    if (inbound.paused) {
      return this.decline(
        "temporarily-unavailable",
        `${route.tokenSymbol} on Stellar is paused by its operator, so nothing sent now would be ` +
          "delivered until it resumes. Nothing has been sent.",
      );
    }
    if (delivered > inbound.capacity) {
      return this.decline(
        "amount-too-large",
        `Stellar's ${route.tokenSymbol} contract will take in at most ` +
          `${readableAmount(inbound.capacity, STELLAR_DECIMALS)} from ${source.name} right now. ` +
          "Send less, or wait for its limit to refill.",
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
        arrives.decimals,
        await this.prices.xlmStroopsPerUnit(stellarAssetFor(arrives)),
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
      bridgeDelivers: arrives.id,
      userWants: arrives.id,
      // A token is arriving, not XLM, so nothing about the account pays for itself.
      arrivingXlmCoversReserve: false,
      // Asked of the contract, never assumed from the deployment's name. USDT0
      // answers true on Ethereum, where it locks real USDT, and false on
      // Arbitrum, Optimism and Polygon, where it mints and burns.
      sourceNeedsApproval: route.approvalRequired,
    });

    const receives: Amount = { asset: arrives, baseUnits: delivered.toString() };
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
      receivesAtLeast: { asset: arrives, baseUnits: guaranteed.toString() },
      deliveredAtLeast: { asset: arrives, baseUnits: guaranteed.toString() },
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
    const minAmount = minAmountFor(route, resolved);

    const composed =
      route.compose === undefined ? undefined : await this.composeSend(route, resolved);
    const sendParam = buildSendParam({
      dstEid: STELLAR_SIDE[this.network].eid,
      stellarRecipient: composed?.to ?? route.destination,
      amount: sends,
      minAmount,
      extraOptions: composed?.extraOptions ?? this.optionsFor(resolved),
      composeMsg: composed?.composeMsg,
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

    // Still a block or more old by the time it is signed, and on Ethereum the
    // approval confirms in between. The endpoint reverts a send whose fee went
    // up and refunds whatever is attached beyond the fee, so a tenth on top
    // costs nothing unless it is needed. The OApp requires the fee argument and
    // the value to be equal, so both carry it.
    const attached =
      fee.nativeFee + (fee.nativeFee + FEE_HEADROOM_DIVISOR - 1n) / FEE_HEADROOM_DIVISOR;
    const native = nativeAssetOf(route.fromChain.id, resolved.source);
    const feeNote =
      ` Attaches up to ${readableAmount(attached, native.decimals)} ${native.symbol} for ` +
      "LayerZero's delivery fee; whatever is not needed is refunded to this wallet.";

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
          { nativeFee: attached.toString(), lzTokenFee: fee.lzTokenFee.toString() },
          // Refunded to the sender. Anything left of the fee comes back to the
          // wallet that paid it, which is the only address we are entitled to name.
          SENDER_ADDRESS,
        ],
        // `send` is payable and the fee rides on the call itself. A caller that
        // ignored this would have the transaction revert having spent gas.
        value: attached.toString(),
      }),
      format: "evm-tx",
      describes:
        route.compose === undefined
          ? `Send ${readableAmount(sends, resolved.tokenDecimals)} ${resolved.tokenSymbol} to ` +
            `${route.destination} on Stellar, via LayerZero. ` +
            describeDvnStack(resolved.uln, resolved.dvnNames) +
            feeNote
          : describeComposeSend(route.compose, route.destination, sends, resolved) + feeNote,
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

    const approveTx = (amount: bigint, describes: string, skip: AllowanceCheck) => ({
      chainId: route.fromChain.id,
      payload: JSON.stringify({
        to: approval.contract,
        abi: ERC20_ABI,
        functionName: approval.functionName,
        args: [approval.args[0], amount.toString()],
      }),
      format: "evm-tx" as const,
      describes,
      ephemeralSigners: [],
      unnecessaryWhen: skip,
    });
    // A wallet that has approved this much already should not be asked again.
    const covered: AllowanceCheck = {
      kind: "erc20-allowance",
      token: approval.contract,
      spender: approval.args[0],
      atLeastBaseUnits: sends.toString(),
    };

    // In this order. The adapter pulls the funds with transferFrom, so the
    // allowance has to exist before the send goes out. Ahead of it, a reset to
    // zero: Tether's USDT, which the Ethereum adapter locks, reverts an approve
    // when both the old and the new allowance are non-zero, so someone who
    // approved a smaller amount earlier and never sent could not approve again.
    // The token's behaviour cannot be asked without the sender's address, so
    // the reset is always built and skipped unless an allowance sits between
    // zero and the amount, which is the only case it changes anything.
    return [
      approveTx(
        0n,
        `Clear the ${resolved.tokenSymbol} allowance you gave the LayerZero transfer contract ` +
          `earlier, so it can be set to this transfer's amount. ${resolved.tokenSymbol} does not ` +
          "allow an allowance to be changed without clearing it first. This moves no funds.",
        { ...covered, skipAlsoWhenExactly: "0" },
      ),
      approveTx(sends, approval.describes, covered),
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
    const pendingRef = this.sourceRef(handle.sourceTxHash, handle.sourceChainId);
    // Nothing indexed yet is the normal first minute, not evidence of anything.
    if (messages.length === 0) return { phase: "pending", ref: pendingRef, expectedByUnix: 0 };

    // Indexed, but none of it is a transfer this rail can vouch for: a message
    // to another chain, or another contract's message to Stellar. Answering
    // for it would report someone else's transfer as this user's delivery.
    const ours = await this.oursAmong(messages, handle.sourceChainId);
    if (ours === undefined) return { phase: "idle" };
    const { message, chainId } = ours;
    const ref = this.sourceRef(handle.sourceTxHash, chainId);

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
    if (this.composing !== undefined) {
      const composed = await composePhase(this.composing, message, chainId, {
        chainId: STELLAR_SIDE[this.network].chainId,
        txHash: deliveredTx ?? handle.sourceTxHash,
        explorerUrl:
          deliveredTx === undefined ? scanUrl : stellarExplorerTxUrl(this.network, deliveredTx),
      });
      if (composed !== undefined) return composed;
    } else {
      // no Arrival Contract here, yet the message carries a compose for one
      const payload = message.source?.tx?.payload;
      const compose = payload === undefined ? undefined : decodeOftComposePayload(payload);
      if (compose !== undefined) {
        return composedElsewhere(this.network, bytes32ToStellarContract(compose.sendTo), {
          chainId: STELLAR_SIDE[this.network].chainId,
          txHash: deliveredTx ?? handle.sourceTxHash,
          explorerUrl:
            deliveredTx === undefined ? scanUrl : stellarExplorerTxUrl(this.network, deliveredTx),
        });
      }
    }
    const received = await this.receivedFrom(message.source?.tx, ours);
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

  private composeSend(route: Route, resolved: ResolvedRoute): ReturnType<typeof composeSendFor> {
    const compose = route.compose;
    if (this.composing === undefined || compose === undefined) {
      throw new MavnaError(
        "This route converts on arrival, and this adapter has no Arrival Contract configured " +
          "to send it to.",
        { retryable: false },
      );
    }
    return composeSendFor(this.composing, { ...route, compose }, resolved);
  }

  /**
   * The source chain's ref, with a link to wherever the transaction can be seen.
   */
  private sourceRef(txHash: string, chainId: string | undefined): OnChainRef {
    return {
      chainId: chainId ?? "unknown",
      txHash,
      explorerUrl:
        chainId === undefined
          ? scanMessageUrl(this.network, txHash)
          : explorerTxUrl(this.network, chainId, txHash),
    };
  }

  /**
   * The message in a transaction that is this rail's, checked against the
   * chain rather than taken on the indexer's word.
   *
   * Bound for Stellar, sent by an OFT this rail would have sent through, from
   * the endpoint that OFT is registered on, to the Stellar contract it peers
   * to, and carrying the guid the endpoint derives from exactly that pathway.
   * Anything short of all of it is not a transfer this rail can speak for.
   */
  private async oursAmong(
    messages: readonly ScanMessage[],
    sourceChainId: string | undefined,
  ): Promise<OurMessage | undefined> {
    const stellarEid = STELLAR_SIDE[this.network].eid;
    for (const message of messages) {
      const pathway = message.pathway;
      if (pathway?.dstEid !== stellarEid) continue;
      const chainId =
        sourceChainId ?? chainIdForLayerZeroKey(this.network, pathway.sender?.chain ?? "");
      const sender = pathway.sender?.address?.toLowerCase();
      const receiver = pathway.receiver?.address?.toLowerCase();
      const { nonce, srcEid } = pathway;
      if (
        chainId === undefined ||
        sender === undefined ||
        !isAddress(sender) ||
        receiver === undefined ||
        !isHex(receiver) ||
        receiver.length !== 66 ||
        nonce === undefined ||
        srcEid === undefined ||
        message.guid === undefined
      ) {
        continue;
      }
      const candidate = (await this.discovery.candidatesFor(chainId)).find(
        (c) => c.address.toLowerCase() === sender,
      );
      if (candidate === undefined) continue;
      const onChain = await this.discovery.pathwayOf(chainId, sender);
      if (onChain.sourceEid !== srcEid || onChain.peer !== receiver) continue;
      const guid = keccak256(
        encodePacked(
          ["uint64", "uint32", "bytes32", "uint32", "bytes32"],
          [BigInt(nonce), srcEid, pad(sender), stellarEid, receiver],
        ),
      );
      if (guid !== message.guid.toLowerCase()) continue;
      return {
        message,
        chainId,
        symbol: candidate.symbol,
        stellarOft: bytes32ToStellarContract(receiver),
      };
    }
    return undefined;
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
    ours: OurMessage,
  ): Promise<Amount | undefined> {
    const payload = tx?.payload;
    if (payload === undefined) return undefined;

    let amountSd: bigint;
    try {
      amountSd = decodeOftMessage(payload).amountSd;
    } catch {
      // indexed without a readable payload yet, so there is no amount to state
      return undefined;
    }

    // The scale and the asset come from the Stellar OFT the message was
    // delivered to, read directly. Not from a full route resolution: those
    // gates decide whether a new send is safe, and one failing today must not
    // make yesterday's delivery unreadable. A read that fails is thrown, so
    // the caller says it could not check rather than showing pending forever.
    const facts = await readStellarOft(this.rpc, ours.stellarOft);
    const delivers = await readStellarToken(this.rpc, facts.token, this.passphrase);

    return {
      asset: {
        chainId: STELLAR_SIDE[this.network].chainId,
        // The classic asset where there is one, so what Activity shows is a
        // Stellar asset a wallet recognises rather than its contract address.
        id: delivers?.id ?? facts.token,
        symbol: delivers?.code ?? ours.symbol,
        decimals: STELLAR_DECIMALS,
        curatedBy: "LayerZero",
      },
      baseUnits: sharedToStellar(amountSd, facts.decimalsDiff).toString(),
    };
  }

  /**
   * How long delivery should take, worked out rather than picked.
   *
   * A message is not verified until the source chain reaches the confirmation
   * depth the application configured, so the honest estimate is that depth in
   * blocks plus the executor's turnaround. The depth is per chain and comes
   * from the live config (USDT0: 65 on Ethereum, 4000 on Arbitrum) and the block
   * time from the chain's table entry, so one number for every chain would be
   * wrong for most.
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
    return { source: this.id, reason, explanation, retryable: rejectionIsRetryable(reason) };
  }
}

/** A Scan message this rail has checked is its own, and what that check learned. */
interface OurMessage {
  readonly message: ScanMessage;
  readonly chainId: string;
  readonly symbol: string;
  /** The Stellar OFT it was delivered to, from the pathway the chain confirmed. */
  readonly stellarOft: string;
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

function describeComposeSend(
  compose: ComposeArrival,
  destination: string,
  sends: bigint,
  resolved: ResolvedRoute,
): string {
  const atLeast = readableAmount(BigInt(compose.minOut), compose.wanted.decimals);
  return (
    `Send ${readableAmount(sends, resolved.tokenDecimals)} ${resolved.tokenSymbol} via ` +
    `LayerZero to the Mavna Arrival Contract on Stellar, which converts it for ${destination} ` +
    `into at least ${atLeast} ${compose.wanted.symbol}, or sends ${compose.arriving.symbol} on ` +
    `as it came if it cannot. ${describeDvnStack(resolved.uln, resolved.dvnNames)}`
  );
}
