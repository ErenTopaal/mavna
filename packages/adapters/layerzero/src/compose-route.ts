import type {
  Amount,
  Asset,
  ComposeArrival,
  ComposeHop,
  ComposeQuoteRequest,
  Fee,
  NetworkId,
  OnChainRef,
  Route,
  RouteRejection,
  StepPhase,
} from "@mavna/core";
import { amountOf, MavnaError } from "@mavna/core";
import { inspectDestination, type RpcClient } from "@mavna/stellar";
import { Asset as StellarAsset, StrKey } from "@stellar/stellar-sdk";
import {
  type ArrivalConfig,
  arrivalAccepts,
  arrivalConverts,
  COMPOSE_RECEIVED,
  composeExtraOptions,
  composeMessageHash,
  decodeOftComposePayload,
  encodeArrivalMessage,
  encodeOftComposeMsg,
  estimateFinishRent,
  findArrivalEvent,
  readArrivalConfig,
  readComposeQueue,
  readTokenName,
} from "./compose.js";
import { STELLAR_DECIMALS, STELLAR_SIDE, stellarExplorerTxUrl } from "./config.js";
import type { Discovery, ResolvedRoute } from "./discovery.js";
import {
  badSlippage,
  buildSendParam,
  bytes32ToStellarContract,
  MSG_TYPE_SEND_AND_CALL,
  minAmountFor,
  sharedToStellar,
} from "./oft.js";
import type { ScanMessage } from "./scan.js";

/**
 * Compose routes on LayerZero: the plain send, delivered to the Mavna Arrival
 * Contract with instructions to convert on arrival.
 *
 * Kept out of adapter.ts so the plain route reads as it did. Everything here is
 * refused rather than guessed at, because a compose that cannot complete leaves
 * the funds with the contract until someone finishes it.
 */

/** A venue that can price a conversion as hops a contract can run itself. */
/**
 * A finish's own cost beyond any storage renewal, in stroops: the 0.01 XLM
 * inclusion bid plus the measured resource fee of a run that renews nothing
 * (18,440 to 31,353 stroops on testnet), with room to spare.
 */
export const COMPOSE_FINISH_BASE_STROOPS = 150_000n;

export interface PathVenue {
  readonly id: string;
  quotePath(request: {
    readonly assetIn: string;
    readonly assetOut: string;
    readonly amountIn: string;
    readonly maxSlippageBps: number;
    /** The only tokens a path may pass through: the contract's own list. */
    readonly via?: readonly string[];
  }): Promise<{
    readonly provider: string;
    readonly amountOut: string;
    readonly amountOutMinimum: string;
    readonly path: readonly ComposeHop[];
  }>;
}

/** Where compose routes go on this network, and what prices them. */
export interface ArrivalSetup {
  /** The Mavna Arrival Contract. Its allowlist is read before anything is built. */
  readonly contract: string;
  /** Must be the venue whose router the contract was built with: Aquarius. */
  readonly venue: PathVenue;
  /**
   * Gas for `lzCompose`, for an OFT that does not enforce it for SEND_AND_CALL.
   * No default for the same reason `lzReceiveGas` has none.
   */
  readonly lzComposeGas?: bigint;
}

export interface ComposeContext {
  readonly network: NetworkId;
  readonly rpc: RpcClient;
  readonly passphrase: string;
  readonly discovery: Discovery;
  readonly arrival: ArrivalSetup;
  readonly lzReceiveGas: bigint | undefined;
  readonly decline: (reason: RouteRejection["reason"], explanation: string) => RouteRejection;
}

const BPS = 10_000n;

const SELF_PAYMENT =
  "A conversion on arrival cannot pay the Arrival Contract itself, as the recipient or as " +
  "the fee account: it would hold the funds with no way to send them on.";
/**
 * The most a compose route gives up to slippage. Anyone may complete the
 * conversion, including someone who moves the pool first in the same
 * transaction, so whatever lies between the quote and the minimum can be taken.
 * Kept tight, and the minimum is what the route tells the user to expect.
 */
