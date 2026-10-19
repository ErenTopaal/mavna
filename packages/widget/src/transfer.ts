/*
 * The real transfer runner.
 *
 * This is Transfer.tsx's SendPanel.send() flow, unchanged in substance, adapted
 * to drive the design's flight step list instead of a plain note log. Every phase
 * a step reaches is a real event: a wallet signature, an inclusion, Circle's
 * attestation, the sponsored preparation, the delivery, the conversion. Nothing
 * is a timer. The design's simulated `runStep` is gone.
 *
 * The SDK, the sponsor and the Stellar wallet all arrive on an `Engine` rather
 * than as module singletons, so the same runner serves the app (env config) and
 * the widget (an integrator's config).
 */
import type { BridgeAdapter, NetworkId, Route, TransferHandle } from "@mavna/core";
import { isSuccess } from "@mavna/core";
import { inspectDestination, stroopsToXlm, xlmToStroops } from "@mavna/stellar";
import {
  FeeBumpTransaction,
  type Operation,
  Asset as StellarAsset,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import { type ExecutionEvent, execute } from "./execute";
import { remember } from "./history";
import {
  deliverOwn,
  OWN_DELIVERY_FEE_BUDGET_STROOPS,
  OWN_TRUSTLINE_FEE_STROOPS,
  type OwnDelivery,
} from "./own-delivery";
import { type RouteView, settlementBlocker, trustlineNameOf, type Wanted } from "./quote";
import {
  adapterFor,
  destinationBlocker,
  endedNote,
  pollSettlement,
  STILL_MOVING,
  STOPPED_WATCHING,
  settleNote,
  sleep,
  stepsFor,
  trackDelivery,
} from "./rails";
import type { SponsorDelivery, SponsorTerms } from "./sponsor";
import type { Connection } from "./wallet";

export type StepPhase = "idle" | "blocked" | "pending" | "done" | "failed";

/**
 * The transfer is still on its way and this page has stopped watching it: it
 * outlived the page's patience, or the page went away. Not a failure, and
 * never shown as one: the money is in flight and Activity can finish it.
 */
export class StillMoving extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StillMoving";
  }
}

/**
 * A conversion on arrival that could not meet the minimum, so the arriving
 * token was delivered as it came. The money arrived, in the asset it was sent
 * in; not a success, and not a loss either.
 */
export class DeliveredAsCame extends Error {
  /** What arrived, by symbol, and how much in its base units. */
  readonly asset: string;
  readonly baseUnits: string;

  constructor(message: string, asset: string, baseUnits: string) {
    super(message);
    this.name = "DeliveredAsCame";
    this.asset = asset;
    this.baseUnits = baseUnits;
  }
}

/** A flight step row, shaped for the flight screen's markup. */
export interface FlightRow {
  key: string;
  label: string;
  meta: string;
  metaInk: string;
  dotAnim: string;
  hasLine: boolean;
  lineStyle: string;
  lineColor: string;
  mark: string;
  markInk: string;
  dotBg: string;
  dotBorder: string;
  ink: string;
  weight: number;
  hasNote: boolean;
  note: string;
  noteInk: string;
  hasRef: boolean;
  refText: string;
  refUrl: string;
  gap: string;
}

export interface FlightStep {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  /** True when this step waits on the user's wallet. */
  readonly user: boolean;
  /** Who acts on this step: the user's wallet, the rail, or Mavna. A real fact. */
  readonly actor: string;
  readonly ref?: string;
  readonly refUrl?: string;
  readonly phase: StepPhase;
}

