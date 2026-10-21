/*
 * What differs between rails once a route is chosen.
 *
 * Quoting already races every rail; executing used to assume Circle. Each rail
 * builds its own transactions, reports its own progress and needs its own
 * steps on the flight screen, so those three questions are answered here from
 * the route itself, and the runner never has to know which rail it holds.
 */
import type { BridgeAdapter, Route, StepPhase, TransferHandle } from "@mavna/core";
import { inspectDestination, type RpcClient } from "@mavna/stellar";
import { Asset as StellarAsset } from "@stellar/stellar-sdk";
import type { Engine } from "./engine";
import { amountValue, fmt } from "./format";
import { remedyNote } from "./found";
import { railDisplay } from "./quote";
import type { SponsorClient, SponsorSettle } from "./sponsor";
import type { FlightStep, Patch } from "./transfer";

export type StepTemplate = Omit<FlightStep, "phase">;

/**
 * How long Circle's attestation should take for this route, as a sentence.
 * The wait is the source chain's finality, from seconds to hours, and the
 * adapter's bridge step carries it.
 */
export function attestationWait(route: Route): string {
  const phrase = waitPhrase(route.steps.find((s) => s.kind === "bridge")?.estimatedSeconds ?? 0);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/** A wait in the largest unit that reads naturally: "about 20 minutes". */
export function waitPhrase(seconds: number): string {
  if (seconds < 90) return "about a minute";
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}

/** The adapter that quoted a route, which is the only one that can build it. */
export function adapterFor(engine: Pick<Engine, "adapters">, route: Route): BridgeAdapter {
  const adapter = engine.adapters.find((a) => a.id === route.source);
  if (adapter === undefined) {
    throw new Error(
      `This route came from ${route.source}, which this page does not run. Nothing has been sent.`,
    );
  }
  return adapter;
}

/**
 * The flight steps for a route, in the order they happen.
 *
 * Circle's are the ones the flight screen was designed around: attest, then the
 * sponsor mints, with the account prepared at the last moment. LayerZero and
 * Axelar deliver on their own and cannot deliver to an account that does not
 * exist, so the account is prepared before the send and there is no attest step.
 */
export function stepsFor(
  route: Route,
  reserveFunding: "sponsor" | "self" = "sponsor",
): readonly StepTemplate[] {
  const newAccount = route.steps.some((s) => s.kind === "prepare-account");
  const converts = route.steps.some((s) => s.kind === "swap");
  const chainName = route.fromChain.name;
  const symbol = route.sends.asset.symbol;
  const amount = fmt(amountValue(route.sends));
  const rail = railDisplay(route.source);
  const circle = route.source === "cctp";

  const settle: StepTemplate = {
    id: "settle",
    label: "Approve the repayment first",
    note: "Repays whoever fronted the account reserve.",
    user: true,
    actor: "Your wallet",
  };
  const selfFunded = reserveFunding === "self";
  const prepare: StepTemplate = {
    id: "prepare",
    label: "Set the account up",
    note: selfFunded
      ? "Approve in your Stellar wallet. The reserve comes from this account's own XLM."
      : "Approve in your Stellar wallet. Costs you nothing.",
    user: true,
    actor: "Your wallet",
  };
  const approve: StepTemplate = {
    id: "approve",
    label: `Allow ${rail} to move your ${symbol}`,
    note: `Confirm in your wallet: approve ${amount} ${symbol} on ${chainName}.`,
    user: true,
    actor: "Your wallet",
  };
  const send: StepTemplate = {
    id: "burn",
    label: `Send from ${chainName}`,
    note: "Waiting for inclusion.",
    user: true,
    actor: "Your wallet",
  };
  const swapTo = route.steps.find((s) => s.kind === "swap")?.to.asset;
  const swap: StepTemplate = {
    id: "swap",
    label: `Convert to ${swapTo?.symbol ?? "XLM"} on Stellar`,
    note: "Approve the conversion in your Stellar wallet.",
    user: true,
    actor: "Your wallet",
  };
  // Converting into anything but XLM needs that trustline too; an account
  // paying its own way opens it before the send, as its own signature.
  const holds = selfFunded && swapTo !== undefined && swapTo.id !== "native";
  const hold: StepTemplate = {
    id: "hold",
    label: `Let the account hold ${swapTo?.symbol ?? ""}`,
    note: "Approve in your Stellar wallet. The reserve comes from this account's own XLM.",
    user: true,
    actor: "Your wallet",
  };

  // An account paying its own reserve borrows nothing, so there is no
  // repayment to sign and no reason to wait for the money before preparing.
  if (circle && selfFunded) {
    return [
      ...(newAccount ? [prepare] : []),
      ...(holds ? [hold] : []),
      approve,
      send,
      {
        id: "attest",
        label: "Circle attests the transfer",
        // the account's own wallet signs the delivery, and only an open page can ask it
        note:
          `${attestationWait(route)} Your wallet signs the delivery next, so closing this page pauses it; ` +
          "you can finish it under Activity.",
        user: false,
        actor: "Circle",
      },
      {
        // no sponsor pays for it, so the account signs and pays the mint itself
        id: "deliver",
        label: "Deliver on Stellar",
        note: "Approve in your Stellar wallet. The fee comes from this account's own XLM.",
        user: true,
        actor: "Your wallet",
      },
      ...(converts ? [swap] : []),
    ];
  }

  if (circle) {
    return [
      ...(newAccount ? [settle] : []),
      approve,
      send,
      {
        id: "attest",
        label: "Circle attests the transfer",
        // safe to close only once the sponsor says it is watching the burn
        note: `${attestationWait(route)} Keep this page open until the sponsor has the transfer.`,
        user: false,
        actor: "Circle",
      },
      ...(newAccount ? [prepare] : []),
      {
        id: "deliver",
        label: "Deliver on Stellar",
        note: "Delivered on Stellar.",
        user: false,
        actor: "Mavna",
      },
      ...(converts ? [swap] : []),
    ];
  }

  const approves = route.steps.some((s) => s.kind === "approve-source");
  const compose = route.compose;
  return [
    ...(newAccount ? (selfFunded ? [prepare] : [settle, prepare]) : []),
    ...(holds ? [hold] : []),
    ...(approves ? [approve] : []),
    send,
    {
      id: "deliver",
      label:
        compose === undefined
          ? `${rail} delivers on Stellar`
          : `${rail} delivers to the Arrival Contract`,
      note: "Usually a few minutes.",
      user: false,
      actor: rail,
    },
    ...(converts ? [swap] : []),
    ...(compose === undefined
      ? []
      : [
          {
            id: "convert",
            label: `Converted to ${compose.wanted.symbol} on arrival`,
            note: compose.walletNote,
            user: false,
            actor: "Arrival Contract",
          },
        ]),
  ];
}

/**
 * Why the destination cannot take what this route delivers, or undefined when
 * it can.
 *
 * A route that sets the account up has its own lane for this. One that does not
 * is trusting the rail's quote that the account is ready, and a rail that never
 * looked would have the user sign away funds that cannot land. So the widget
 * looks for itself, on Stellar, before the first signature.
 */
export async function destinationBlocker(
  rpc: RpcClient,
  route: Route,
): Promise<string | undefined> {
  // a route that sets the account up handles a missing account or trustline,
  // but nothing it does makes an address that cannot receive at all receive
  const setsUp = route.steps.some((s) => s.kind === "prepare-account");
  const delivers = route.deliveredAtLeast.asset;
  const [code, issuer] = delivers.id.split(":");
  let asset: StellarAsset;
  if (delivers.id === "native") {
    asset = StellarAsset.native();
  } else if (code !== undefined && issuer !== undefined && issuer !== "") {
    asset = new StellarAsset(code, issuer);
  } else {
    return `This route delivers ${delivers.symbol} as ${delivers.id}, which is not a Stellar asset this page can check the destination for.`;
  }

  // held to the most the route says lands in that asset, so a trustline with
  // some room under its limit but not enough is refused before anything is sent
  const lands = [
    route.deliveredAtLeast,
    ...route.steps.filter((s) => s.kind === "bridge").map((s) => s.to),
  ]
    .filter((amount) => amount.asset.id === delivers.id)
    .reduce(
      (most, amount) => (BigInt(amount.baseUnits) > most ? BigInt(amount.baseUnits) : most),
      0n,
    );
  const { lane } = await inspectDestination(rpc, route.destination, asset, {
    amountStroops: lands,
  });
  if (setsUp) return lane.kind === "unusable" ? lane.reason : undefined;
  switch (lane.kind) {
    case "ready":
    case "contract-ready":
      return undefined;
    case "needs-account":
      return (
        "That Stellar account does not exist yet, and this route cannot set it up, so the " +
        `${delivers.symbol} would not arrive. Choose a route that sets the account up.`
      );
    case "needs-trustline":
      return (
        `That Stellar account cannot hold ${delivers.symbol} yet, and this route cannot add ` +
        "that. Add it in the account's wallet, or choose a route that sets the account up."
      );
    case "unusable":
      return lane.reason;
  }
}

export interface TrackOptions {
  /** The flight step the delivery shows on. */
  readonly stepId?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /** Aborted when nobody is left to show progress to, which ends the watch. */
  readonly signal?: AbortSignal;
}

export type Tracked =
  | { readonly outcome: "terminal"; readonly phase: StepPhase }
  | {
      readonly outcome: "timed-out";
      readonly last: StepPhase | undefined;
      /** The last status read that failed, when the rail could not be asked. */
      readonly error: string | undefined;
    }
  | { readonly outcome: "stopped"; readonly last: StepPhase | undefined };

/** Wait, ending early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** What to tell someone whose page stopped watching a transfer still in flight. */
export const STOPPED_WATCHING =
  "This page stopped watching the transfer. Your funds are not lost: find the " +
  "transfer under Activity to check on it.";

/** What to tell someone whose transfer outlived the page's patience. */
export const STILL_MOVING =
  "This is taking longer than this page waits. Your funds are not lost: find the " +
  "transfer under Activity to check on it.";

/** A terminal phase that is not a delivery, said as one sentence with what to do. */
export function endedNote(phase: StepPhase): string {
  switch (phase.phase) {
    case "failed":
      return `${phase.cause} ${remedyNote(phase.remedy)}`;
    case "refunded":
      return `Returned to ${phase.to}. ${fmt(amountValue(phase.returned))} ${phase.returned.asset.symbol} came back.`;
    case "partial":
      return `Part of this arrived: ${fmt(amountValue(phase.received))} of ${fmt(amountValue(phase.expected))} ${phase.expected.asset.symbol}. ${remedyNote(phase.remedy)}`;
    case "delivered-as-came":
      return `Delivered as it came, not converted: ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived. ${phase.because}`;
    case "delivered-unverified":
      return `${phase.because} The rail records it as delivered on Stellar; what arrived is not confirmed here. Check the linked transaction.`;
    default:
      return "";
  }
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Watch a rail deliver, until it ends or the page stops waiting.
 *
 * A status read that fails is shown on the step and asked again rather than
 * failing the transfer: the money is already in flight, and an indexer that
 * did not answer once says nothing about it. Pending carries no evidence of
 * anything wrong, so it is never escalated here; stalled carries the rail's
 * own remedy, which is the note.
 */
export async function trackDelivery(
  adapter: BridgeAdapter,
  handle: TransferHandle,
  patch: Patch,
  options: TrackOptions = {},
): Promise<Tracked> {
  const stepId = options.stepId ?? "deliver";
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  // read through a call, so the check inside the loop is not narrowed away by
  // the one before it: the signal changes while this function awaits
  const aborted = (): boolean => signal?.aborted === true;

  const started = now();
  let last: StepPhase | undefined;
  let error: string | undefined;
  if (aborted()) return { outcome: "stopped", last };
  patch(stepId, { phase: "pending" });

  while (now() - started < timeoutMs) {
    if (aborted()) return { outcome: "stopped", last };
    let phase: StepPhase | undefined;
    try {
      phase = await adapter.status(handle);
      error = undefined;
    } catch (cause) {
      error = message(cause);
      patch(stepId, {
        note: `Could not check on the transfer just now (${error}). Checking again.`,
      });
    }

    if (phase !== undefined) {
      last = phase;
      switch (phase.phase) {
        case "done":
          patch(stepId, {
            phase: "done",
            note: `Delivered on Stellar. ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived.`,
            ref: shortHash(phase.ref.txHash),
            refUrl: phase.ref.explorerUrl,
          });
          return { outcome: "terminal", phase };
        case "failed":
        case "refunded":
        case "partial":
          patch(stepId, { phase: "failed", note: endedNote(phase) });
          return { outcome: "terminal", phase };
        // an ending to read, with the transaction to check: neither a success nor a failure
        case "delivered-unverified":
          patch(stepId, {
            phase: "done",
            note: endedNote(phase),
            ref: shortHash(phase.ref.txHash),
            refUrl: phase.ref.explorerUrl,
          });
          return { outcome: "terminal", phase };
        // a compose route: the rail has delivered, and the conversion is its own step
        case "delivered-conversion-pending":
          patch(stepId, { phase: "done", note: "Delivered to the Arrival Contract on Stellar." });
          patch("convert", {
            phase: "pending",
            note: "Converting now. If this takes long, Activity can finish it, and only once.",
          });
          break;
        case "delivered-and-converted":
          patch(stepId, { phase: "done", note: "Delivered to the Arrival Contract on Stellar." });
          patch("convert", {
            phase: "done",
            note: `Converted on arrival. ${fmt(amountValue(phase.received))} ${phase.received.asset.symbol} arrived.`,
            ref: shortHash(phase.ref.txHash),
            refUrl: phase.ref.explorerUrl,
          });
          return { outcome: "terminal", phase };
        case "delivered-as-came":
          // the money arrived, so the delivery is done; the conversion is what did not happen
          patch(stepId, { phase: "done", note: "Delivered to the Arrival Contract on Stellar." });
          patch("convert", { phase: "failed", note: endedNote(phase) });
          return { outcome: "terminal", phase };
        case "stalled":
          patch(stepId, { phase: "pending", note: remedyNote(phase.remedy) });
          break;
        default:
          break;
      }
    }

    if (now() - started >= timeoutMs) break;
    await wait(intervalMs, signal);
  }

  patch(stepId, { note: STILL_MOVING });
  return { outcome: "timed-out", last, error };
}

export interface LookupAnswer {
  readonly phase: StepPhase;
  /** The adapters this answer speaks for. */
  readonly rails: readonly string[];
  /** Rails that could not be asked, with why. Shown, never dropped. */
  readonly errors: ReadonlyArray<{ readonly source: string; readonly message: string }>;
}

/**
 * Ask every rail that could hold this transfer, and take the first real answer.
 *
 * A hash does not say which rail carried it, and each rail reads a hash it does
 * not know as pending (no evidence either way) or idle (nothing to search on).
 * So pending and idle are not answers that end the search: anything else is,
 * and whichever rail says it first is the one that carried the transfer.
 */
export async function lookupAcross(
  adapters: readonly BridgeAdapter[],
  handle: TransferHandle,
  options: { readonly timeoutMs?: number } = {},
): Promise<LookupAnswer> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  // One rail whose indexer accepts the connection and never answers must not
  // hold the whole lookup, so each question gets its own bound.
  const bounded = <T>(asked: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Did not answer in time.")), timeoutMs);
    });
    return Promise.race([asked, late]).finally(() => clearTimeout(timer));
  };
  const errors: Array<{ source: string; message: string }> = [];
  const chain = handle.sourceChainId;

  const asked = (
    await Promise.all(
      adapters.map(async (adapter) => {
        if (chain === undefined) return adapter;
        try {
          return (await bounded(adapter.supportedChains())).includes(chain) ? adapter : undefined;
        } catch (cause) {
          errors.push({ source: adapter.id, message: message(cause) });
          return undefined;
        }
      }),
    )
  ).filter((a): a is BridgeAdapter => a !== undefined);

  return new Promise((resolve, reject) => {
    const pending: Array<{ source: string; phase: StepPhase }> = [];
    const idle: string[] = [];
    let answered = false;
    let left = asked.length;

    const finish = (): void => {
      if (answered) return;
      const first = pending[0];
      if (first !== undefined) {
        resolve({ phase: first.phase, rails: pending.map((p) => p.source), errors });
      } else if (idle.length > 0) {
        resolve({ phase: { phase: "idle" }, rails: idle, errors });
      } else if (errors.length > 0) {
        reject(
          new Error(
            errors
              .map((e) => `${railDisplay(e.source)}: ${e.message.replace(/\.$/, "")}.`)
              .join(" "),
          ),
        );
      } else {
        reject(
          new Error(
            chain === undefined
              ? "No rail is running on this page to look the transfer up with."
              : `No rail this page runs carries transfers from ${chain}.`,
          ),
        );
      }
    };

    if (left === 0) finish();
    for (const adapter of asked) {
      bounded(adapter.status(handle))
        .then(
          (phase) => {
            if (phase.phase === "pending") pending.push({ source: adapter.id, phase });
            else if (phase.phase === "idle") idle.push(adapter.id);
            else if (!answered) {
              answered = true;
              resolve({ phase, rails: [adapter.id], errors });
            }
          },
          (cause: unknown) => {
            errors.push({ source: adapter.id, message: message(cause) });
          },
        )
        .finally(() => {
          left -= 1;
          if (left === 0) finish();
        });
    }
  });
}

