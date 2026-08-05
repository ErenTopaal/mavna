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
import { classifyAddress, type RpcClient } from "@mavna/stellar";
import { type AxelarChain, chainConfig, evmTokenService, loadChains } from "./deployments.js";
import { type AxelarStellarChain, discoverLiveChains, discoverStellarChain } from "./discovery.js";
import { type EthCall, EvmReader, fetchEthCall } from "./evm.js";
import { priceTransfer } from "./fees.js";
import { buildAddGas, GAS_SERVICE_ABI, GmpApi, type GmpRecord, legDelivered } from "./gmp.js";
import { StellarItsReader } from "./stellar-its.js";
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
  private readonly ethCall: EthCall;
  private readonly gmp: GmpApi;

  constructor(options: AxelarAdapterOptions) {
    this.network = options.network;
    this.rpc = options.rpc;
    this.ethCall = options.ethCall ?? fetchEthCall;
    this.gmp = new GmpApi(options.network);
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
      discoverLiveChains(this.network),
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
        discoverStellarChain(this.network),
        evmTokenService(this.network, request.from.chainId),
      ]);
    } catch (cause) {
      return this.declineFrom(cause, "chain-unsupported", `Mavna cannot send from that chain yet.`);
    }

    const evm = new EvmReader(source.rpcUrl, this.ethCall);
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

    let deliveryFee: bigint;
    let stellarDecimals: number;
    try {
      const [fee, decimals] = await Promise.all([
        priceTransfer(this.network, source.chain.id, stellar.id),
        stellarIts.tokenDecimals(token.stellarToken),
      ]);
      deliveryFee = BigInt(fee);
      stellarDecimals = decimals;
    } catch (cause) {
      return this.declineFrom(
        cause,
        "temporarily-unavailable",
        "Axelar is not pricing this transfer right now. It is worth trying again shortly.",
      );
    }

    const delivered = scaleAcrossDecimals(sends, token.sourceDecimals, stellarDecimals);
    if (delivered <= 0n) {
      return this.decline(
        "amount-too-small",
        "That amount is too small to survive the change in precision between the two " +
          "chains, and would arrive as nothing.",
      );
    }

    const receivesAsset: Asset = {
      ...request.to,
      decimals: stellarDecimals,
    };
    const receives: Amount = { asset: receivesAsset, baseUnits: delivered.toString() };

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
      fees: [
        {
          // Charged in the sending chain's own currency and paid alongside the
          // transfer rather than taken out of it, which is why it is a gas fee
          // here and not a bridge fee deducted from the quote.
          kind: "gas",
          total: {
            asset: nativeAsset(source.chain),
            baseUnits: deliveryFee.toString(),
          },
          recipients: [
            {
              name: "Axelar",
              amount: {
                asset: nativeAsset(source.chain),
                baseUnits: deliveryFee.toString(),
              },
              address: source.chain.gasService,
            },
          ],
          includedInQuote: false,
        },
      ],
      estimatedSeconds: 120,
      steps: [
        ...(token.approvalSpender === undefined
          ? []
          : [
              {
                id: "approve-source-0",
                kind: "approve-source" as const,
                source: this.id,
                from: request.sends,
                to: request.sends,
                estimatedSeconds: 30,
                execution: undefined,
              },
            ]),
        {
          id: "bridge-0",
          kind: "bridge" as const,
          source: this.id,
          from: request.sends,
          to: receives,
          estimatedSeconds: 120,
          execution: undefined,
        },
      ],
      // Told upfront, and it depends on the token: only the kinds the service
      // has to pull with an allowance cost a second signature.
      signaturesRequired: token.approvalSpender === undefined ? 1 : 2,
      expiresAtUnix: Math.floor(Date.now() / 1000) + 120,
    };
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
    const [stellar, source] = await Promise.all([
      discoverStellarChain(this.network),
      evmTokenService(this.network, route.fromChain.id),
    ]);

    const evm = new EvmReader(source.rpcUrl, this.ethCall);
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

    // Priced now, not at quote time, and asserted positive on the way through.
    // Zero here would be accepted by the contract and the message emitted anyway.
    const gasValue = BigInt(await priceTransfer(this.network, source.chain.id, stellar.id));

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
    if (second === undefined || !legDelivered(second)) {
      return { phase: "pending", ref, expectedByUnix: 0 };
    }

    return { phase: "done", ref, received: this.amountFrom(first) };
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
    if (!first.underpaid) {
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

    const stellar = await discoverStellarChain(this.network);
    // The current full price rather than a shortfall. Axelar publishes no
    // shortfall, and what it does publish about the original payment are
    // floating-point display figures. Doing arithmetic on those to decide a
    // payment is the one thing this codebase never does with money. Paying the
    // full price cannot underpay, and the gas service returns what is not spent.
    const amount = BigInt(
      await priceTransfer(this.network, chainId, first.finalDestinationChain ?? stellar.id),
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
    const stellar = await discoverStellarChain(this.network);
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

  private amountFrom(record: GmpRecord): Amount {
    const decimals = record.decimals ?? 7;
    return {
      asset: {
        chainId: stellarChainId(this.network),
        id: record.tokenId ?? "unknown",
        symbol: record.symbol ?? "",
        decimals,
        curatedBy: "Axelar",
      },
      baseUnits: record.amount ?? "0",
    };
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

function asJson(value: string | bigint): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function stellarChainId(network: NetworkId): string {
  return network === "mainnet" ? "stellar" : "stellar-testnet";
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

function nativeAsset(chain: AxelarChain): Asset {
  return {
    chainId: chain.id,
    id: "native",
    symbol: chain.nativeCurrency?.symbol ?? "",
    decimals: chain.nativeCurrency?.decimals ?? 18,
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