export const COMPOSE_MAX_SLIPPAGE_BPS = 20;
// the contract's own work on Stellar after the delivery: estimates and a swap in
// one ledger, plus the executor noticing the queued step
const COMPOSE_SECONDS = 30;

function stellarAssetOf(asset: Asset): StellarAsset | undefined {
  if (asset.id === "native") return StellarAsset.native();
  const [code, issuer] = asset.id.split(":");
  if (code === undefined || issuer === undefined || issuer === "") return undefined;
  try {
    return new StellarAsset(code, issuer);
  } catch {
    return undefined;
  }
}

/**
 * Why `destination` cannot take `asset` from a contract right now, or undefined.
 * With an amount, a trustline whose limit leaves less room than that counts as
 * unable: the contract would deliver as it came, or keep the compose queued.
 */
async function cannotHold(
  rpc: RpcClient,
  destination: string,
  asset: Asset,
  role: "wanted" | "arriving",
  amountStroops?: bigint,
): Promise<string | undefined> {
  const stellar = stellarAssetOf(asset);
  if (stellar === undefined) {
    return `${asset.symbol} is not a Stellar asset this route can check an account for.`;
  }
  const newAccount =
    "That Stellar account does not exist yet, and a contract cannot create one, so it cannot " +
    "receive a conversion on arrival. The plain route sets the account up.";
  // one check for every case: it reads an account for XLM and a contract's
  // instance for a C address, so nothing is assumed to exist
  const state = await inspectDestination(
    rpc,
    destination,
    stellar,
    amountStroops === undefined ? {} : { amountStroops },
  );
  switch (state.lane.kind) {
    case "contract-ready":
      return undefined;
    case "unusable":
      return state.lane.reason;
    case "needs-account":
      return newAccount;
    case "needs-trustline":
      return role === "wanted"
        ? `That account cannot hold ${asset.symbol} yet, so a conversion on arrival has nowhere ` +
            `to land. Add a ${asset.symbol} trustline, or take the plain route.`
        : `That account cannot hold ${asset.symbol}, which it is sent as it came if the ` +
            `conversion cannot meet your minimum. Add a ${asset.symbol} trustline, or take the ` +
            "plain route.";
    case "ready":
      return undefined;
  }
}

/** The extra options a compose send buys, or a reason it cannot be paid for. */
export async function composeOptionsFor(
  ctx: ComposeContext,
  route: ResolvedRoute,
): Promise<`0x${string}`> {
  const enforced = await ctx.discovery.enforcedOptionsFor(route, MSG_TYPE_SEND_AND_CALL);
  const options = composeExtraOptions(enforced, {
    lzReceive: ctx.lzReceiveGas,
    lzCompose: ctx.arrival.lzComposeGas,
  });
  if (options === undefined) {
    throw new MavnaError(
      `${route.tokenSymbol}'s contract does not pay for the conversion step on Stellar, so a ` +
        "conversion on arrival cannot be priced. Pass `lzComposeGas` with a figure measured " +
        "for the Arrival Contract.",
      { retryable: false },
    );
  }
  return options;
}

/** Refuse a contract that is not the configured one, or that does not take this token. */
export async function assertArrivalServes(
  ctx: ComposeContext,
  contract: string,
  route: ResolvedRoute,
): Promise<ArrivalConfig> {
  if (contract !== ctx.arrival.contract) {
    throw new MavnaError(
      `${contract} is not the Arrival Contract this app sends to, so nothing will be built for it.`,
      { retryable: false },
    );
  }
  const config = await readArrivalConfig(ctx.rpc, contract);
  if (
    !arrivalAccepts(config, {
      oft: route.stellarOft,
      token: route.stellar.token,
      endpoint: route.stellar.endpoint,
    })
  ) {
    throw new MavnaError(
      `The Arrival Contract does not accept ${route.tokenSymbol} from this route, so a ` +
        "conversion on arrival would never run.",
      { retryable: false },
    );
  }
  return config;
}