function stellarExplorer(network: NetworkId, hash: string): string {
  return `https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}/tx/${hash}`;
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/**
 * The steps a transfer will take, built from the real chosen route.
 *
 * The settle and prepare steps appear only when the route carries a
 * `prepare-account` step, and the swap step only when it carries a `swap` step.
 * Which steps sit between them depends on the rail; see `stepsFor`.
 */
export function buildSteps(
  view: RouteView,
  reserveFunding: SponsorTerms["reserveFunding"] = "sponsor",
): FlightStep[] {
  return stepsFor(view.route, reserveFunding).map((step) => ({ ...step, phase: "idle" }));
}

/** How the runner reports progress back to the flight screen. */
export type Patch = (id: string, patch: Partial<FlightStep>) => void;

/** The parts of an engine a transfer touches. */
export type TransferEngine = Pick<
  Engine,
  | "network"
  | "adapters"
  | "sponsor"
  | "stellar"
  | "historyKey"
  | "sourceDomain"
  | "swapVenues"
  | "rpc"
  | "usdcOnStellar"
  | "sponsorTerms"
  | "stellarNetwork"
>;

export interface TransferDeps {
  readonly engine: TransferEngine;
  readonly view: RouteView;
  readonly chainId: string;
  readonly chainName: string;
  readonly evmChainId: number;
  readonly nativeCurrency: { name: string; symbol: string; decimals: number } | undefined;
  readonly connection: Connection;
  readonly wanted: Wanted;
  readonly patch: Patch;
  readonly onEvmEvent: (event: ExecutionEvent) => void;
  /** How the runner waits between polls. A test passes one that does not. */
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock the delivery watch measures its patience by. A test passes its own. */
  readonly now?: () => number;
  /**
   * Aborted when the page goes away. It stops watching a relayed delivery, and
   * nothing else: the sponsor is still asked to take its repayment.
   */
  readonly signal?: AbortSignal;
}

/**
 * Prove control of the destination and sign the settlement before anything
 * burns, exactly as the cost decision requires.
 */
async function collectSettlement(
  engine: TransferEngine,
  route: Route,
  chainId: string,
): Promise<{ readonly owner: string; readonly repaysAtMost: bigint }> {
  const address = await engine.stellar.connect();
  if (address !== route.destination) {
    throw new Error(
      "Only the owner of the receiving account can allow it to hold USDC. " +
        "Connect that wallet, or send to an address that can already receive.",
    );
  }
  const built = await engine.sponsor.requestSettlement(route.destination, chainId);
  // a conversion has to leave the repayment its share, so it reads what the
  // settlement may spend before the user signs it
  const repaysAtMost = route.steps.some((s) => s.kind === "swap")
    ? settlementSpend(built.xdr, engine.stellarNetwork.passphrase)
    : 0n;
  const signed = await engine.stellar.sign(built.xdr, address);
  await engine.sponsor.commitSettlement(route.destination, signed);
  return { owner: address, repaysAtMost };
}

/** The most the held settlement may spend of the arrival: its strict-receive's sendMax. */
function settlementSpend(built: string, passphrase: string): bigint {
  const tx = TransactionBuilder.fromXDR(built, passphrase);
  const buys =
    "operations" in tx
      ? tx.operations.find(
          (op): op is Operation.PathPaymentStrictReceive => op.type === "pathPaymentStrictReceive",
        )
      : undefined;
  if (buys === undefined) {
    throw new Error(
      "The sponsor's repayment does not say how much of the arrival it may spend, so the " +
        "conversion cannot leave that aside. Nothing has been sent.",
    );
  }
  return xlmToStroops(buys.sendMax);
}

/**
 * Open the trustline from the account's own XLM, for a sponsor that does not
 * front reserves. Nothing is lent, so nothing has to wait for the money: it
 * goes first, and an account short of XLM hears so before anything is sent.
 */
async function prepareOwn(engine: TransferEngine, route: Route, chainId: string): Promise<string> {
  const holds = route.deliveredAtLeast.asset;
  const address = await engine.stellar.connect();
  if (address !== route.destination) {
    throw new Error(
      `Only the owner of the receiving account can allow it to hold ${holds.symbol}. ` +
        "Connect that wallet, or send to an address that can already receive. " +
        "Nothing has been sent.",
    );
  }
  await openOwnTrustline(engine, route, chainId, address, "Nothing has been sent.");
  return address;
}

/**
 * Open the trustline the route delivers into, signed and paid by `address`,
 * which must be the receiving account. The sponsor builds it from its own
 * list, so it is checked against the delivered asset before anyone signs.
 */
async function openOwnTrustline(
  engine: TransferEngine,
  route: Route,
  chainId: string,
  address: string,
  /** What to tell the user about their funds if this is refused. */
  funds: string,
  /** The asset to hold: what the rail delivers, unless a conversion needs another. */
  holds: Route["deliveredAtLeast"]["asset"] = route.deliveredAtLeast.asset,
): Promise<void> {
  const name = trustlineNameOf(holds.id, engine.usdcOnStellar.id);
  if (name === undefined) {
    throw new Error(`The sponsor curates no trustline for ${holds.symbol}. ${funds}`);
  }
  const preparation = await engine.sponsor.requestPreparation(route.destination, chainId, name);
  // The account pays for this one, and the sponsor names the issuer by its own
  // list, so it is checked against what the rail will deliver before the user
  // is asked to sign: a trustline to anything else lets the delivery fail.
  if (!opensOnly(preparation.xdr, engine.stellarNetwork.passphrase, route.destination, holds.id)) {
    throw new Error(
      `The sponsor's preparation is not the trustline this transfer needs (${holds.symbol} ` +
        `for the receiving account), so it was not signed. ${funds}`,
    );
  }
  const signed = await engine.stellar.sign(preparation.xdr, address);
  await engine.sponsor.submitPreparation(signed);
}

/** Whether a transaction does nothing but open `assetId` for `account`, from it. */
function opensOnly(xdr: string, passphrase: string, account: string, assetId: string): boolean {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, passphrase);
  } catch {
    // unreadable is answered as "not that trustline" by the caller
    return false;
  }
  if (parsed instanceof FeeBumpTransaction || parsed.source !== account) return false;
  // The account pays the fee and the trustline lasts, so both are bounded:
  // the sponsor's own bid, the default (largest) limit, and a short time bound.
  const ops = parsed.operations.length;
  if (BigInt(parsed.fee) > OWN_TRUSTLINE_FEE_STROOPS * BigInt(ops)) return false;
  const maxTime = Number(parsed.timeBounds?.maxTime ?? 0);
  const now = Math.floor(Date.now() / 1000);
  if (maxTime === 0 || maxTime > now + OWN_TRUSTLINE_MAX_SECONDS) return false;
  return (
    ops > 0 &&
    parsed.operations.every(
      (op) =>
        op.type === "changeTrust" &&
        (op.source === undefined || op.source === account) &&
        op.line instanceof StellarAsset &&
        op.line.toString() === assetId &&
        op.limit === DEFAULT_TRUST_LIMIT,
    )
  );
}

