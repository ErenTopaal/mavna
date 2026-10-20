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
import { Address, xdr } from "@stellar/stellar-sdk";
import { tokenSymbolFromIndex } from "./assets.js";
import { type AxelarChain, chainConfig, evmTokenService, loadChains } from "./deployments.js";
import { type AxelarStellarChain, ChainRegistry } from "./discovery.js";
import { type EthCall, EvmReader, fetchEthCall } from "./evm.js";
import { type PricedIn, priceTransfer } from "./fees.js";
import { buildAddGas, GAS_SERVICE_ABI, GmpApi, type GmpRecord, legDelivered } from "./gmp.js";
import { type DeliveredToken, StellarItsReader } from "./stellar-its.js";
import { chainsTrustEachOther, type ItsToken, resolveItsToken, UnsupportedToken } from "./token.js";
import {
  buildApproval,
  buildInterchainTransfer,
  ERC20_ABI,
  INTERCHAIN_TOKEN_SERVICE_ABI,
} from "./transfer.js";

/**
 * Axelar as a rail the routing engine can race.
 *
 * The second rail, and a different trust model from the first: a named validator
 * set attesting rather than an issuer burning and minting. That contrast is the
 * point of having it, and it is why the trust model is carried on every route
 * rather than being something a user has to go and read about.
 *
 * Nothing about Axelar's deployment is a constant here. Not the chain names, not
 * the contract addresses, not the token identifiers. Every one is resolved at
 * runtime, because the addresses this project's specification recorded were dead
 * when they were checked, and the failure mode when they rot is silent.
 */

export interface AxelarAdapterOptions {
  readonly network: NetworkId;
  /** Reads the Stellar side, which is half of every check that matters. */
  readonly rpc: RpcClient;
  /**
   * The network's base reserve, as configured. Nothing here reads it from the
   * ledger: callers pass `NetworkConfig.baseReserveStroops`, which defaults to
   * the 0.5 XLM last confirmed on both networks and is overridable because it
   * is a network parameter and has changed before.
   */
  readonly baseReserveStroops: number;
  /** Prices the arriving asset in XLM, so the sponsorship floor can be compared. */
  readonly prices?: XlmPriceSource;
  /** Where the order book is read from. Defaults per network. */
  readonly horizonUrl?: string;
  /** How EVM reads reach a node. Injectable so tests can hold one still. */
  readonly ethCall?: EthCall;
}

/** What recovery needs that a handle cannot carry on its own. */
export interface RecoverOptions {
  /**
   * Where unspent gas goes back to. Defaults to whoever sent the transfer, which
   * Axelar's own record of it names.
   */
  readonly refundAddress?: string;
}

export class AxelarAdapter implements BridgeAdapter {
  readonly id = "axelar";
  /** A named set of validators attests. Not an issuer, and not a pool. */
  readonly trustModel: TrustModel = "validator-set";

  private readonly network: NetworkId;
  private readonly rpc: RpcClient;
  private readonly baseReserveStroops: number;
  private readonly prices: XlmPriceSource;
  private readonly ethCall: EthCall;
  private readonly gmp: GmpApi;
  private readonly registry: ChainRegistry;

  constructor(options: AxelarAdapterOptions) {
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
    this.ethCall = options.ethCall ?? fetchEthCall;
    this.gmp = new GmpApi(options.network);
    this.registry = new ChainRegistry(options.network);
  }

  /**
   * Chains this rail can send from, asked rather than remembered.
   *
   * Two lists intersected, because either alone is wrong. Axelar's chain registry
   * says what is running, and it keeps retired chains listed with a flag rather
   * than removing them. The deployment configuration says where the token service
   * actually is, and several running chains have none.
   */
  async supportedChains(): Promise<readonly string[]> {
    const [live, deployed] = await Promise.all([
      this.registry.liveChains(),
      loadChains(this.network),
    ]);

    return live.filter((id) => {
      const chain = deployed.get(id);
      return (
        chain !== undefined &&
        chain.family === "evm" &&
        chain.interchainTokenService !== undefined &&
        chain.rpcUrl !== undefined
      );
    });
  }

