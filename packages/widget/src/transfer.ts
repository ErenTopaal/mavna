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
import { buildPathPayment } from "@mavna/swap";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import { type ExecutionEvent, execute } from "./execute";
import { remember } from "./history";
import { type RouteView, settlementBlocker, type Wanted } from "./quote";
import {
  adapterFor,
  endedNote,
  pollSettlement,
  STILL_MOVING,
  settleNote,
  sleep,
  stepsFor,
  trackDelivery,
} from "./rails";
import type { Connection } from "./wallet";

export type StepPhase = "idle" | "blocked" | "pending" | "done" | "failed";

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

function passphrase(network: NetworkId): string {
  return network === "mainnet"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";
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
export function buildSteps(view: RouteView): FlightStep[] {
  return stepsFor(view.route).map((step) => ({ ...step, phase: "idle" }));
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
  | "sdex"
  | "rpc"
  | "usdcOnStellar"
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
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Prove control of the destination and sign the settlement before anything
 * burns, exactly as the cost decision requires.
 */
async function collectSettlement(
  engine: TransferEngine,
  route: Route,
  chainId: string,
): Promise<string> {
  const address = await engine.stellar.connect();
  if (address !== route.destination) {
    throw new Error(
      "Only the owner of the receiving account can allow it to hold USDC. " +
        "Connect that wallet, or send to an address that can already receive.",
    );
  }
  const built = await engine.sponsor.requestSettlement(route.destination, chainId);
  const signed = await engine.stellar.sign(built.xdr, address);
  await engine.sponsor.commitSettlement(route.destination, signed);
  return address;
}

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

/** Convert the arrived USDC into XLM on Stellar's own exchange. */
async function convertOnStellar(
  engine: TransferEngine,
  route: Route,
  owner: string | undefined,
): Promise<void> {
  const account = owner ?? (await engine.stellar.connect());
  if (account !== route.destination) {
    throw new Error(
      "The conversion spends from the receiving account, so only its owner can " +
        "sign it. The USDC has arrived and is theirs either way.",
    );
  }
  const swapStep = route.steps.find((s) => s.kind === "swap");
  const quote = await engine.sdex.quote({
    assetIn: engine.usdcOnStellar.id,
    assetOut: "native",
    amountIn: swapStep?.from.baseUnits ?? route.sends.baseUnits,
    maxSlippageBps: 50,
    destinationKind: "account",
  });
  const stellarAccount = await engine.rpc.loadAccount(account);
  const unsigned = buildPathPayment({
    networkPassphrase: passphrase(engine.network),
    account: stellarAccount,
    quote,
  });
  const signed = await engine.stellar.sign(unsigned.toXDR(), account);
  const parsed = TransactionBuilder.fromXDR(signed, unsigned.networkPassphrase);
  await engine.rpc.submit("conversion", async () => parsed as never);
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
): Promise<void> {
  const domain = engine.sourceDomain(chainId);
  patch("attest", { phase: "pending" });
  let prepared = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const outcome = await engine.sponsor.requestDelivery(burnHash, domain, route.destination);
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
      if (outcome.settled === true) {
        deliverPatch.note = "Delivered, and the deposit repaid itself from the arrival.";
      }
      patch("deliver", deliverPatch);
      return;
    }
    if (outcome.kind === "recipient-not-ready") {
      if (owner !== undefined && !prepared) {
        patch("prepare", { phase: "blocked" });
        await prepareNow(engine, route, chainId, owner);
        patch("prepare", { phase: "done" });
        prepared = true;
        continue;
      }
      throw new Error(outcome.detail);
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error(
    "Circle has not attested this transfer yet. Your funds are safe and this page " +
      "can finish the delivery later: find the transfer under Activity.",
  );
}

/** Sign the source chain's transactions and keep the send's hash in history. */
async function send(
  deps: TransferDeps,
  adapter: BridgeAdapter,
  route: Route,
): Promise<string | undefined> {
  const { engine, chainId, chainName, patch } = deps;
  const transactions = await adapter.buildTransactions(route);
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

/** Refuse a new account the sponsor cannot reach or cannot be repaid for. */
async function assertSponsorable(engine: TransferEngine, route: Route): Promise<void> {
  const blocked = settlementBlocker(route, engine.usdcOnStellar.id);
  if (blocked !== undefined) throw new Error(`${blocked} Nothing has been sent.`);
  if (!(await engine.sponsor.sponsorIsUp())) {
    throw new Error(
      "Setting up a new Stellar account needs the sponsor service, which is not " +
        "reachable right now. Nothing has been sent.",
    );
  }
}

/**
 * LayerZero and Axelar: the rail delivers by itself, to an account that must
 * already be able to hold what arrives, so the account is prepared before the
 * send. The sponsor submits the held repayment once the funds have landed.
 */
async function runRelayed(deps: TransferDeps, adapter: BridgeAdapter): Promise<string | undefined> {
  const { engine, view, chainId, patch } = deps;
  const route = view.route;
  const wait = deps.wait ?? sleep;
  let owner: string | undefined;

  if (view.newAccount) {
    await assertSponsorable(engine, route);
    patch("settle", { phase: "blocked" });
    owner = await collectSettlement(engine, route, chainId);
    patch("settle", { phase: "done" });
    patch("prepare", { phase: "blocked" });
    await prepareNow(engine, route, chainId, owner);
    patch("prepare", { phase: "done" });
  }

  const sendHash = await send(deps, adapter, route);
  if (sendHash === undefined) return owner;

  const handle: TransferHandle = {
    sourceTxHash: sendHash,
    depositAddress: undefined,
    destinationAddress: route.destination,
    sourceChainId: chainId,
  };
  const tracked = await trackDelivery(adapter, handle, patch, { wait });
  if (tracked.outcome === "timed-out") {
    throw new Error(
      tracked.error === undefined
        ? STILL_MOVING
        : `${STILL_MOVING} The last check failed: ${tracked.error}`,
    );
  }
  if (tracked.phase.phase !== "done") throw new Error(endedNote(tracked.phase));

  if (owner !== undefined) {
    // The funds are on Stellar whatever the sponsor says next, so nothing here
    // can fail the transfer; it can only change what the deliver step says.
    let note: string;
    try {
      note = settleNote(await pollSettlement(engine.sponsor, route.destination, { wait }));
    } catch (cause) {
      note =
        "Delivered on Stellar. Asking the sponsor to take the deposit repayment failed: " +
        (cause instanceof Error ? cause.message : String(cause));
    }
    patch("deliver", { note });
  }
  return owner;
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

  if (adapter.id === "cctp") {
    if (view.newAccount) {
      await assertSponsorable(engine, route);
      patch("settle", { phase: "blocked" });
      owner = await collectSettlement(engine, route, chainId);
      patch("settle", { phase: "done" });
    }
    const burnHash = await send(deps, adapter, route);
    if (burnHash !== undefined) {
      await deliverToStellar(engine, burnHash, owner, route, chainId, patch);
    }
  } else {
    owner = await runRelayed(deps, adapter);
  }

  if (route.steps.some((s) => s.kind === "swap")) {
    patch("swap", { phase: "blocked" });
    await convertOnStellar(engine, route, owner);
    patch("swap", { phase: "done" });
  }
}