/** What a changeTrust with no limit given reads back as: the largest Int64 in stroops. */
const DEFAULT_TRUST_LIMIT = "922337203685.4775807";
/** The sponsor builds with a 300 second bound; anything far longer is refused. */
const OWN_TRUSTLINE_MAX_SECONDS = 600;

/** Prepare the account, only once the attestation exists. */
async function prepareNow(
  engine: TransferEngine,
  route: Route,
  chainId: string,
  address: string,
): Promise<void> {
  const preparation = await engine.sponsor.requestPreparation(route.destination, chainId);
  const signed = await engine.stellar.sign(preparation.xdr, address);
  await engine.sponsor.submitPreparation(signed);
}

/** Convert the arrived USDC into XLM through the first venue that serves the pair. */
export async function convertOnStellar(
  engine: Pick<TransferEngine, "network" | "stellar" | "swapVenues" | "rpc" | "usdcOnStellar">,
  route: Route,
  owner: string | undefined,
  /**
   * What this transfer measurably brought in, in base units of the arriving
   * asset: the account's balance after delivery less before it. The conversion
   * spends exactly this, so money the account already held is never touched.
   */
  arrived: string,
): Promise<"converted" | "too-small"> {
  const swapStep = route.steps.find((s) => s.kind === "swap");
  // what the rail delivered and what the user asked to hold: USDC into XLM, or
  // the USDT0 LayerZero delivers into USDC or XLM
  const asset = swapStep?.from.asset ?? engine.usdcOnStellar;
  const wanted = swapStep?.to.asset ?? route.receivesAtLeast.asset;
  const account = owner ?? (await engine.stellar.connect());
  if (account !== route.destination) {
    throw new Error(
      "The conversion spends from the receiving account, so only its owner can " +
        `sign it. The ${asset.symbol} has arrived and is theirs either way.`,
    );
  }
  if (BigInt(arrived) <= 0n) {
    throw new Error(
      `Nothing measurable arrived in ${asset.symbol} for this transfer, so there is nothing to ` +
        "convert. Whatever did arrive stays yours as it is.",
    );
  }
  // Quoted again now rather than reused from the route: the route's quote is as
  // old as the bridge leg, and the venue that serves now is the one that builds.
  const quote = await engine.swapVenues.quote({
    assetIn: asset.id,
    assetOut: wanted.id,
    amountIn: arrived,
    maxSlippageBps: 50,
    destinationKind: "account",
  });
  // too little for the venue to give anything back: left as it arrived
  if (BigInt(quote.amountOutMinimum) <= 0n) return "too-small";
  // The route showed the user a least amount of what they wanted; a quote
  // taken now that cannot promise it is not what they agreed to. Converting
  // less than was priced, because a repayment took its share first, holds the
  // conversion to the same rate rather than to the whole amount's floor.
  const shown = route.receivesAtLeast;
  const priced = BigInt(swapStep?.from.baseUnits ?? arrived);
  const floor =
    BigInt(arrived) < priced
      ? (BigInt(shown.baseUnits) * BigInt(arrived)) / priced
      : BigInt(shown.baseUnits);
  if (shown.asset.id === wanted.id && BigInt(quote.amountOutMinimum) < floor) {
    throw new Error(
      "The price moved since this transfer was quoted, and converting now could give less " +
        `${wanted.symbol} than you were shown. The ${asset.symbol} has arrived and is yours; ` +
        "convert it later.",
    );
  }
  const stellarAccount = await engine.rpc.loadAccount(account);
  const unsigned = await engine.swapVenues.build({ quote, account: stellarAccount });
  const signed = await engine.stellar.sign(unsigned.toXDR(), account);
  const parsed = TransactionBuilder.fromXDR(signed, unsigned.networkPassphrase);
  await engine.rpc.submit("conversion", async () => parsed as never);
  return "converted";
}