  async quote(request: QuoteRequest): Promise<Route | RouteRejection> {
    if (request.to.chainId !== stellarChainId(this.network)) {
      return this.decline("chain-unsupported", "This route only delivers to Stellar.");
    }
    if (request.from.chainId === request.to.chainId) {
      return this.decline("chain-unsupported", "This route sends to Stellar, not from it.");
    }

    const sends = BigInt(request.sends.baseUnits);
    if (sends <= 0n) {
      return this.decline("amount-too-small", "There is nothing to send.");
    }

    // Axelar's own encoder accepts an account or a contract and nothing else, so
    // a muxed address is refused here rather than on the far side of a transfer.
    const destination = this.checkDestination(request.destination);
    if (destination !== undefined) return destination;

    let stellar: AxelarStellarChain;
    let source: { chain: AxelarChain; address: string; rpcUrl: string };
    try {
      [stellar, source] = await Promise.all([
        this.registry.stellarChain(),
        evmTokenService(this.network, request.from.chainId),
      ]);
    } catch (cause) {
      return this.declineFrom(cause, "chain-unsupported", `Mavna cannot send from that chain yet.`);
    }

    const evm = new EvmReader(source.rpcUrl, this.ethCall);
    try {
      await confirmGasService(evm, source.address, source.chain);
    } catch (cause) {
      return this.declineFrom(
        cause,
        "chain-unsupported",
        cause instanceof MavnaError ? cause.message : "Mavna cannot send from that chain yet.",
      );
    }
    const stellarIts = await this.stellarReader();

    let token: ItsToken;
    let trusted: boolean;
    try {
      [token, trusted] = await Promise.all([
        resolveItsToken({
          network: this.network,
          sourceChainId: source.chain.id,
          tokenService: source.address,
          tokenAddress: request.from.id,
          evm,
          stellar: stellarIts,
        }),
        chainsTrustEachOther({
          evm,
          stellar: stellarIts,
          tokenService: source.address,
          sourceAxelarId: source.chain.axelarId,
          stellarAxelarId: stellar.id,
        }),
      ]);
    } catch (cause) {
      if (cause instanceof UnsupportedToken) {
        return this.decline("asset-unsupported", cause.message);
      }
      return this.declineFrom(
        cause,
        "temporarily-unavailable",
        // Names the rail rather than the vendor, and says the thing that matters
        // most to someone looking at it: nothing left their wallet.
        "This route did not answer in time. Nothing has been sent, and it is worth trying again.",
      );
    }

    if (!trusted) {
      // One side saying yes is not enough. Drift between them is observed, and a
      // name that passes on the sending chain and is dropped afterwards takes the
      // tokens and the delivery payment with it.
      return this.decline(
        "chain-unsupported",
        "Axelar is not currently carrying transfers between those two chains.",
      );
    }

    // The token the user named must be the token they are quoted on. A route
    // built against a different asset than the one asked for is not a route.
    if (token.sourceToken.toLowerCase() !== request.from.id.toLowerCase()) {
      return this.decline("asset-unsupported", "That is not a token this route can move.");
    }

    // What actually lands, read off the ledger, and the same check on the far
    // side: a route quoted as one Stellar asset and crediting another is not the
    // route that was asked for.
    let delivered: DeliveredToken;
    try {
      delivered = await stellarIts.deliveredAs(token.stellarToken);
    } catch (cause) {
      return this.declineFrom(
        cause,
        "asset-unsupported",
        cause instanceof MavnaError
          ? cause.message
          : "What this token arrives as on Stellar could not be established.",
      );
    }
    if (delivered.id !== request.to.id) {
      return this.decline(
        "asset-unsupported",
        `This route delivers ${request.from.symbol} as ${delivered.id} on Stellar, which is ` +
          `not ${request.to.id}.`,
      );
    }

    let label: { symbol: string; curatedBy: string | undefined };
    try {
      label =
        delivered.kind === "contract"
          ? await this.contractTokenLabel(token.tokenId, token.stellarToken, stellarIts)
          : { symbol: request.to.symbol, curatedBy: request.to.curatedBy };
    } catch (cause) {
      return this.declineFrom(
        cause,
        "asset-unsupported",
        cause instanceof MavnaError
          ? cause.message
          : "What this token is called could not be read.",
      );
    }

    const lane = await this.laneFor(request.destination, delivered);
    if ("source" in lane) return lane;

    let deliveryFee: bigint;
    let feeAsset: Asset;
    let stellarDecimals: number;
    try {
      const [fee, decimals] = await Promise.all([
        priceTransfer(this.network, source.chain.id, stellar.id, gasToken(source.chain)),
        stellarIts.tokenDecimals(token.stellarToken),
      ]);
      deliveryFee = BigInt(fee.baseUnits);
      feeAsset = nativeAsset(source.chain, fee.pricedIn);
      stellarDecimals = decimals;
    } catch (cause) {
      return this.declineFrom(
        cause,
        "temporarily-unavailable",
        "Axelar is not pricing this transfer right now. It is worth trying again shortly.",
      );
    }

    const arriving = scaleAcrossDecimals(sends, token.sourceDecimals, stellarDecimals);
    if (arriving <= 0n) {
      return this.decline(
        "amount-too-small",
        "That amount is too small to survive the change in precision between the two " +
          "chains, and would arrive as nothing.",
      );
    }

    const reserve = quoteReserve({
      lane,
      // The rail delivers the asset that was asked for, checked above, so there
      // is never a second trustline to pay for here.
      destinationAssetDiffers: false,
      baseReserveStroops: this.baseReserveStroops,
    });

    // Only a lane that borrows a reserve has a floor, and only a classic asset
    // can be in one, so the market is asked only then.
    if (reserve.slots > 0 && delivered.kind === "classic") {
      let value: ArrivingValue;
      try {
        value = valueInXlm(
          arriving,
          stellarDecimals,
          await this.prices.xlmStroopsPerUnit(delivered.asset),
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
      bridgeDelivers: delivered.id,
      userWants: request.to.id,
      // A token is arriving, not XLM, so nothing about the account pays for itself.
      arrivingXlmCoversReserve: false,
      // Told upfront, and it depends on the token: only the kinds the service
      // has to pull with an allowance cost a signature of their own.
      sourceNeedsApproval: token.approvalSpender !== undefined,
    });

    const receivesAsset: Asset = {
      chainId: stellarChainId(this.network),
      id: delivered.id,
      symbol: label.symbol,
      decimals: stellarDecimals,
      curatedBy: label.curatedBy,
    };
    const receives: Amount = { asset: receivesAsset, baseUnits: arriving.toString() };

    return {
      id: `axelar-${source.chain.id}-stellar`,
      source: this.id,
      trustModel: this.trustModel,
      fromChain: chainRefFor(source.chain),
      toChain: stellarRef(this.network),
      destination: request.destination,
      sends: request.sends,
      receives,
      // Nothing is swapped and no pool is moved against, so the amount that
      // arrives is the amount that left, rescaled. Promising less would hedge
      // against a risk this rail does not have.
      receivesAtLeast: receives,
      deliveredAtLeast: receives,
      fees: [
        {
          // Charged in the sending chain's own currency and paid alongside the
          // transfer rather than taken out of it, which is why it is a gas fee
          // here and not a bridge fee deducted from the quote.
          kind: "gas",
          total: {
            asset: feeAsset,
            baseUnits: deliveryFee.toString(),
          },
          recipients: [
            {
              name: "Axelar",
              amount: {
                asset: feeAsset,
                baseUnits: deliveryFee.toString(),
              },
              address: source.chain.gasService,
            },
          ],
          includedInQuote: false,
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
      estimatedSeconds: 120,
      steps: steps.map((step: PlannedStep, index: number) => ({
        id: `${step.kind}-${index}`,
        kind: step.kind,
        source: this.id,
        from: request.sends,
        to: receives,
        estimatedSeconds: step.kind === "bridge" ? 120 : 30,
        execution: undefined,
      })),
      signaturesRequired: signatureCount(steps),
      expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
    };
  }

  /**
   * What the destination needs before this token can land in it.
   *
   * A classic asset is the usual question: an account, and a trustline for it.
   * A token the service deployed keeps its own balances and needs no trustline,
   * so only the account matters, and a missing one is declined rather than
   * prepared. The token would be credited to the address anyway, but nothing can
   * move it until the account exists, and the sponsor's preparation is repaid in
   * the asset it curates, which this is not. XLM through its own contract is the
   * same shape: no trustline, and it cannot be sent to an account that is not
   * there.
   */
  private async laneFor(
    destination: string,
    delivered: DeliveredToken,
  ): Promise<DestinationLane | RouteRejection> {
    if (delivered.kind === "classic" && !delivered.asset.isNative()) {
      let lane: DestinationLane;
      try {
        lane = (await inspectDestination(this.rpc, destination, delivered.asset)).lane;
      } catch (cause) {
        return this.unreadDestination(cause);
      }
      if (lane.kind === "unusable") return this.decline("destination-unsupported", lane.reason);
      return lane;
    }

    // Muxed and unusable forms were refused before anything was read, so this
    // is an account or a contract.
    if (classifyAddress(destination).kind === "contract") {
      return { kind: "contract-ready", slotsNeeded: 0 };
    }

    let exists: boolean;
    try {
      exists = await this.accountExists(destination);
    } catch (cause) {
      return this.unreadDestination(cause);
    }
    if (!exists) {
      return this.decline(
        "destination-unsupported",
        "That Stellar account does not exist yet, and this token cannot be used from an " +
          "account that does not exist. Send to an account that already has some XLM in it.",
      );
    }
    return { kind: "ready", slotsNeeded: 0 };
  }

  private async accountExists(address: string): Promise<boolean> {
    const accountId = Address.fromString(address).toScAddress().accountId();
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
    // Through the freshness guard: a lagging node's silence looks exactly like
    // an account that is not there.
    const entry = await this.rpc.read(`account ${address}`, async () => {
      const response = await this.rpc.server.getLedgerEntries(key);
      return { value: response.entries[0], ledger: response.latestLedger };
    });
    return entry !== undefined;
  }

  private unreadDestination(cause: unknown): RouteRejection {
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

  /**
   * Build the transfer, and the approval when the token needs one.
   *
   * Everything is resolved again here rather than carried from the quote. A route
   * is a value a caller can hold on to, and the delivery price moves; building
   * from a stale number is how a transfer is underpaid, which on this rail is not
   * a failed transaction but a stuck one.
   */
  async buildTransactions(route: Route): Promise<readonly UnsignedTransaction[]> {
    if (route.source !== this.id) {
      throw new MavnaError(
        `Refusing to build a route quoted by another rail (${route.source}) as an Axelar ` +
          "transfer. The numbers shown were that rail's, not these.",
        { retryable: false },
      );
    }

    const [stellar, source] = await Promise.all([
      this.registry.stellarChain(),
      evmTokenService(this.network, route.fromChain.id),
    ]);

    const evm = new EvmReader(source.rpcUrl, this.ethCall);
    await confirmGasService(evm, source.address, source.chain);
    const stellarIts = await this.stellarReader();

    const token = await resolveItsToken({
      network: this.network,
      sourceChainId: source.chain.id,
      tokenService: source.address,
      tokenAddress: route.sends.asset.id,
      evm,
      stellar: stellarIts,
    });

    if (
      !(await chainsTrustEachOther({
        evm,
        stellar: stellarIts,
        tokenService: source.address,
        sourceAxelarId: source.chain.axelarId,
        stellarAxelarId: stellar.id,
      }))
    ) {
      throw new MavnaError(
        "Axelar is not currently carrying transfers between those two chains. " +
          "Refusing to build one, because the message would be sent and dropped.",
        { retryable: true },
      );
    }

    // What lands is read again too. A token re-registered since the quote would
    // credit a different Stellar asset than the one the user was shown.
    const delivered = await stellarIts.deliveredAs(token.stellarToken);
    if (delivered.id !== route.receives.asset.id) {
      throw new MavnaError(
        `This transfer would now arrive as ${delivered.id}, not the ${route.receives.asset.id} ` +
          "it was quoted as. Refusing to build it; quote again.",
        { retryable: false },
      );
    }

    // Priced now, not at quote time, and asserted positive on the way through.
    // Zero here would be accepted by the contract and the message emitted anyway.
    const gasValue = BigInt(
      (await priceTransfer(this.network, source.chain.id, stellar.id, gasToken(source.chain)))
        .baseUnits,
    );

    const amount = BigInt(route.sends.baseUnits);
    const transfer = buildInterchainTransfer({
      tokenService: source.address,
      tokenId: token.tokenId,
      // The contract-facing name. It matches the API name for Stellar, but the
      // two are read from different fields on purpose so this stays right if
      // Stellar ever picks up a capitalised form the way Ethereum has.
      destinationChain: (await chainConfig(this.network, stellar.id)).axelarId,
      destination: route.destination,
      amount,
      gasValue,
      symbol: route.sends.asset.symbol,
      decimals: token.sourceDecimals,
    });

    const transactions: UnsignedTransaction[] = [];

    if (token.approvalSpender !== undefined) {
      const approval = buildApproval({
        token: token.sourceToken,
        spender: token.approvalSpender,
        amount,
        symbol: route.sends.asset.symbol,
        decimals: token.sourceDecimals,
      });
      transactions.push({
        chainId: source.chain.id,
        payload: JSON.stringify({
          to: approval.contract,
          abi: ERC20_ABI,
          functionName: approval.functionName,
          args: approval.args.map(asJson),
        }),
        format: "evm-tx",
        describes: approval.describes,
        ephemeralSigners: [],
        // A wallet that has approved this much already should not be asked again.
        unnecessaryWhen: {
          kind: "erc20-allowance",
          token: approval.contract,
          spender: token.approvalSpender,
          atLeastBaseUnits: amount.toString(),
        },
      });
    }

    transactions.push({
      chainId: source.chain.id,
      payload: JSON.stringify({
        to: transfer.contract,
        abi: INTERCHAIN_TOKEN_SERVICE_ABI,
        functionName: transfer.functionName,
        args: transfer.args.map(asJson),
        // Carried beside the call because it IS the delivery payment. A wallet
        // that sends this call without it emits the message and pays nothing to
        // have it delivered, which strands the transfer with no automatic way
        // back. There is no shape of this payload that omits it.
        value: transfer.value.toString(),
      }),
      format: "evm-tx",
      describes: transfer.describes,
      ephemeralSigners: [],
      unnecessaryWhen: undefined,
    });

    return transactions;
  }

  /**
   * Where a transfer stands, counting BOTH legs.
   *
   * A transfer through Axelar is two messages, because it routes through a hub.
   * The first reaching "executed" means it got to the hub, not to Stellar, and
   * reporting that as delivered would tell someone their money has arrived while
   * it is still moving. So the first leg is found by the hash the user has, and
   * the second is found from the first.
   */
  async status(handle: TransferHandle): Promise<StepPhase> {
    if (handle.sourceTxHash === undefined) return { phase: "idle" };

    const records = await this.gmp.byTransaction(handle.sourceTxHash);
    // The hash belongs to the sending chain, so the leg starting there is the
    // one to read. Searching a hash can return the hub's side of it too.
    const first =
      records.find(
        (row) => row.transactionHash?.toLowerCase() === handle.sourceTxHash?.toLowerCase(),
      ) ?? records[0];

    if (first === undefined) {
      // Not indexed yet. There is no evidence of failure, and reporting failure
      // without evidence is how somebody is talked into paying twice.
      return {
        phase: "pending",
        ref: this.refFor(handle.sourceChainId, handle.sourceTxHash),
        expectedByUnix: 0,
      };
    }

    const ref = this.refFor(first.sourceChain ?? handle.sourceChainId, handle.sourceTxHash);

    // Deliberately NOT branching on Axelar's `refunded`. That flag is about the
    // leftover delivery payment going home, which happens on transfers that
    // delivered perfectly, so reading it as a returned transfer reports a
    // successful one as sent back. There is no field here that means the tokens
    // came home, so this adapter never claims they did.
    if (first.underpaid) {
      return {
        phase: "stalled",
        ref,
        overdueSeconds: 0,
        remedy: {
          kind: "add-gas",
          chainId: first.sourceChain ?? handle.sourceChainId ?? "unknown",
          because:
            "The transfer was sent without enough to pay for delivering it. Your funds " +
            "are still in it, and paying the rest releases them.",
        },
      };
    }

    if (first.errored) {
      return {
        phase: "failed",
        cause: "Axelar could not deliver this transfer.",
        remedy: {
          kind: "retry",
          because: "The transfer did not complete. Nothing further happens on its own.",
        },
        ref,
      };
    }

    if (!legDelivered(first)) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    // The hub has the message. Whether Stellar has it is a separate question and
    // a separate record, which only exists once the hub has created it.
    if (first.callbackId === undefined) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    const second = (await this.gmp.byMessageId(first.callbackId))[0];
    if (second === undefined) return { phase: "pending", ref, expectedByUnix: 0 };

    // The hub-to-Stellar leg fails in the same two ways the first can, and
    // waiting on it would leave someone watching "still moving" until the
    // widget gives up, never offered the top-up that would release it.
    if (second.underpaid) {
      return {
        phase: "stalled",
        ref,
        overdueSeconds: 0,
        remedy: {
          kind: "add-gas",
          // gas for both legs is paid on the sending chain, so that is where
          // a top-up goes too
          chainId: first.sourceChain ?? handle.sourceChainId ?? "unknown",
          because:
            "The transfer reached Axelar but was not paid enough to be delivered to " +
            "Stellar. Your funds are still in it, and paying the rest releases them.",
        },
      };
    }

    if (second.errored) {
      return {
        phase: "failed",
        cause: "Axelar could not deliver this transfer to Stellar.",
        remedy: {
          kind: "retry",
          because: "The transfer did not complete. Nothing further happens on its own.",
        },
        ref,
      };
    }

    if (!legDelivered(second)) return { phase: "pending", ref, expectedByUnix: 0 };

    return { phase: "done", ref, received: await this.receivedFrom(second) };
  }

  /**
   * Pay again for a transfer that was not paid enough to be delivered.
   *
   * This is the weakest documented path on this rail and the one the plan says to
   * budget real effort for. Axelar's own SDK cannot walk it here at all: it
   * refuses on a chain missing from its bundled configuration, which Stellar is,
   * and it gates the whole thing on a response field the API no longer returns,
   * so it declines every underpaid transfer as already paid.
   *
   * So it is built from the gas service interface directly, off the message
   * Axelar's search does return.
   */
  async recover(
    handle: TransferHandle,
    options: RecoverOptions = {},
  ): Promise<readonly UnsignedTransaction[]> {
    if (handle.sourceTxHash === undefined) {
      throw new MavnaError("Recovering a transfer needs the transaction that started it.", {
        retryable: false,
      });
    }

    const records = await this.gmp.byTransaction(handle.sourceTxHash);
    const first =
      records.find(
        (row) => row.transactionHash?.toLowerCase() === handle.sourceTxHash?.toLowerCase(),
      ) ?? records[0];

    if (first === undefined) {
      throw new MavnaError(
        "Axelar has no record of that transaction yet. It may not be indexed; there is " +
          "nothing to add gas to until it is.",
        { retryable: true },
      );
    }
    // Either leg can be the underpaid one. The top-up is paid on the sending
    // chain against the first leg's event in both cases, which is what Axelar's
    // own recovery does: "add gas at source chain".
    const underpaid =
      first.underpaid ||
      (first.callbackId !== undefined &&
        (await this.gmp.byMessageId(first.callbackId))[0]?.underpaid === true);
    if (!underpaid) {
      throw new MavnaError(
        "That transfer was not underpaid, so adding gas would not move it along. " +
          "Refusing to charge for a signature that changes nothing.",
        { retryable: false },
      );
    }
    if (first.logIndex === undefined) {
      throw new MavnaError(
        "Axelar's record of that transfer carries no log index. The gas service does " +
          "not check the one it is given and does not refund a wrong one, so there is " +
          "no safe value to guess here.",
        { retryable: true },
      );
    }

    const chainId = first.sourceChain ?? handle.sourceChainId;
    if (chainId === undefined) {
      throw new MavnaError("Cannot tell which chain that transfer was sent from.", {
        retryable: false,
      });
    }

    const chain = await chainConfig(this.network, chainId);
    if (chain.gasService === undefined) {
      throw new MavnaError(`Axelar has no gas service deployed on ${chain.name}.`, {
        retryable: false,
      });
    }

    const refundAddress = options.refundAddress ?? first.sourceAddress;
    if (refundAddress === undefined) {
      throw new MavnaError(
        "Adding gas needs an address for the unspent remainder to go back to, and " +
          "Axelar's record does not name the sender. Pass one.",
        { retryable: false },
      );
    }

    const stellar = await this.registry.stellarChain();
    // The current full price rather than a shortfall. Axelar publishes no
    // shortfall, and what it does publish about the original payment are
    // floating-point display figures. Doing arithmetic on those to decide a
    // payment is the one thing this codebase never does with money. Paying the
    // full price cannot underpay, and the gas service returns what is not spent.
    const amount = BigInt(
      (
        await priceTransfer(
          this.network,
          chainId,
          first.finalDestinationChain ?? stellar.id,
          gasToken(chain),
        )
      ).baseUnits,
    );

    const call = buildAddGas({
      gasService: chain.gasService,
      txHash: handle.sourceTxHash,
      logIndex: first.logIndex,
      refundAddress,
      amount,
    });

    return [
      {
        chainId,
        payload: JSON.stringify({
          to: call.contract,
          abi: GAS_SERVICE_ABI,
          functionName: call.functionName,
          args: call.args.map(asJson),
          value: call.value.toString(),
        }),
        format: "evm-tx",
        describes: call.describes,
        ephemeralSigners: [],
        unnecessaryWhen: undefined,
      },
    ];
  }

  private async stellarReader(): Promise<StellarItsReader> {
    const stellar = await this.registry.stellarChain();
    const chain = await chainConfig(this.network, stellar.id);
    if (chain.interchainTokenService === undefined) {
      throw new MavnaError(
        "Axelar publishes no token service address for Stellar, so the receiving side " +
          "cannot be checked before quoting.",
        { retryable: false },
      );
    }
    return new StellarItsReader(this.rpc, chain.interchainTokenService, this.network);
  }

  private checkDestination(address: string): RouteRejection | undefined {
    let kind: string;
    try {
      kind = classifyAddress(address).kind;
    } catch {
      // Our own wording rather than the raw error, so nothing about the address
      // somebody pasted is echoed back into an interface.
      return this.decline(
        "destination-unsupported",
        "That is not an address that can receive a payment on Stellar.",
      );
    }

    if (kind === "account" || kind === "contract") return undefined;

    if (kind === "muxed") {
      // Axelar's own encoder validates the destination as an account or a
      // contract and rejects everything else, so this is refused before it is
      // sent rather than after.
      return this.decline(
        "destination-unsupported",
        "This route cannot deliver to an address with a sub-account id in it. Use the " +
          "plain account address instead.",
      );
    }

    return this.decline(
      "destination-unsupported",
      "That is not an address that can receive a payment on Stellar.",
    );
  }

  /**
   * What landed, from the leg that landed it, named as the Stellar asset it is.
   *
   * The first leg's record is the sending side: its amount can be in the source
   * chain's precision and its token is Axelar's id rather than anything a
   * Stellar wallet shows. So the asset is resolved on the ledger the same way a
   * quote resolves it, and a record missing what is needed is refused rather
   * than filled in.
   */
  private async receivedFrom(second: GmpRecord): Promise<Amount> {
    const { tokenId, amount } = second;
    if (tokenId === undefined || amount === undefined || !/^\d+$/.test(amount)) {
      throw new MavnaError(
        "Axelar reports this transfer delivered but its record does not say how much " +
          "arrived, so no amount is shown rather than a guessed one.",
        { retryable: true },
      );
    }

    const stellarIts = await this.stellarReader();
    const token = await stellarIts.registeredTokenAddress(tokenId);
    if (token === undefined) {
      throw new MavnaError(
        "Axelar reports this transfer delivered, but Stellar's token service has no " +
          "token under its id, so what arrived cannot be named.",
        { retryable: false },
      );
    }
    const [delivered, decimals] = await Promise.all([
      stellarIts.deliveredAs(token),
      stellarIts.tokenDecimals(token),
    ]);

    // Axelar's record states the precision it counted in. If that is not the
    // token's own on Stellar, the amount is in some other unit.
    if (second.decimals !== undefined && second.decimals !== decimals) {
      throw new MavnaError(
        `Axelar states the delivered amount in ${second.decimals} decimals, and the token ` +
          `on Stellar has ${decimals}. Refusing to show an amount in the wrong unit.`,
        { retryable: false },
      );
    }

    const label =
      delivered.kind === "classic"
        ? {
            symbol: delivered.asset.isNative() ? "XLM" : delivered.asset.getCode(),
            curatedBy: undefined,
          }
        : await this.contractTokenLabel(tokenId, token, stellarIts);

    return {
      asset: {
        chainId: stellarChainId(this.network),
        id: delivered.id,
        symbol: label.symbol,
        decimals,
        curatedBy: label.curatedBy,
      },
      baseUnits: amount,
    };
  }

  /**
   * What to call a token Axelar deployed on Stellar.
   *
   * Not what the caller called it, and not the contract's own symbol() when
   * Axelar's list names it: Ethereum's USDC arrives on mainnet as a Soroban
   * contract whose symbol() answers "USDC", which is not Circle's USDC and must
   * not read as it. Axelar's list calls that token USDC.axl. A token the list
   * does not carry is named by its contract, unless that contract claims to be
   * USDC, which is declined rather than shown.
   */
  private async contractTokenLabel(
    tokenId: string,
    token: string,
    stellarIts: StellarItsReader,
  ): Promise<{ symbol: string; curatedBy: string }> {
    const listed = await tokenSymbolFromIndex(this.network, tokenId);
    if (listed !== undefined) return { symbol: listed, curatedBy: "Axelar" };

    const own = await stellarIts.tokenSymbol(token);
    if (own.toUpperCase() === "USDC") {
      throw new MavnaError(
        `The Stellar contract ${token} calls itself USDC and is not Circle's USDC, and ` +
          "Axelar's token list does not name it. Refusing to quote it under that name.",
        { retryable: false },
      );
    }
    return { symbol: own, curatedBy: "Axelar" };
  }

  private refFor(chainId: string | undefined, txHash: string) {
    return {
      chainId: chainId ?? "unknown",
      txHash,
      explorerUrl: gmpExplorerUrl(this.network, txHash),
    };
  }

  private decline(reason: RouteRejection["reason"], explanation: string): RouteRejection {
    return { source: this.id, reason, explanation, retryable: rejectionIsRetryable(reason) };
  }

  /** A rejection that keeps a retryable failure distinct from a permanent no. */
  private declineFrom(
    cause: unknown,
    reason: RouteRejection["reason"],
    explanation: string,
  ): RouteRejection {
    if (cause instanceof MavnaError && cause.retryable) {
      return this.decline(
        "temporarily-unavailable",
        "Axelar did not answer just now. Nothing is wrong with what you asked for; " +
          "try again in a moment.",
      );
    }
    return this.decline(reason, explanation);
  }
}

/**
 * The same amount, in the destination's precision.
 *
 * The hub rescales by `10^(destination decimals - source decimals)`, which is
 * written out in exactly that form in Axelar's own ARC-17. A negative exponent is
 * a division and it truncates: whatever falls below the destination's smallest
 * unit is destroyed, not held or refunded. That is a normal case rather than an
 * edge one, because a custom token may be registered with different precision on
 * each chain, and on mainnet solvBTC is eighteen on Ethereum and eight on
 * Stellar. A quote that ignored it would overstate what arrives by up to ten
 * decimal places of the amount.
 *
 * Tokens the service itself deployed are required to have the same decimals
 * everywhere, so for those this changes nothing.
 */
export function scaleAcrossDecimals(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  if (to > from) return amount * 10n ** BigInt(to - from);
  return amount / 10n ** BigInt(from - to);
}

/**
 * The token service names its gas service itself, and that must be the one
 * confirmed for this chain. Asked at quote and again at build, because the
 * value sent with a transfer pays whichever contract this is.
 */
async function confirmGasService(
  evm: EvmReader,
  tokenService: string,
  chain: AxelarChain,
): Promise<void> {
  const named = await evm.gasService(tokenService);
  if (chain.gasService === undefined || named.toLowerCase() !== chain.gasService.toLowerCase()) {
    throw new MavnaError(
      `The token service on ${chain.name} pays a different gas service than the one ` +
        "confirmed for it. Nothing will be sent through it.",
      { retryable: false },
    );
  }
}

function asJson(value: string | bigint): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function stellarChainId(network: NetworkId): string {
  return network === "mainnet" ? "stellar" : "stellar-testnet";
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

function chainRefFor(chain: AxelarChain): ChainRef {
  return {
    id: chain.id,
    name: chain.name,
    explorerTxUrl: (hash) =>
      chain.explorerUrl === undefined ? "" : `${chain.explorerUrl}/tx/${hash}`,
  };
}

/**
 * The token Axelar is asked to price delivery in.
 *
 * Its estimators answer in the smallest unit of whatever symbol they are given,
 * and the answer is paid as the native value of a transaction on this chain, so
 * it has to be this chain's own token. A chain whose configuration does not name
 * one is refused rather than priced in a guess.
 */
function gasToken(chain: AxelarChain): string {
  const symbol = chain.nativeCurrency?.symbol;
  if (symbol === undefined || symbol.length === 0) {
    throw new MavnaError(
      `Axelar's configuration names no native token for ${chain.name}, so delivery ` +
        "there cannot be priced in the currency that pays for it.",
      { retryable: false },
    );
  }
  return symbol;
}

/** The sending chain's own token, in the unit Axelar priced the fee in. */
function nativeAsset(chain: AxelarChain, pricedIn: PricedIn): Asset {
  return {
    chainId: chain.id,
    id: "native",
    symbol: pricedIn.symbol,
    decimals: pricedIn.decimals,
    curatedBy: undefined,
  };
}

/**
 * Axelar's own explorer, not the sending chain's.
 *
 * A transfer here is two messages across three chains, and a link to the sending
 * chain's explorer shows a user one third of it. Axelar's view is the only one
 * that shows the whole journey.
 */
function gmpExplorerUrl(network: NetworkId, txHash: string): string {
  const host = network === "mainnet" ? "axelarscan.io" : "testnet.axelarscan.io";
  return `https://${host}/gmp/${txHash}`;
}