export async function quoteComposeRoute(
  ctx: ComposeContext,
  request: ComposeQuoteRequest,
): Promise<Route | RouteRejection | undefined> {
  const { plain, arriving } = request;
  const wanted = request.to;
  if (wanted.id === arriving.id) return undefined;

  const slippage = badSlippage(request.maxSlippageBps);
  if (slippage !== undefined) {
    // the caller's input, so asking again will not help
    return { ...ctx.decline("errored", slippage), retryable: false };
  }

  const destination = request.destination;
  if (!/^[GC]/.test(destination)) {
    return ctx.decline(
      "destination-unsupported",
      "A conversion on arrival is sent to a 32-byte recipient, and a muxed address does not " +
        "fit in one. Use the account it wraps, or take the plain route.",
    );
  }

  // funds the contract pays to itself stay in it with no one able to take them out
  if (destination === ctx.arrival.contract) {
    return ctx.decline("destination-unsupported", SELF_PAYMENT);
  }

  let resolved: ResolvedRoute;
  try {
    resolved = await ctx.discovery.routeFrom(request.from.chainId);
  } catch (cause) {
    return ctx.decline(
      cause instanceof MavnaError && cause.retryable
        ? "temporarily-unavailable"
        : "asset-unsupported",
      cause instanceof MavnaError ? cause.message : "LayerZero could not be read for this chain.",
    );
  }
  if (request.arrivingContract !== resolved.stellar.token) {
    return ctx.decline(
      "asset-unsupported",
      `This route delivers the token at ${resolved.stellar.token} on Stellar, not ${arriving.symbol}.`,
    );
  }

  let options: `0x${string}`;
  let config: ArrivalConfig;
  try {
    config = await assertArrivalServes(ctx, ctx.arrival.contract, resolved);
    options = await composeOptionsFor(ctx, resolved);
  } catch (cause) {
    return ctx.decline(
      cause instanceof MavnaError && cause.retryable
        ? "temporarily-unavailable"
        : "asset-unsupported",
      cause instanceof MavnaError ? cause.message : "The Arrival Contract could not be read.",
    );
  }

  if (!config.wanted.includes(request.wantedContract)) {
    return ctx.decline(
      "asset-unsupported",
      `The Arrival Contract on this network does not convert into ${wanted.symbol}. The plain ` +
        "route still delivers what arrives.",
    );
  }

  const fee = request.integratorFee;
  if (fee !== undefined && (!Number.isInteger(fee.bps) || fee.bps < 0 || fee.bps > 1_000)) {
    throw new RangeError(`An integrator fee must be 0 to 1000 basis points, got ${fee.bps}.`);
  }
  if (
    fee !== undefined &&
    fee.bps > 0 &&
    !(StrKey.isValidEd25519PublicKey(fee.recipient) || StrKey.isValidContract(fee.recipient))
  ) {
    return ctx.decline(
      "destination-unsupported",
      "The integrator's fee account is not a Stellar account or contract, so a conversion on " +
        "arrival has nowhere to pay it. The plain route is unaffected.",
    );
  }
  if (fee !== undefined && fee.bps > 0 && fee.recipient === ctx.arrival.contract) {
    return ctx.decline("destination-unsupported", SELF_PAYMENT);
  }
  try {
    const why =
      (await cannotHold(ctx.rpc, destination, wanted, "wanted")) ??
      (await cannotHold(
        ctx.rpc,
        destination,
        arriving,
        "arriving",
        BigInt(plain.receives.baseUnits),
      ));
    if (why !== undefined) return ctx.decline("destination-unsupported", why);
    if (fee !== undefined && fee.bps > 0) {
      const feeWhy = await cannotHold(ctx.rpc, fee.recipient, wanted, "wanted");
      if (feeWhy !== undefined) {
        return ctx.decline(
          "destination-unsupported",
          `The integrator's fee account cannot hold ${wanted.symbol}, so the conversion would ` +
            "never run. The plain route is unaffected.",
        );
      }
    }
  } catch (cause) {
    return ctx.decline(
      "temporarily-unavailable",
      cause instanceof MavnaError && cause.retryable
        ? "Stellar did not answer freshly enough to check that address. Try again in a moment."
        : "That address could not be checked for a conversion on arrival.",
    );
  }

  let venue: Awaited<ReturnType<PathVenue["quotePath"]>>;
  try {
    venue = await ctx.arrival.venue.quotePath({
      assetIn: request.arrivingContract,
      assetOut: request.wantedContract,
      amountIn: plain.receives.baseUnits,
      maxSlippageBps: Math.min(request.maxSlippageBps, COMPOSE_MAX_SLIPPAGE_BPS),
      // a path through anything else would be delivered as it came, so it is
      // built from the router's pools between listed tokens only
      via: config.pathTokens,
    });
  } catch (cause) {
    return ctx.decline(
      "no-liquidity",
      `There is no way to convert ${arriving.symbol} into ${wanted.symbol} on arrival right now.` +
        (cause instanceof MavnaError ? ` ${cause.message}` : ""),
    );
  }

  if (!arrivalConverts(config, request.arrivingContract, request.wantedContract, venue.path)) {
    return ctx.decline(
      "no-liquidity",
      `The only way to convert ${arriving.symbol} into ${wanted.symbol} right now passes ` +
        "through pools the Arrival Contract does not use. The plain route still delivers it.",
    );
  }

  const bps = BigInt(fee?.bps ?? 0);
  const out = BigInt(venue.amountOut);
  const taken = (out * bps) / BPS;
  // the contract asks the venue for ceil(minOut / (1 - fee)), so rounding the
  // floor down here keeps that within the venue's own minimum
  const minOut = (BigInt(venue.amountOutMinimum) * (BPS - bps)) / BPS;
  if (minOut <= 0n || out - taken <= 0n) {
    return ctx.decline(
      "amount-too-small",
      `Too little would arrive to convert into ${wanted.symbol}. The plain route still delivers it.`,
    );
  }

  // the payout is known now, so the recipient's limit is held to it
  try {
    const why = await cannotHold(ctx.rpc, destination, wanted, "wanted", out - taken);
    if (why !== undefined) return ctx.decline("destination-unsupported", why);
  } catch (cause) {
    return ctx.decline(
      "temporarily-unavailable",
      cause instanceof MavnaError && cause.retryable
        ? "Stellar did not answer freshly enough to check that address. Try again in a moment."
        : "That address could not be checked for a conversion on arrival.",
    );
  }

  // What finishing it by hand would cost whoever does it, should LayerZero's
  // executor not: the run itself plus any renewal of the contract's storage
  // that falls due. Unpriceable is left unsaid rather than guessed.
  let finishCostStroops: string | undefined;
  try {
    const rent = await estimateFinishRent(ctx.rpc, ctx.passphrase, ctx.arrival.contract);
    finishCostStroops = (rent + COMPOSE_FINISH_BASE_STROOPS).toString();
  } catch {
    finishCostStroops = undefined;
  }

  const compose: ComposeArrival = {
    contract: ctx.arrival.contract,
    venue: venue.provider,
    arriving,
    arrivingContract: request.arrivingContract,
    wanted,
    wantedContract: request.wantedContract,
    minOut: minOut.toString(),
    path: venue.path,
    fee:
      fee === undefined || fee.bps === 0 ? undefined : { bps: fee.bps, recipient: fee.recipient },
    trust:
      `LayerZero carries it, checked by the verifiers ${resolved.tokenSymbol}'s owner chose. On ` +
      `Stellar the Mavna Arrival Contract converts it through ${venueName(venue.provider)} with ` +
      "your minimum enforced on-chain. The contract has no administrator and accepts only " +
      `${resolved.tokenSymbol} from LayerZero. Anyone may complete the conversion, so expect ` +
      "the minimum rather than the quote.",
    walletNote: "No Stellar wallet needed: the conversion happens on arrival.",
    fallback:
      `If ${wanted.symbol} cannot be bought for at least your minimum, you receive ` +
      `${arriving.symbol} as it came instead.`,
    ...(finishCostStroops === undefined ? {} : { finishCostStroops }),
  };

  const sendParam = buildSendParam({
    dstEid: STELLAR_SIDE[ctx.network].eid,
    stellarRecipient: ctx.arrival.contract,
    amount: BigInt(plain.sends.baseUnits),
    minAmount: minAmountFor(plain, resolved),
    extraOptions: options,
    composeMsg: encodeArrivalMessage(destination, compose),
  });
  // priced again: a send that carries a compose buys the compose call as well
  const gas = await ctx.discovery.quoteNativeFee(resolved, sendParam);
  if (gas === undefined) {
    return ctx.decline(
      "temporarily-unavailable",
      `${resolved.source.name}'s ${resolved.tokenSymbol} contract would not price a conversion ` +
        "on arrival right now. Nothing about the amount or the address is wrong.",
    );
  }

  const receives = amountOf(wanted, (out - taken).toString());
  const fees: Fee[] = plain.fees.map((line) =>
    line.kind === "gas"
      ? {
          ...line,
          total: amountOf(line.total.asset, gas.nativeFee.toString()),
          recipients: line.recipients.map((r) => ({
            ...r,
            amount: amountOf(r.amount.asset, gas.nativeFee.toString()),
          })),
        }
      : line,
  );
  if (fee !== undefined && taken > 0n) {
    fees.push({
      kind: "integrator",
      total: amountOf(wanted, taken.toString()),
      recipients: [
        {
          name: fee.recipientName,
          amount: amountOf(wanted, taken.toString()),
          address: fee.recipient,
        },
      ],
      // taken by the contract out of the conversion, before the recipient is paid
      includedInQuote: true,
    });
  }

  return {
    ...plain,
    id: `${plain.id}-arrival`,
    receives,
    receivesAtLeast: amountOf(wanted, minOut.toString()),
    fees,
    estimatedSeconds: plain.estimatedSeconds + COMPOSE_SECONDS,
    steps: [
      ...plain.steps,
      {
        id: `compose-${plain.steps.length}`,
        kind: "compose",
        source: venue.provider,
        from: plain.receives,
        to: receives,
        estimatedSeconds: COMPOSE_SECONDS,
        execution: undefined,
      },
    ],
    // the conversion runs on arrival, so it adds nothing to sign
    signaturesRequired: plain.signaturesRequired,
    compose,
  };
}