/**
 * Map the EVM stream onto the approve and send steps. The send is always the
 * last transaction; a rail whose token needs no allowance builds only that one.
 */
function mapEvm(event: ExecutionEvent, count: number, patch: Patch): void {
  const id = event.index === count - 1 ? "burn" : "approve";
  switch (event.kind) {
    case "skipped":
      patch(id, { phase: "done", note: event.why });
      return;
    case "awaiting-signature":
      patch(id, { phase: "blocked" });
      return;
    case "sent":
      patch(id, { phase: "pending" });
      return;
    case "confirmed":
      patch(id, { phase: "done" });
      return;
  }
}

/** Trigger the mint, preparing the account at the last moment if it is new. */
async function deliverToStellar(
  engine: TransferEngine,
  burnHash: string,
  owner: string | undefined,
  route: Route,
  chainId: string,
  patch: Patch,
  alreadyPrepared: boolean,
  /** The account pays for its own delivery: `owner` signs it, the sponsor is not asked. */
  ownDelivery: boolean,
): Promise<{ readonly repaid: boolean }> {
  // an account that pays for its own delivery is the one that signs it; asking
  // the sponsor instead would quietly spend the money self mode exists to save
  if (ownDelivery && owner === undefined) {
    throw new Error(
      "This delivery is the receiving account's to sign, and no Stellar wallet is connected for it.",
    );
  }
  const domain = engine.sourceDomain(chainId);
  patch("attest", { phase: "pending" });
  let prepared = alreadyPrepared;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const outcome =
      ownDelivery && owner !== undefined
        ? await deliverOwn(engine, burnHash, domain, owner)
        : await engine.sponsor.requestDelivery(burnHash, domain, route.destination);
    if (outcome.kind === "too-costly") {
      throw new StillMoving(tooCostly(outcome.feeStroops));
    }
    if (outcome.kind === "delivered" || outcome.kind === "already-delivered") {
      patch("attest", { phase: "done" });
      const deliverPatch: { phase: StepPhase; ref?: string; refUrl?: string; note?: string } = {
        phase: "done",
      };
      if (outcome.kind === "delivered") {
        deliverPatch.ref = shortHash(outcome.txHash);
        deliverPatch.refUrl = stellarExplorer(engine.network, outcome.txHash);
      }
      // The sponsor reports when the held settlement submitted with the mint, so
      // the deliver step can say the deposit repaid itself. Real, from /deliver.
      if ("settled" in outcome && outcome.settled === true) {
        deliverPatch.note = "Delivered, and the deposit repaid itself from the arrival.";
      }
      patch("deliver", deliverPatch);
      return { repaid: "settled" in outcome && outcome.settled === true };
    }
    if (outcome.kind === "recipient-not-ready") {
      if (owner !== undefined && !prepared) {
        patch("prepare", { phase: "blocked" });
        // an account paying for itself gets the same check as at the start
        if (ownDelivery) {
          await openOwnTrustline(
            engine,
            route,
            chainId,
            owner,
            "The funds are safe on Circle's side and still deliverable once the account can hold them.",
          );
        } else await prepareNow(engine, route, chainId, owner);
        patch("prepare", { phase: "done" });
        prepared = true;
        continue;
      }
      throw new Error(outcome.detail);
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new StillMoving(
    "Circle has not attested this transfer yet. Your funds are safe and this page " +
      "can finish the delivery later: find the transfer under Activity.",
  );
}

/**
 * Finish a Circle delivery that stalled, from Activity. Whoever pays for
 * deliveries does it: the sponsor, or with reserves funded by the account, the
 * connected Stellar wallet, which pays the fee from its own XLM.
 */
export async function finishDelivery(
  engine: TransferEngine,
  burnHash: string,
  domain: number,
): Promise<SponsorDelivery | OwnDelivery> {
  const terms = await engine.sponsorTerms();
  if (terms.reserveFunding === "self") {
    return deliverOwn(engine, burnHash, domain, await engine.stellar.connect());
  }
  return engine.sponsor.requestDelivery(burnHash, domain);
}

/** Why a delivery the account would pay for was left unsigned. */
export function tooCostly(feeStroops: bigint): string {
  return (
    `Delivering on Stellar costs ${stroopsToXlm(feeStroops)} XLM right now, more than the ` +
    `${stroopsToXlm(OWN_DELIVERY_FEE_BUDGET_STROOPS)} XLM this page asks an account to spend on ` +
    "it, so it was not signed. The funds are safe and still deliverable: finish the delivery " +
    "later under Activity."
  );
}

/** Sign the source chain's transactions and keep the send's hash in history. */
async function send(
  deps: TransferDeps,
  adapter: BridgeAdapter,
  route: Route,
): Promise<string | undefined> {
  const { engine, chainId, chainName, patch } = deps;
  // The connected wallet goes along for a rail that must name a refund address
  // before it hands out somewhere to deposit; the others ignore it.
  const transactions = await adapter.buildTransactions(route, {
    sender: deps.connection.address,
  });
  const hashes = await execute({
    connection: deps.connection,
    route,
    transactions,
    chainName,
    evmChainId: deps.evmChainId,
    nativeCurrency: deps.nativeCurrency,
    onEvent: (event) => {
      mapEvm(event, transactions.length, patch);
      deps.onEvmEvent(event);
    },
  });

  const sendHash = hashes.at(-1);
  if (sendHash !== undefined) {
    // Written before anything waits on the rail, so a closed tab never loses
    // the one thing that finds this transfer again.
    remember(
      {
        sourceTxHash: sendHash,
        sourceChainId: chainId,
        sourceChainName: chainName,
        destination: route.destination,
        sendsBaseUnits: route.sends.baseUnits,
        symbol: route.sends.asset.symbol,
        decimals: route.sends.asset.decimals,
        startedAtUnix: Math.floor(Date.now() / 1000),
        explorerUrl: route.fromChain.explorerTxUrl(sendHash),
      },
      engine.historyKey,
    );
    patch("burn", {
      ref: shortHash(sendHash),
      refUrl: route.fromChain.explorerTxUrl(sendHash),
    });
  }
  return sendHash;
}

/** The sponsor's terms, or a refusal before anything is sent when it cannot be asked. */
async function termsOf(engine: TransferEngine, needs: string): Promise<SponsorTerms> {
  try {
    return await engine.sponsorTerms();
  } catch (cause) {
    throw new Error(
      `${needs} needs the sponsor service, which is not reachable right now ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Nothing has been sent.`,
    );
  }
}

/**
 * The connected Stellar wallet, when it is the receiving account. An account
 * that pays for its own delivery signs it, so this is known before anything burns.
 */
async function ownWallet(
  engine: TransferEngine,
  route: Route,
  /** What the receiving account pays for and signs itself. */
  pays = "its own delivery on Stellar",
): Promise<string> {
  const address = await engine.stellar.connect();
  if (address !== route.destination) {
    throw new Error(
      `Right now the receiving account pays for ${pays}, so only its owner can sign it. ` +
        "Connect that wallet, or pick another route. Nothing has been sent.",
    );
  }
  return address;
}

/**
 * Refuse a new account the sponsor cannot reach or cannot be repaid for, and
 * learn who pays its reserve.
 */
async function assertSponsorable(engine: TransferEngine, route: Route): Promise<SponsorTerms> {
  const terms = await termsOf(engine, "Setting up a new Stellar account");
  const blocked = settlementBlocker(route, engine.usdcOnStellar.id, terms.reserveFunding);
  if (blocked !== undefined) throw new Error(`${blocked} Nothing has been sent.`);
  return terms;
}

/**
 * LayerZero and Axelar: the rail delivers by itself, to an account that must
 * already be able to hold what arrives, so the account is prepared before the
 * send. The sponsor submits the held repayment once the funds have landed.
 */
async function runRelayed(
  deps: TransferDeps,
  adapter: BridgeAdapter,
): Promise<{ readonly owner: string | undefined; readonly unrepaid: bigint }> {
  const { engine, view, chainId, patch } = deps;
  const route = view.route;
  const wait = deps.wait ?? sleep;
  let owner: string | undefined;
  let selfFunded = false;
  let repaysAtMost = 0n;

  const unready = await destinationBlocker(engine.rpc, route);
  if (unready !== undefined) throw new Error(`${unready} Nothing has been sent.`);

  // A conversion on Stellar into anything but XLM needs that trustline too. It
  // is checked first, so no trustline is signed for a transfer that then
  // cannot go ahead; an account paying its own way opens it before the send.
  const convertsTo = route.steps.find((s) => s.kind === "swap")?.to.asset;
  let opensHold = false;
  if (convertsTo !== undefined && convertsTo.id !== "native") {
    const [code, issuer] = convertsTo.id.split(":");
    const state = await inspectDestination(
      engine.rpc,
      route.destination,
      new StellarAsset(code ?? "", issuer),
    );
    if (state.lane.kind !== "ready" && state.lane.kind !== "contract-ready") {
      const terms = await termsOf(engine, `Converting into ${convertsTo.symbol} on Stellar`);
      if (terms.reserveFunding !== "self") {
        throw new Error(
          `The receiving account cannot hold ${convertsTo.symbol} yet, so the conversion would ` +
            "fail after the money arrives. Add that trustline first. Nothing has been sent.",
        );
      }
      opensHold = true;
    }
  }

  if (view.newAccount) {
    const terms = await assertSponsorable(engine, route);
    if (terms.reserveFunding === "self") {
      patch("prepare", { phase: "blocked" });
      owner = await prepareOwn(engine, route, chainId);
      patch("prepare", { phase: "done" });
      selfFunded = true;
    } else {
      patch("settle", { phase: "blocked" });
      ({ owner, repaysAtMost } = await collectSettlement(engine, route, chainId));
      patch("settle", { phase: "done" });
      patch("prepare", { phase: "blocked" });
      await prepareNow(engine, route, chainId, owner);
      patch("prepare", { phase: "done" });
    }
  }

  if (convertsTo !== undefined && opensHold) {
    owner ??= await ownWallet(engine, route, `the trustline it converts into`);
    patch("hold", { phase: "blocked" });
    await openOwnTrustline(engine, route, chainId, owner, "Nothing has been sent.", convertsTo);
    patch("hold", { phase: "done" });
  } else if (convertsTo !== undefined && convertsTo.id !== "native") {
    patch("hold", { phase: "done", note: `It can already hold ${convertsTo.symbol}.` });
  }

  const sendHash = await send(deps, adapter, route);
  if (sendHash === undefined) return { owner, unrepaid: repaysAtMost };

  const handle: TransferHandle = {
    sourceTxHash: sendHash,
    depositAddress: undefined,
    destinationAddress: route.destination,
    sourceChainId: chainId,
  };
  const tracked = await trackDelivery(adapter, handle, patch, {
    wait,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (tracked.outcome === "stopped") throw new StillMoving(STOPPED_WATCHING);
  if (tracked.outcome === "timed-out") {
    throw new StillMoving(
      tracked.error === undefined
        ? STILL_MOVING
        : `${STILL_MOVING} The last check failed: ${tracked.error}`,
    );
  }
  if (tracked.phase.phase === "delivered-as-came") {
    throw new DeliveredAsCame(
      endedNote(tracked.phase),
      tracked.phase.received.asset.symbol,
      tracked.phase.received.baseUnits,
    );
  }
  if (!isSuccess(tracked.phase)) throw new Error(endedNote(tracked.phase));

  let unrepaid = repaysAtMost;
  if (owner !== undefined && !selfFunded) {
    // The funds are on Stellar whatever the sponsor says next, so nothing here
    // can fail the transfer; it can only change what the deliver step says.
    let note: string;
    try {
      const settled = await pollSettlement(engine.sponsor, route.destination, { wait });
      // taken already, or never to be taken: either way the balance read next is the user's
      if (settled.settled || settled.held === false) unrepaid = 0n;
      note = settleNote(settled);
    } catch (cause) {
      note =
        "Delivered on Stellar. Asking the sponsor to take the deposit repayment failed: " +
        (cause instanceof Error ? cause.message : String(cause));
    }
    patch("deliver", { note });
  }
  return { owner, unrepaid };
}

/**
 * Run the whole transfer. Resolves when the funds are on Stellar. The flight
 * screen renders whatever phase each step is in; on a thrown error the caller
 * marks the active step failed and shows the message.
 */
export async function runTransfer(deps: TransferDeps): Promise<void> {
  const { engine, view, chainId, patch } = deps;
  const route = view.route;
  const adapter = adapterFor(engine, route);
  let owner: string | undefined;
  // what a repayment still to come may take from the arrival
  let unrepaid = 0n;
  // a conversion on Stellar spends what this transfer adds, so the balance is
  // read before anything moves
  const swapFrom = route.steps.find((s) => s.kind === "swap")?.from.asset;
  // and never more than the bridge quoted for it, so a payment from someone else
  // that lands while this one is in transit is not converted along with it
  const bridged = route.steps.find((s) => s.kind === "bridge")?.to;
  if (swapFrom !== undefined && bridged?.asset.id !== swapFrom.id) {
    throw new Error(
      `This route does not say how much ${swapFrom.symbol} its bridge brings in, so the ` +
        "conversion could not tell it apart from other funds. Nothing has been sent.",
    );
  }
  // the recipient signs the conversion, so a wallet that is not theirs is
  // turned away now, not after the money has arrived
  if (swapFrom !== undefined) owner = await ownWallet(engine, route, "its conversion on Stellar");
  const heldBefore =
    swapFrom === undefined ? undefined : await balanceOf(engine, route.destination, swapFrom);

  if (adapter.id === "cctp") {
    let prepared = false;
    // Who funds decides who delivers on Stellar, so it is asked on every Circle
    // transfer, not only one that sets an account up.
    const terms = view.newAccount
      ? await assertSponsorable(engine, route)
      : await termsOf(engine, "Delivering a Circle transfer on Stellar");
    const ownDelivery = terms.reserveFunding === "self";
    if (view.newAccount && ownDelivery) {
      patch("prepare", { phase: "blocked" });
      owner = await prepareOwn(engine, route, chainId);
      patch("prepare", { phase: "done" });
      prepared = true;
    } else if (view.newAccount) {
      patch("settle", { phase: "blocked" });
      ({ owner, repaysAtMost: unrepaid } = await collectSettlement(engine, route, chainId));
      patch("settle", { phase: "done" });
    } else if (ownDelivery) {
      owner = await ownWallet(engine, route);
    }
    const burnHash = await send(deps, adapter, route);
    if (burnHash !== undefined) {
      const { repaid } = await deliverToStellar(
        engine,
        burnHash,
        owner,
        route,
        chainId,
        patch,
        prepared,
        ownDelivery,
      );
      if (repaid) unrepaid = 0n;
    }
  } else {
    ({ owner, unrepaid } = await runRelayed(deps, adapter));
  }

  if (swapFrom !== undefined && heldBefore !== undefined) {
    patch("swap", { phase: "blocked" });
    // exactly what this transfer brought in, so nothing the account held before is spent
    const heldAfter = await balanceOf(engine, route.destination, swapFrom);
    // the sponsor's repayment, if it has not been taken yet, keeps its share
    const brought = heldAfter - heldBefore;
    const quoted = BigInt(bridged?.baseUnits ?? "0");
    const convertible = (brought < quoted ? brought : quoted) - unrepaid;
    const stays = `so it stays in ${swapFrom.symbol}, in your account.`;
    if (convertible <= 0n) {
      patch("swap", {
        phase: "done",
        note:
          `Not converted: after what repaying the sponsor's reserve may take, nothing that ` +
          `arrived is left to convert, ${stays}`,
      });
      return;
    }
    const converted = await convertOnStellar(engine, route, owner, convertible.toString());
    patch(
      "swap",
      converted === "converted"
        ? { phase: "done" }
        : {
            phase: "done",
            note: `Not converted: what is left to convert is below what the exchange can take, ${stays}`,
          },
    );
  }
}

/** What an account holds of an asset, in base units; nothing when it cannot hold it. */
async function balanceOf(
  engine: Pick<TransferEngine, "rpc">,
  account: string,
  asset: Route["deliveredAtLeast"]["asset"],
): Promise<bigint> {
  const [code, issuer] = asset.id.split(":");
  const state = await inspectDestination(
    engine.rpc,
    account,
    asset.id === "native" ? StellarAsset.native() : new StellarAsset(code ?? "", issuer),
  );
  if (asset.id === "native") return BigInt(state.account?.balanceStroops ?? "0");
  return BigInt(state.trustline?.balanceStroops ?? "0");
}
