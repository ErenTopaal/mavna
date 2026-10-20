import type {
  Amount,
  Asset,
  BridgeAdapter,
  BuildContext,
  ChainRef,
  Fee,
  NetworkId,
  QuoteRequest,
  Route,
  RouteRejection,
  StepPhase,
  TransferHandle,
  TrustModel,
  UnsignedTransaction,
} from "@mavna/core";
import { MavnaError, rejectionIsRetryable } from "@mavna/core";
import { type PlannedStep, planTransfer, signatureCount } from "@mavna/routing";
import {
  type ArrivingValue,
  belowFloorGuidance,
  classifyAddress,
  type DestinationLane,
  inspectDestination,
  meetsFloor,
  quoteReserve,
  type RpcClient,
  valueInXlm,
  XlmPriceSource,
} from "@mavna/stellar";
import { Address, Asset as StellarAsset, xdr } from "@stellar/stellar-sdk";
import {
  OneClickApi,
  type OneClickOptions,
  OneClickRefused,
  type OneClickToken,
  type QuoteBody,
  type QuoteReply,
} from "./api.js";
import {
  originAsset,
  originToken,
  type StellarDelivery,
  stellarAsset,
  stellarChainId,
  stellarDeliveries,
} from "./assets.js";
import { ORIGIN_CHAINS, type OriginChain, originChain, originChainByCode } from "./chains.js";
import { fetchJsonRpc, type JsonRpc, readTransfer, transferPayload } from "./evm.js";
import { phaseFor } from "./status.js";

/**
 * NEAR Intents as a rail the routing engine can race.
 *
 * A different shape from every other rail here. The user pays an ordinary token
 * transfer into a deposit address, and a market of solvers competes to fill the
 * trade inside the NEAR Intents contract, which settles it. What they settle in
 * is HOT's wrapped Stellar token, so the payout on Stellar is a HOT Bridge
 * withdrawal: released from HOT's locker contract on a signature from HOT's MPC
 * network. Who is trusted is that market, the NEAR Intents contract and the HOT
 * Bridge. The trust model is the solver network because that is the part a
 * user is choosing; the bridge is named wherever the trust is spelled out.
 *
 * Quoting is a dry request, which reserves nothing and hands out no address. The
 * deposit address only exists once a transfer is being built, because it is tied
 * to a refund address, and only the connected wallet can say what that is.
 */

export interface NearIntentsAdapterOptions extends OneClickOptions {
  readonly network: NetworkId;
  /** Reads the Stellar side: whether the destination can hold what arrives. */
  readonly rpc: RpcClient;
  /** The network's base reserve, from `NetworkConfig.baseReserveStroops`. */
  readonly baseReserveStroops: number;
  /** Prices the arriving asset in XLM, so the sponsorship floor can be compared. */
  readonly prices?: XlmPriceSource;
  readonly horizonUrl?: string;
  /** How origin-chain reads reach a node. Injectable so tests can hold one still. */
  readonly jsonRpc?: JsonRpc;
  /**
   * How long a deposit address stays good for, in seconds. 1Click begins a
   * refund once this passes without the transfer completing, so it has to cover
   * the deposit being included on the slowest chain listed.
   */
  readonly depositWindowSeconds?: number;
}