/** The compose half of a send: where it goes, what it carries, what it pays for. */
export async function composeSendFor(
  ctx: ComposeContext,
  route: Route & { readonly compose: ComposeArrival },
  resolved: ResolvedRoute,
): Promise<{
  readonly to: string;
  readonly composeMsg: `0x${string}`;
  readonly extraOptions: `0x${string}`;
}> {
  // a route is data the caller hands back, so what it names is checked again
  const config = await assertArrivalServes(ctx, route.compose.contract, resolved);
  if (
    !arrivalConverts(
      config,
      route.compose.arrivingContract,
      route.compose.wantedContract,
      route.compose.path,
    )
  ) {
    throw new MavnaError(
      "The Arrival Contract would not convert along this route's path, so it is not sent.",
      { retryable: false },
    );
  }
  if (route.compose.arrivingContract !== resolved.stellar.token) {
    throw new MavnaError(
      "This route's conversion starts from a token the route does not deliver.",
      {
        retryable: false,
      },
    );
  }
  if (
    route.destination === route.compose.contract ||
    route.compose.fee?.recipient === route.compose.contract
  ) {
    throw new MavnaError(SELF_PAYMENT, { retryable: false });
  }
  // the contract cannot send anything back once it holds it, so a recipient that
  // cannot be named in the message, or cannot take what arrives, is never sent to
  const composeMsg = encodeArrivalMessage(route.destination, route.compose);
  const arrived = route.steps.find((s) => s.kind === "compose")?.from.baseUnits;
  if (arrived === undefined) {
    throw new MavnaError("This route has no conversion step to say how much arrives.", {
      retryable: false,
    });
  }
  const why =
    (await cannotHold(
      ctx.rpc,
      route.destination,
      route.compose.arriving,
      "arriving",
      BigInt(arrived),
    )) ??
    (await cannotHold(
      ctx.rpc,
      route.destination,
      route.compose.wanted,
      "wanted",
      BigInt(route.receives.baseUnits),
    ));
  if (why !== undefined) throw new MavnaError(why, { retryable: false });
  return {
    to: route.compose.contract,
    composeMsg,
    extraOptions: await composeOptionsFor(ctx, resolved),
  };
}

