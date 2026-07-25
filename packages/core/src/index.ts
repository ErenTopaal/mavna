export type {
  AllowanceCheck,
  BridgeAdapter,
  QuoteRequest,
  TransactionFormat,
  TransferHandle,
  UnnecessaryWhen,
  UnsignedTransaction,
} from "./adapter.js";
export { ADAPTER_QUOTE_TIMEOUT_MS, isRejection } from "./adapter.js";
export type { Blocked, OnChainRef, Remedy, StepPhase, TerminalPhase } from "./execution.js";
export { canAdvance, isTerminal, PHASE_ORDER, TERMINAL_PHASES } from "./execution.js";
export type { Amount, Asset, ChainRef, Fee, FeeKind, FeeRecipient } from "./money.js";
export { amountOf, sameAsset } from "./money.js";
export { ReferenceAdapter, referenceRequest } from "./reference-adapter.js";
export type {
  Route,
  RouteRanking,
  RouteRejection,
  RouteSet,
  Step,
  StepExecution,
  StepQuote,
  TrustModel,
} from "./route.js";
export { pairKey, rankRoutes } from "./route.js";
export {
  baseUnits,
  basisPoints,
  displayText,
  evmAddress,
  futureUnixSeconds,
  parseFrom,
  positiveBaseUnits,
  stellarAddress,
  txHashHex,
} from "./schema.js";

/**
 * Which Stellar network a piece of configuration refers to.
 *
 * Network selection is configuration everywhere in this codebase, never a code
 * path. Nothing may be meaningful on only one network.
 */
export type NetworkId = "testnet" | "mainnet";

/** Base for every error this project raises, so callers can discriminate ours from anyone else's. */
export class MavnaError extends Error {
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MavnaError";
    this.retryable = options.retryable;
  }
}
