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
import { explorerTxUrl } from "@mavna/adapter-cctp";
import type { NetworkId, Route } from "@mavna/core";
import { buildPathPayment } from "@mavna/swap";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import { type ExecutionEvent, execute } from "./execute";
import { fmt } from "./format";
import { remember } from "./history";
import type { RouteView, Wanted } from "./quote";
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
  /** Who acts on this step: the user's wallet, Circle, or Mavna. A real fact. */
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
 * Mirrors the design's `buildSteps` order (settle → approve → burn → attest →
 * prepare → deliver → swap), but the settle/prepare steps appear only when the
 * route actually carries a `prepare-account` step, and the swap step only when it
 * carries a `swap` step. Nothing is padded in.
 */
export function buildSteps(
  view: RouteView,
  chainName: string,
  amountText: string,
  wanted: Wanted,
): FlightStep[] {
  const newAccount = view.newAccount;
  const amount = fmt(Number.parseFloat(amountText.replace(/[^0-9.]/g, "")) || 0);
  const out: FlightStep[] = [];
  if (newAccount) {
    out.push({
      id: "settle",
      label: "Approve the repayment first",
      note: "Repays whoever fronted the account reserve.",
      user: true,
      actor: "Your wallet",
      phase: "idle",
    });
  }
  out.push({
    id: "approve",
    label: "Allow Circle to move your USDC",
    note: `Confirm in your wallet: approve ${amount} USDC on ${chainName}.`,
    user: true,
    actor: "Your wallet",
    phase: "idle",
  });
  out.push({
    id: "burn",
    label: `Send from ${chainName}`,
    note: "Waiting for inclusion.",
    user: true,
    actor: "Your wallet",
    phase: "idle",
  });
  out.push({
    id: "attest",
    label: "Circle attests the transfer",
    note: "A few minutes. Safe to close this page.",
    user: false,
    actor: "Circle",
    phase: "idle",
  });
  if (newAccount) {
    out.push({
      id: "prepare",
      label: "Set the account up",
      note: "Approve in your Stellar wallet. Costs you nothing.",
      user: true,
      actor: "Your wallet",
      phase: "idle",
    });
  }
  out.push({
    id: "deliver",
    label: "Deliver on Stellar",
    note: "Delivered on Stellar.",
    user: false,
    actor: "Mavna",
    phase: "idle",
  });
  if (wanted === "XLM") {
    out.push({
      id: "swap",
      label: "Convert to XLM on Stellar's exchange",
      note: "Approve the conversion in your Stellar wallet.",
      user: true,
      actor: "Your wallet",
      phase: "idle",
    });
  }
  return out;
}

/** How the runner reports progress back to the flight screen. */
export type Patch = (id: string, patch: Partial<FlightStep>) => void;

export interface TransferDeps {
  readonly engine: Engine;
  readonly view: RouteView;
  readonly chainId: string;
  readonly chainName: string;
  readonly evmChainId: number;
  readonly nativeCurrency: { name: string; symbol: string; decimals: number } | undefined;
  readonly connection: Connection;
  readonly wanted: Wanted;
  readonly patch: Patch;
  readonly onEvmEvent: (event: ExecutionEvent) => void;
}

/**
 * Prove control of the destination and sign the settlement before anything
 * burns, exactly as the cost decision requires.
 */
async function collectSettlement(engine: Engine, route: Route, chainId: string): Promise<string> {
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
  engine: Engine,
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
  engine: Engine,
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

/** Map the EVM approval/burn stream onto the approve and burn steps. */
function mapEvm(event: ExecutionEvent, patch: Patch): void {
  const id = event.index === 0 ? "approve" : "burn";
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
  engine: Engine,
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

/**
 * Run the whole transfer. Resolves when the funds are on Stellar. The flight
 * screen renders whatever phase each step is in; on a thrown error the caller
 * marks the active step failed and shows the message.
 */
export async function runTransfer(deps: TransferDeps): Promise<void> {
  const { engine, view, chainId, chainName, connection, patch } = deps;
  const route = view.route;
  let owner: string | undefined;

  if (view.newAccount) {
    if (!(await engine.sponsor.sponsorIsUp())) {
      throw new Error(
        "Setting up a new Stellar account needs the sponsor service, which is not " +
          "reachable right now. Nothing has been sent.",
      );
    }
    patch("settle", { phase: "blocked" });
    owner = await collectSettlement(engine, route, chainId);
    patch("settle", { phase: "done" });
  }

  const transactions = await engine.cctp.buildTransactions(route);
  const hashes = await execute({
    connection,
    route,
    transactions,
    chainName,
    evmChainId: deps.evmChainId,
    nativeCurrency: deps.nativeCurrency,
    onEvent: (event) => {
      mapEvm(event, patch);
      deps.onEvmEvent(event);
    },
  });

  const burnHash = hashes.at(-1);
  if (burnHash !== undefined) {
    remember(
      {
        sourceTxHash: burnHash,
        sourceChainId: chainId,
        sourceChainName: chainName,
        destination: route.destination,
        sendsBaseUnits: route.sends.baseUnits,
        symbol: route.sends.asset.symbol,
        decimals: route.sends.asset.decimals,
        startedAtUnix: Math.floor(Date.now() / 1000),
        explorerUrl: explorerTxUrl(engine.network, chainId, burnHash),
      },
      engine.historyKey,
    );
    patch("burn", {
      ref: shortHash(burnHash),
      refUrl: explorerTxUrl(engine.network, chainId, burnHash),
    });
    await deliverToStellar(engine, burnHash, owner, route, chainId, patch);
  }

  if (route.steps.some((s) => s.kind === "swap")) {
    patch("swap", { phase: "blocked" });
    await convertOnStellar(engine, route, owner);
    patch("swap", { phase: "done" });
  }
}