function venueName(id: string): string {
  return id === "aquarius" ? "Aquarius" : id;
}
/** A Stellar asset contract as the asset model names it, from the contract itself. */
async function assetOfToken(ctx: ComposeContext, token: string): Promise<Asset> {
  const name = await readTokenName(ctx.rpc, ctx.passphrase, token);
  const chainId = STELLAR_SIDE[ctx.network].chainId;
  if (name === "native") {
    return {
      chainId,
      id: "native",
      symbol: "XLM",
      decimals: STELLAR_DECIMALS,
      curatedBy: "Stellar",
    };
  }
  const [code, issuer] = name.split(":");
  if (
    code === undefined ||
    issuer === undefined ||
    stellarAssetOf({ id: name } as Asset) === undefined
  ) {
    // not a classic asset: named by its contract, which is the only identity it has
    return { chainId, id: token, symbol: name, decimals: STELLAR_DECIMALS, curatedBy: undefined };
  }
  return { chainId, id: name, symbol: code, decimals: STELLAR_DECIMALS, curatedBy: undefined };
}

/**
 * Where the compose step of a delivered message stands, or undefined when the
 * message is not a compose to this app's Arrival Contract.
 *
 * Proven from LayerZero's record of the message and the contract's own event,
 * never from a balance: a balance says what an account holds, not what this
 * transfer did.
 */