/** An hour: far longer than any listed chain takes to include a transfer. */
const DEFAULT_DEPOSIT_WINDOW_SECONDS = 3600;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class NearIntentsAdapter implements BridgeAdapter {
  readonly id = "near-intents";
  /** Competing solvers fill it, NEAR Intents settles it, the HOT Bridge pays out on Stellar. */
  readonly trustModel: TrustModel = "solver-network";

  private readonly network: NetworkId;
  private readonly rpc: RpcClient;
  private readonly baseReserveStroops: number;
  private readonly prices: XlmPriceSource;
  private readonly api: OneClickApi;
  private readonly jsonRpc: JsonRpc;
  private readonly depositWindowSeconds: number;

  constructor(options: NearIntentsAdapterOptions) {
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
    this.api = new OneClickApi(options);
    this.jsonRpc = options.jsonRpc ?? fetchJsonRpc;
    this.depositWindowSeconds = options.depositWindowSeconds ?? DEFAULT_DEPOSIT_WINDOW_SECONDS;
  }

  /**
   * Chains a deposit can be paid from: the EVM chains listed here that 1Click
   * currently carries at least one token on. Asked, not remembered, so a chain
   * 1Click drops stops being offered without a release.
   */
  async supportedChains(): Promise<readonly string[]> {
    const chains = ORIGIN_CHAINS[this.network];
    if (chains.length === 0) return [];
    const tokens = await this.api.tokens();
    return chains
      .filter((chain) => tokens.some((t) => t.blockchain === chain.code))
      .map((chain) => chain.chainId);
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    if (request.to.chainId !== stellarChainId(this.network)) {
      return this.decline("chain-unsupported", "This route only delivers to Stellar.");
    }
    if (this.network !== "mainnet") {
      return this.decline(
        "chain-unsupported",
        "NEAR Intents runs on Stellar's main network only, so it has no route on the test network.",
      );
    }

    const chain = originChain(this.network, request.from.chainId);
    if (chain === undefined) {
      return this.decline(
        "chain-unsupported",
        "NEAR Intents cannot be paid from that chain here. It takes deposits from EVM chains only.",
      );
    }

    const sends = BigInt(request.sends.baseUnits);
    if (sends <= 0n) return this.decline("amount-too-small", "There is nothing to send.");

    const refused = this.checkDestination(request.destination);
    if (refused !== undefined) return refused;

    let tokens: readonly OneClickToken[];
    try {
      tokens = await this.api.tokens();
    } catch (cause) {
      return this.unavailable(cause);
    }

    const pair = this.resolvePair(tokens, chain, request.from, request.to);
    if ("source" in pair) return pair;
    const { origin, delivery } = pair;

    const lane = await this.laneFor(request.destination, delivery);
    if ("source" in lane) return lane;

    let reply: QuoteReply;
    try {
      reply = await this.api.quote(
        this.quoteBody({
          dry: true,
          origin,
          delivery,
          amount: sends,
          recipient: request.destination,
          // A dry quote reserves nothing and hands out no deposit address, so no
          // refund can ever be sent anywhere from it. 1Click still insists the
          // field names a real-looking wallet, and the sender is not known until
          // one is connected, so a fresh address stands in. The quote that is
          // paid is requested again at build time with the connected wallet.
          refundTo: freshEvmAddress(),
          slippageBps: request.maxSlippageBps,
        }),
      );
    } catch (cause) {
      return this.refusal(cause, chain);
    }

    const checked = this.checkQuote(reply, sends);
    if (checked !== undefined) return checked;

    const delivered = stellarAsset(this.network, delivery);
    const arriving = BigInt(reply.quote.amountOut);
    const floor = BigInt(reply.quote.minAmountOut);

    const reserve = quoteReserve({
      lane,
      // The solvers deliver the asset that was asked for, checked above.
      destinationAssetDiffers: false,
      baseReserveStroops: this.baseReserveStroops,
    });

    if (reserve.slots > 0 && delivery.id !== "native") {
      let value: ArrivingValue;
      try {
        value = valueInXlm(
          floor,
          delivered.decimals,
          await this.prices.xlmStroopsPerUnit(classicAsset(delivery.id)),
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
      if (!meetsFloor(reserve, value)) {
        return this.decline("amount-too-small", belowFloorGuidance(reserve));
      }
    }

    const steps = planTransfer({
      destination: readinessOf(lane),
      bridgeDelivers: delivery.id,
      userWants: request.to.id,
      arrivingXlmCoversReserve: false,
      // A plain transfer into the deposit address. Nothing pulls the tokens, so
      // there is no allowance to ask for.
      sourceNeedsApproval: false,
    });

    const receives: Amount = {
      asset: { ...delivered, curatedBy: request.to.curatedBy ?? delivered.curatedBy },
      baseUnits: arriving.toString(),
    };
    const atLeast: Amount = { asset: receives.asset, baseUnits: floor.toString() };
    const estimatedSeconds = Math.max(1, Math.ceil(reply.quote.timeEstimate));

    return {
      id: `near-intents-${chain.chainId}-stellar`,
      source: this.id,
      trustModel: this.trustModel,
      fromChain: chainRefFor(chain),
      toChain: stellarRef(this.network),
      destination: request.destination,
      sends: request.sends,
      receives,
      // What a solver is held to. 1Click refunds rather than delivering below it.
      receivesAtLeast: atLeast,
      deliveredAtLeast: atLeast,
      fees: [
        ...feesFrom(reply, request.sends.asset, receives.asset),
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
      estimatedSeconds,
      steps: steps.map((step: PlannedStep, index: number) => ({
        id: `${step.kind}-${index}`,
        kind: step.kind,
        source: this.id,
        from: request.sends,
        to: receives,
        estimatedSeconds: step.kind === "bridge" ? estimatedSeconds : 30,
        execution: undefined,
      })),
      signaturesRequired: signatureCount(steps),
      expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
    };
  }

  /**
   * Ask for the real quote, and build the deposit into it.
   *
   * This is the moment a deposit address is handed out, so the refund address
   * has to be real: the connected wallet, never a stand-in. The new quote is held
   * to the floor the route promised; a market that has moved below it is a new
   * quote for the user to see, not something to sign on their behalf.
   */
  async buildTransactions(
    route: Route,
    context?: BuildContext,
  ): Promise<readonly UnsignedTransaction[]> {
    const sender = context?.sender;
    if (sender === undefined || !EVM_ADDRESS.test(sender)) {
      throw new MavnaError(
        "A NEAR Intents deposit needs the sending wallet's address before it can be built, " +
          "so that a refund has somewhere to go. Connect the wallet you are sending from.",
        { retryable: false },
      );
    }

    const chain = originChain(this.network, route.fromChain.id);
    if (chain === undefined || this.network !== "mainnet") {
      throw new MavnaError("NEAR Intents cannot be paid from that chain here.", {
        retryable: false,
      });
    }

    const tokens = await this.api.tokens();
    const pair = this.resolvePair(tokens, chain, route.sends.asset, route.deliveredAtLeast.asset);
    if ("source" in pair) {
      throw new MavnaError(pair.explanation, { retryable: pair.retryable });
    }

    const amount = BigInt(route.sends.baseUnits);
    const floor = BigInt(route.deliveredAtLeast.baseUnits);
    const reply = await this.api.quote(
      this.quoteBody({
        dry: false,
        origin: pair.origin,
        delivery: pair.delivery,
        amount,
        recipient: route.destination,
        refundTo: sender,
        slippageBps: slippageOf(route),
      }),
    );

    const checked = this.checkQuote(reply, amount);
    if (checked !== undefined) {
      throw new MavnaError(checked.explanation, { retryable: checked.retryable });
    }
    if (reply.refundTo.toLowerCase() !== sender.toLowerCase()) {
      throw new MavnaError(
        "1Click recorded a different refund address than the connected wallet. Refusing " +
          "to build a deposit whose refund would go somewhere else.",
        { retryable: false },
      );
    }
    // The deposit address is only worth paying if it is for this transfer: to
    // this recipient, of this token, into this asset. 1Click holds the money
    // either way, so this is a second look rather than the only one.
    const echoes: Array<[string | undefined, string, string]> = [
      [reply.recipient, route.destination, "recipient"],
      [reply.originAsset, pair.origin.assetId, "token to take"],
      [reply.destinationAsset, pair.delivery.token.assetId, "asset to deliver"],
    ];
    for (const [recorded, asked, what] of echoes) {
      if (recorded !== asked) {
        throw new MavnaError(
          `1Click recorded a different ${what} than this transfer asked for. Refusing to ` +
            "build a deposit for someone else's quote.",
          { retryable: false },
        );
      }
    }
    if (BigInt(reply.quote.minAmountOut) < floor) {
      throw new MavnaError(
        "The price moved since this route was quoted, and the least it would now deliver is " +
          "below what you were shown. Nothing has been sent; ask for a new quote.",
        { retryable: true },
      );
    }

    // Checked as an EVM address when the reply was read.
    const depositAddress = reply.quote.depositAddress as string;
    const token = route.sends.asset;
    return [
      {
        chainId: chain.chainId,
        payload: transferPayload(token.id, depositAddress, amount),
        format: "evm-tx",
        describes:
          `Send ${readable(amount, token.decimals)} ${token.symbol} on ${chain.name} to the ` +
          `NEAR Intents deposit address ${depositAddress}. A solver fills it and the HOT Bridge ` +
          `pays at least ${readable(floor, route.deliveredAtLeast.asset.decimals)} ` +
          `${route.deliveredAtLeast.asset.symbol} to ${route.destination} on Stellar, or ` +
          `the deposit is returned to ${sender} once the quote expires` +
          (reply.quote.deadline === undefined ? "." : ` (${reply.quote.deadline}).`),
        unnecessaryWhen: undefined,
        ephemeralSigners: [],
      },
    ];
  }

  /**
   * Where a transfer stands, found by its deposit address.
   *
   * The deposit address is what 1Click knows a transfer by. With only the
   * transaction that paid it, the address is read back out of that transaction
   * on the chain it was sent on, and every listed chain is searched when the
   * caller does not know which.
   */
  async status(handle: TransferHandle): Promise<StepPhase> {
    if (this.network !== "mainnet") return { phase: "idle" };

    const tokens = await this.api.tokens();
    let depositAddress = handle.depositAddress;
    let chain: OriginChain | undefined =
      handle.sourceChainId === undefined
        ? undefined
        : originChain(this.network, handle.sourceChainId);

    if (depositAddress === undefined) {
      if (handle.sourceTxHash === undefined) return { phase: "idle" };
      if (handle.sourceChainId !== undefined && chain === undefined) return { phase: "idle" };
      const found = await this.findDeposit(handle.sourceTxHash, chain, tokens);
      if (found === undefined) return { phase: "idle" };
      depositAddress = found.to;
      chain = found.chain;
    }

    const reply = await this.api.status(depositAddress);
    if (reply === undefined) return { phase: "idle" };

    const originEntry = tokens.find((t) => t.assetId === reply.originAsset);
    const originOf =
      chain ?? (originEntry && originChainByCode(this.network, originEntry.blockchain));
    const deliveredEntry = stellarDeliveries(tokens).find(
      (d) => d.token.assetId === reply.destinationAsset,
    );
    if (originEntry === undefined || originOf === undefined || deliveredEntry === undefined) {
      // A deposit address of 1Click's, for a transfer that is not one of this
      // rail's: some other chain or asset. Not ours to describe.
      return { phase: "idle" };
    }

    return phaseFor(reply, {
      network: this.network,
      depositAddress,
      sourceTxHash: handle.sourceTxHash,
      origin: originOf,
      originAsset: originAsset(originOf, originEntry),
      delivered: stellarAsset(this.network, deliveredEntry),
    });
  }

  private async findDeposit(
    txHash: string,
    known: OriginChain | undefined,
    tokens: readonly OneClickToken[],
  ): Promise<{ chain: OriginChain; to: string } | undefined> {
    const chains = known === undefined ? ORIGIN_CHAINS[this.network] : [known];
    const results = await Promise.allSettled(
      chains.map(async (chain) => ({
        chain,
        sent: await readTransfer(chain, txHash, this.jsonRpc),
      })),
    );

    for (const result of results) {
      if (result.status !== "fulfilled" || result.value.sent === undefined) continue;
      const { chain, sent } = result.value;
      // Only a transfer of a token 1Click carries from that chain can be a
      // deposit. Anything else is someone else's transaction.
      if (originToken(tokens, chain, sent.token) !== undefined) return { chain, to: sent.to };
    }

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // Not found, but not every chain could be asked, so "not found" is not
      // known. Said rather than reported as idle.
      const first = failed[0] as PromiseRejectedResult;
      throw first.reason instanceof Error
        ? first.reason
        : new MavnaError(String(first.reason), { retryable: true });
    }
    return undefined;
  }

  private resolvePair(
    tokens: readonly OneClickToken[],
    chain: OriginChain,
    from: Asset,
    to: Asset,
  ): { origin: OneClickToken; delivery: StellarDelivery } | RouteRejection {
    const origin = originToken(tokens, chain, from.id);
    if (origin === undefined) {
      return this.decline(
        "asset-unsupported",
        `NEAR Intents does not take ${from.symbol} deposits on ${chain.name}.`,
      );
    }
    // The amount is in the caller's decimals and 1Click reads it in its own. If
    // the two disagree, one of them is describing a different token.
    if (origin.decimals !== from.decimals) {
      return this.decline(
        "asset-unsupported",
        `NEAR Intents lists that token with ${origin.decimals} decimals, not ${from.decimals}, ` +
          "so the amount would be read as a different number.",
      );
    }

    const deliveries = stellarDeliveries(tokens);
    const delivery = deliveries.find((d) => d.id === to.id);
    if (delivery === undefined) {
      const offered = deliveries.map((d) => d.token.symbol).join(" and ");
      return this.decline(
        "asset-unsupported",
        offered.length === 0
          ? "NEAR Intents is not delivering any asset to Stellar right now."
          : `NEAR Intents delivers ${offered} on Stellar, and not the asset asked for.`,
      );
    }
    return { origin, delivery };
  }

  private quoteBody(input: {
    dry: boolean;
    origin: OneClickToken;
    delivery: StellarDelivery;
    amount: bigint;
    recipient: string;
    refundTo: string;
    slippageBps: number;
  }): QuoteBody {
    return {
      dry: input.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: input.slippageBps,
      originAsset: input.origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: input.delivery.token.assetId,
      amount: input.amount.toString(),
      refundTo: input.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + this.depositWindowSeconds * 1000).toISOString(),
    };
  }

  /** What a quote reply must say before anything is built or shown from it. */
  private checkQuote(reply: QuoteReply, sends: bigint): RouteRejection | undefined {
    const { quote } = reply;
    if (BigInt(quote.amountIn) !== sends) {
      return this.decline(
        "errored",
        "NEAR Intents quoted a different amount than the one asked about.",
      );
    }
    if (BigInt(quote.amountOut) <= 0n || BigInt(quote.minAmountOut) <= 0n) {
      return this.decline("amount-too-small", "That amount would arrive on Stellar as nothing.");
    }
    if (BigInt(quote.minAmountOut) > BigInt(quote.amountOut)) {
      return this.decline(
        "errored",
        "NEAR Intents returned a quote whose floor is above its own price.",
      );
    }
    return undefined;
  }

  /**
   * What the destination needs before the delivered asset can land.
   *
   * USDC on Stellar is a classic asset: an account and a trustline, and both can
   * be prepared before the deposit. 1Click only delivers to a plain account
   * address, so a contract or muxed address was refused before this.
   *
   * XLM needs the account to exist. Whether NEAR Intents' bridge creates one when
   * it is missing is not documented anywhere it could be checked, and a payment
   * to a missing account is how funds end up stuck, so that lane is declined.
   */
  private async laneFor(
    destination: string,
    delivery: StellarDelivery,
  ): Promise<DestinationLane | RouteRejection> {
    if (delivery.id === "native") {
      let exists: boolean;
      try {
        exists = await this.accountExists(destination);
      } catch (cause) {
        return this.unreadDestination(cause);
      }
      if (!exists) {
        return this.decline(
          "destination-unsupported",
          "That Stellar account does not exist yet, and NEAR Intents cannot be relied on to " +
            "create it. Send to an account that already has some XLM in it, or ask for USDC.",
        );
      }
      return { kind: "ready", slotsNeeded: 0 };
    }

    let lane: DestinationLane;
    try {
      lane = (await inspectDestination(this.rpc, destination, classicAsset(delivery.id))).lane;
    } catch (cause) {
      return this.unreadDestination(cause);
    }
    if (lane.kind === "unusable") return this.decline("destination-unsupported", lane.reason);
    return lane;
  }

  private async accountExists(address: string): Promise<boolean> {
    const accountId = Address.fromString(address).toScAddress().accountId();
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
    const entry = await this.rpc.read(`account ${address}`, async () => {
      const response = await this.rpc.server.getLedgerEntries(key);
      return { value: response.entries[0], ledger: response.latestLedger };
    });
    return entry !== undefined;
  }

  private unreadDestination(cause: unknown): RouteRejection {
    if (cause instanceof MavnaError && cause.retryable) {
      return this.decline(
        "temporarily-unavailable",
        "Stellar did not answer freshly enough to check that address. Nothing is wrong " +
          "with it; try again in a moment.",
      );
    }
    return this.decline(
      "destination-unsupported",
      cause instanceof MavnaError
        ? cause.message
        : "That is not an address that can receive a payment on Stellar.",
    );
  }

  private checkDestination(address: string): RouteRejection | undefined {
    let kind: string;
    try {
      kind = classifyAddress(address).kind;
    } catch {
      return this.decline(
        "destination-unsupported",
        "That is not an address that can receive a payment on Stellar.",
      );
    }
    if (kind === "account") return undefined;
    // Both refused by 1Click itself ("recipient is not valid"), so they are
    // refused here before a quote is asked for.
    if (kind === "contract") {
      return this.decline(
        "destination-unsupported",
        "NEAR Intents only delivers to a Stellar account, not to a contract address.",
      );
    }
    if (kind === "muxed") {
      return this.decline(
        "destination-unsupported",
        "NEAR Intents cannot deliver to an address with a sub-account id in it. Use the " +
          "plain account address instead.",
      );
    }
    return this.decline(
      "destination-unsupported",
      "That is not an address that can receive a payment on Stellar.",
    );
  }

  /**
   * 1Click's refusals, sorted into reasons a user can act on.
   *
   * The messages matched are the ones 1Click was seen returning. Its own text is
   * never shown: the explanation is ours, so nothing a remote service says lands
   * in the interface unread.
   */
  private refusal(cause: unknown, chain: OriginChain): RouteRejection {
    if (!(cause instanceof OneClickRefused)) return this.unavailable(cause);
    const said = cause.upstream.toLowerCase();
    if (said.includes("not available")) {
      return this.decline(
        "temporarily-unavailable",
        `NEAR Intents is not quoting transfers from ${chain.name} into Stellar right now. ` +
          "Nothing has been sent.",
      );
    }
    if (said.includes("no liquidity")) {
      return this.decline(
        "no-liquidity",
        "No NEAR Intents solver is offering this transfer right now. Nothing has been sent.",
      );
    }
    if (said.includes("recipient")) {
      return this.decline(
        "destination-unsupported",
        "NEAR Intents does not accept that Stellar address as a recipient.",
      );
    }
    if (said.includes("too low") || said.includes("too small") || said.includes("minimum")) {
      return this.decline(
        "amount-too-small",
        "That amount is below what NEAR Intents will quote for this route.",
      );
    }
    if (cause.retryable) return this.unavailable(cause);
    return this.decline(
      "errored",
      "NEAR Intents could not quote this transfer. Nothing has been sent.",
    );
  }

  private unavailable(cause: unknown): RouteRejection {
    if (cause instanceof MavnaError && !cause.retryable) {
      return this.decline("errored", cause.message);
    }
    return this.decline(
      "temporarily-unavailable",
      "NEAR Intents did not answer just now. Nothing has been sent; try again in a moment.",
    );
  }

  private decline(reason: RouteRejection["reason"], explanation: string): RouteRejection {
    return { source: this.id, reason, explanation, retryable: rejectionIsRetryable(reason) };
  }
}

/**
 * The slippage a route was quoted at, read back off its own numbers.
 *
 * A route does not carry the tolerance it was asked with, only its price and its
 * floor, so the tolerance is the gap between them, rounded up so the new quote is
 * never asked for a tighter one than the user agreed to. The floor itself is
 * enforced separately, so this cannot loosen what the user was promised.
 *
 * The price is read off the bridge step rather than `receives`, because a swap
 * leg attached after quoting rewrites `receives` into another asset and leaves
 * the bridge step as this rail quoted it.
 */
export function slippageOf(route: Route): number {
  const bridge = route.steps.find((step) => step.kind === "bridge");
  if (bridge === undefined || bridge.to.asset.id !== route.deliveredAtLeast.asset.id) {
    throw new MavnaError(
      "This route has no bridge step in the asset it delivers, so it is not one this rail quoted.",
      { retryable: false },
    );
  }
  const price = BigInt(bridge.to.baseUnits);
  const floor = BigInt(route.deliveredAtLeast.baseUnits);
  if (price <= 0n || floor >= price) return 0;
  const gap = price - floor;
  return Number((gap * 10_000n + price - 1n) / price);
}

/**
 * Fees as 1Click states them, and only those.
 *
 * Both are already out of the quoted amount. The solver's spread is not a fee
 * line: it is in the price, and the price is what the user sees as received.
 */
function feesFrom(reply: QuoteReply, sent: Asset, delivered: Asset): Fee[] {
  const fees: Fee[] = [];
  const platform = (BigInt(reply.quote.amountIn) * BigInt(reply.appFeesBps)) / 10_000n;
  if (platform > 0n) {
    const amount = { asset: sent, baseUnits: platform.toString() };
    fees.push({
      kind: "bridge",
      total: amount,
      recipients: [{ name: "NEAR Intents", amount, address: undefined }],
      includedInQuote: true,
    });
  }
  const withdraw = reply.quote.withdrawFee === undefined ? 0n : BigInt(reply.quote.withdrawFee);
  if (withdraw > 0n) {
    const amount = { asset: delivered, baseUnits: withdraw.toString() };
    fees.push({
      kind: "bridge",
      total: amount,
      recipients: [{ name: "NEAR Intents withdrawal", amount, address: undefined }],
      includedInQuote: true,
    });
  }
  return fees;
}

/** A twenty-byte address nobody holds a key for, made fresh each time. */
function freshEvmAddress(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function classicAsset(id: string): StellarAsset {
  const [code, issuer] = id.split(":");
  if (code === undefined || issuer === undefined) {
    throw new MavnaError(`${id} is not a Stellar asset.`, { retryable: false });
  }
  return new StellarAsset(code, issuer);
}

function readable(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? (units / scale).toString() : `${units / scale}.${fraction}`;
}

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

function xlmAsset(network: NetworkId): Asset {
  return {
    chainId: stellarChainId(network),
    id: "native",
    symbol: "XLM",
    decimals: 7,
    curatedBy: "Stellar",
  };
}

function stellarRef(network: NetworkId): ChainRef {
  const path = network === "mainnet" ? "public" : "testnet";
  return {
    id: stellarChainId(network),
    name: "Stellar",
    explorerTxUrl: (hash) => `https://stellar.expert/explorer/${path}/tx/${hash}`,
  };
}

function chainRefFor(chain: OriginChain): ChainRef {
  return {
    id: chain.chainId,
    name: chain.name,
    explorerTxUrl: (hash) => `${chain.explorer}/tx/${hash}`,
  };
}