export interface SettleOptions {
  readonly attempts?: number;
  /** Past the sponsor's thirty seconds between asks for one account. */
  readonly intervalMs?: number;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Ask the sponsor to submit the repayment it holds, until it does or will not.
 *
 * The sponsor settles only once the arrived funds cover the repayment, which a
 * rail's indexer can report a little before Stellar's own node shows them, so a
 * retryable no is asked again. Bounded, because the funds have already arrived
 * and the person should not be kept waiting on the sponsor's bookkeeping.
 */
export async function pollSettlement(
  sponsor: Pick<SponsorClient, "settle">,
  destination: string,
  options: SettleOptions = {},
): Promise<SponsorSettle> {
  const attempts = options.attempts ?? 6;
  const intervalMs = options.intervalMs ?? 31_000;
  const wait = options.wait ?? sleep;

  let result: SponsorSettle = { settled: false, settlementRetryable: true };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    result = await sponsor.settle(destination);
    if (result.settled || result.held === false || result.settlementRetryable !== true) {
      return result;
    }
  }
  return result;
}

/** The deliver step's last word once the repayment has been asked for. */
export function settleNote(result: SponsorSettle): string {
  if (result.settled) return "Delivered, and the deposit repaid itself from the arrival.";
  if (result.held === false) {
    return "Delivered on Stellar. The sponsor holds no repayment for this account, so none was taken.";
  }
  if (result.settlementRetryable === true) {
    return "Delivered on Stellar. Repaying the account deposit has not gone through yet, and the sponsor still holds the signed repayment.";
  }
  return "Delivered on Stellar. The deposit repayment could not be submitted, so nothing was taken from what arrived.";
}