/**
 * A compose for a contract this app does not use (another app's, or one this
 * app used before its setting changed) cannot be read here. Calling it
 * delivered would say the money reached the recipient, when it reached that
 * contract and waits on whatever it does.
 */
export function composedElsewhere(
  network: NetworkId,
  sentTo: string,
  delivered: OnChainRef,
): StepPhase {
  return {
    phase: "stalled",
    ref: delivered,
    overdueSeconds: 0,
    remedy: {
      kind: "contact",
      reference: `https://stellar.expert/explorer/${STELLAR_SIDE[network].explorerPath}/contract/${sentTo}`,
      because:
        "This transfer went to another Arrival Contract than the one this app uses, so how it " +
        "ended cannot be read here. That contract's history on the explorer shows it.",
    },
  };
}

export async function composePhase(
  ctx: ComposeContext,
  message: ScanMessage,
  chainId: string,
  delivered: OnChainRef,
): Promise<StepPhase | undefined> {
  const payload = message.source?.tx?.payload;
  const compose = payload === undefined ? undefined : decodeOftComposePayload(payload);
  if (compose === undefined) return undefined;
  const sentTo = bytes32ToStellarContract(compose.sendTo);
  if (sentTo !== ctx.arrival.contract) return composedElsewhere(ctx.network, sentTo, delivered);
  const guid = message.guid;
  if (guid === undefined) return { phase: "pending", ref: delivered, expectedByUnix: 0 };

  const route = await ctx.discovery.routeFrom(chainId);
  const contract = ctx.arrival.contract;
  const stellarRef = (txHash: string): OnChainRef => ({
    chainId: STELLAR_SIDE[ctx.network].chainId,
    txHash,
    explorerUrl: stellarExplorerTxUrl(ctx.network, txHash),
  });

  // the delivery's own ledger, so the event search starts where it can be
  const deliveredTx = message.destination?.tx?.txHash;
  let fromLedger: number | undefined;
  let deliveredAt = message.destination?.tx?.blockTimestamp;
  if (deliveredTx !== undefined) {
    const found = await ctx.rpc.server.getTransaction(deliveredTx);
    if (found.status === "SUCCESS") {
      fromLedger = found.ledger;
      // when Scan does not time the delivery, the transaction itself does
      deliveredAt ??= found.createdAt;
    }
  }

  const event = await findArrivalEvent(ctx.rpc, contract, guid, fromLedger);
  if (event !== undefined) {
    const asset = await assetOfToken(ctx, event.asset);
    const received: Amount = amountOf(asset, event.amount.toString());
    if (event.outcome === "converted") {
      return {
        phase: "delivered-and-converted",
        ref: stellarRef(event.txHash),
        received,
        fee: event.fee > 0n ? amountOf(asset, event.fee.toString()) : undefined,
      };
    }
    return {
      phase: "delivered-as-came",
      ref: stellarRef(event.txHash),
      received,
      because:
        `The conversion could not meet your minimum, so the ${asset.symbol} that arrived was ` +
        "sent on to you as it came.",
    };
  }

  const slot = await readComposeQueue(ctx.rpc, ctx.passphrase, {
    endpoint: route.stellar.endpoint,
    from: route.stellarOft,
    to: contract,
    guid,
    index: 0,
  });
  if (slot === undefined) {
    // delivered by LayerZero's account but not yet queued for the contract,
    // which only the next ledger can change
    return { phase: "pending", ref: delivered, expectedByUnix: 0 };
  }
  if (slot === COMPOSE_RECEIVED) {
    return {
      phase: "stalled",
      ref: delivered,
      overdueSeconds: 0,
      remedy: {
        kind: "contact",
        reference: `https://stellar.expert/explorer/${STELLAR_SIDE[ctx.network].explorerPath}/contract/${contract}`,
        because:
          "The Arrival Contract has finished this delivery, but the record of how is older " +
          "than this network's nodes keep. The contract's history on the explorer shows it.",
      },
    };
  }

  // rebuilt from LayerZero's record and checked against the endpoint's hash, so
  // a finisher is only ever handed the exact bytes that are waiting
  const nonce = message.pathway?.nonce;
  const srcEid = message.pathway?.srcEid;
  let finish: ComposeFinishData | undefined;
  if (nonce !== undefined && srcEid !== undefined) {
    const queued = encodeOftComposeMsg({
      nonce: BigInt(nonce),
      srcEid,
      amountLd: sharedToStellar(compose.amountSd, route.stellar.decimalsDiff),
      composeFrom: compose.composeFrom,
      composeMsg: compose.composeMsg,
    });
    if (composeMessageHash(queued) === slot) {
      finish = {
        contract,
        from: route.stellarOft,
        guid: guid.replace(/^0x/, ""),
        index: 0,
        message: queued,
      };
    }
  }
  return {
    phase: "delivered-conversion-pending",
    ref: delivered,
    // Untimed by Scan and by the node: dated as long ago rather than now, so a
    // finish is offered. Finishing checks the endpoint's own slot first and a
    // second run changes nothing, so offering it early costs nothing.
    deliveredAtUnix: deliveredAt ?? 0,
    finish,
  };
}

type ComposeFinishData = Extract<StepPhase, { phase: "delivered-conversion-pending" }>["finish"];
