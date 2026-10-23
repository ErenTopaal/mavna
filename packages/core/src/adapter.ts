import type { StepPhase } from "./execution.js";
import type { Amount, Asset } from "./money.js";
import type { Route, RouteRejection, TrustModel } from "./route.js";

/**
 * Stands in for the sending wallet's address in a payload that has to name it,
 * such as a refund recipient. The wallet substitutes the connected address
 * before signing, because the SDK is never told it.
 */
export const SENDER_ADDRESS = "mavna:sender" as const;

/**
 * What a rail must provide.
 *
 * Adding a rail must require zero changes outside its own package. That is the
 * whole point of this interface, and it is why nothing here mentions a specific
 * bridge, a specific chain, or a specific SDK.
 */

export interface QuoteRequest {
  readonly from: Asset;
  readonly to: Asset;
  readonly sends: Amount;
  /** Where the value ends up. Validated by the adapter for its own rules. */
  readonly destination: string;
  /**
   * The user's tolerance, in basis points. Their exposure is bounded by a number
   * they chose; unbounded slippage is not acceptable on any path.
   */
  readonly maxSlippageBps: number;
  /**
   * The source chain as the user knows it (for example "Codex"), for a decline
   * to name it. A rail that has no name of its own for the chain says "that
   * chain" without it, never the id.
   */
  readonly fromChainName?: string | undefined;
}

/**
 * How a payload should be read. One per chain family, because they share nothing.
 *
 * `solana-instruction` rather than a whole message: a complete Solana message
 * needs a fee payer and a recent blockhash, both of which belong to the wallet
 * and go stale in about a minute. Handing over the instruction lets the wallet
 * compose and price the transaction the way it already knows how.
 */
export type TransactionFormat =
  | "stellar-xdr"
  | "evm-tx"
  | "solana-instruction"
  | "starknet-invoke"
  | "cosmos-msg";

/**
 * A check that decides whether a transaction is needed at all.
 *
 * Token approvals are the case this exists for. A rail that moves an ERC-20 out
 * of a user's wallet needs a standing allowance first, but only when the wallet
 * does not already have one, and asking a user to sign an approval they do not
 * need costs them gas for nothing.
 *
 * The SDK cannot answer the question itself: reading an allowance needs a node on
 * the source chain, and the caller is the one holding a wallet already connected
 * to it. So the condition is stated in a form the caller can evaluate, rather
 * than the transaction being emitted unconditionally and the waste being someone
 * else's problem.
 */
export interface AllowanceCheck {
  readonly kind: "erc20-allowance";
  /** The token contract that records the allowance. */
  readonly token: string;
  /** Who the allowance must name. Not the recipient of the funds. */
  readonly spender: string;
  /** Skip the transaction when the existing allowance is at least this. */
  readonly atLeastBaseUnits: string;
  /**
   * Also skip it when the existing allowance is exactly this.
   *
   * For clearing an allowance before setting a new one, which Tether's USDT
   * on Ethereum demands: its `approve` reverts when both the current and the
   * new value are non-zero. Clearing is pointless when the allowance is
   * already zero, so that reset says "0" here. A caller that ignores the field
   * only sends a harmless approve of zero over zero.
   */
  readonly skipAlsoWhenExactly?: string;
}

export type UnnecessaryWhen = AllowanceCheck;

/** A transaction the caller must sign. The SDK never signs and never submits. */
export interface UnsignedTransaction {
  readonly chainId: string;
  /** Opaque to the SDK. The caller's wallet knows how to read it. */
  readonly payload: string;
  readonly format: TransactionFormat;
  /** Said in terms that mean something, so consent can be informed. */
  readonly describes: string;
  /**
   * When this can be left unsent, and how the caller checks.
   *
   * Undefined means always send it. Anything else is a condition to evaluate
   * against the source chain first.
   */
  readonly unnecessaryWhen: UnnecessaryWhen | undefined;
  /**
   * Accounts the caller must generate a fresh keypair for and sign with.
   *
   * Solana's burn writes its message into a brand new account, so one exists that
   * is neither the user nor anything we can derive. Carrying the requirement here
   * means a caller learns about it from the type rather than from a failed
   * signature, and it stays empty on every chain that has no such thing.
   *
   * The SDK does not create these. It does not hold keys, ever.
   */
  readonly ephemeralSigners: readonly string[];
}

/**
 * What a caller can tell a rail at build time that a quote never knows.
 *
 * Optional, and most rails need none of it. A rail whose service has to be told
 * where a refund goes before it will hand out a deposit address cannot use the
 * sender stand-in, because the address leaves in a request rather than in a
 * payload the wallet fills in.
 */
export interface BuildContext {
  /** The connected source wallet, when the caller knows it. */
  readonly sender: string | undefined;
}

/**
 * Where a transfer can be found again.
 *
 * All three are first-class lookup keys, which is the largest single
 * differentiator available. The prior art can only resume from a transaction hash
 * or an internal task id, and its own type refuses a deposit address as a key. On
 * Stellar a deposit address plus memo is the natural shape, and a user who closed
 * the tab has their destination address if they have nothing else.
 */
export interface TransferHandle {
  readonly sourceTxHash: string | undefined;
  readonly depositAddress: string | undefined;
  readonly destinationAddress: string | undefined;
  /**
   * Which chain the source transaction is on.
   *
   * Optional, because a user who closed the tab may have nothing but a hash, and
   * refusing to help them is the failure this whole type exists to avoid. An
   * adapter that spans many chains should search when this is absent rather than
   * decline: slower is a fine price for recovering someone's transfer.
   */
  readonly sourceChainId: string | undefined;
}

export interface BridgeAdapter {
  readonly id: string;
  readonly trustModel: TrustModel;

  /** Chains this rail can move value from, resolved rather than hardcoded. */
  supportedChains(): Promise<readonly string[]>;

  /**
   * Quote, or explain why not.
   *
   * Must resolve within the racing timeout or the routing engine drops it: one
   * slow rail must never hold up the others. Returning a rejection is a normal
   * outcome and is preferred to throwing, because the reason is shown to a user.
   */
  quote(request: QuoteRequest): Promise<Route | RouteRejection>;

  /** Build, never sign, never submit. */
  buildTransactions(route: Route, context?: BuildContext): Promise<readonly UnsignedTransaction[]>;

  /** Where this transfer stands now. */
  status(handle: TransferHandle): Promise<StepPhase>;

  /**
   * Recover a stalled transfer from inside the product.
   *
   * A recoverable failure must be recoverable here, without the user needing a
   * third-party explorer, documentation or support.
   */
  recover?(handle: TransferHandle): Promise<readonly UnsignedTransaction[]>;

  /**
   * A compose route beside the plain one: the same send, delivered to a contract
   * that converts on arrival, so the conversion is not a user prompt. Undefined
   * when this rail has no such contract on this network, so a rail without one
   * adds nothing to the rejected list; a rejection when it has one but cannot
   * serve this request. Its status comes back through `status` like any other.
   */
  quoteCompose?(request: ComposeQuoteRequest): Promise<Route | RouteRejection | undefined>;
}

/**
 * A compose quote. `to` is what the user wants to end up holding; `plain` is
 * the rail's own route for the same send, delivering `arriving`.
 */
export interface ComposeQuoteRequest extends QuoteRequest {
  readonly plain: Route;
  /** What the rail delivers on Stellar, and the contract id venues trade it under. */
  readonly arriving: Asset;
  readonly arrivingContract: string;
  /** The contract id of `to`. */
  readonly wantedContract: string;
  /**
   * The integrator's cut, taken on-chain by the converting contract and so
   * collected on every venue. Absent means none.
   */
  readonly integratorFee?:
    | { readonly bps: number; readonly recipient: string; readonly recipientName: string }
    | undefined;
}

/** How long a single adapter gets before the race moves on without it. */
export const ADAPTER_QUOTE_TIMEOUT_MS = 3000;

export function isRejection(result: Route | RouteRejection): result is RouteRejection {
  return "reason" in result;
}

/**
 * The Mavna Arrival Contract deployed on each network, by id. Every rail
 * refuses it as a plain destination by default; the LayerZero rail also
 * converts through it. None on mainnet yet.
 */
export const ARRIVAL_CONTRACT_IDS: {
  readonly testnet: string;
  readonly mainnet: string | undefined;
} = {
  testnet: "CDHHLRLKWNRMRQ2PPT7CNMWG3OF4XOIQ2QTDEBMZ25CJQCLQK7Y5PMPD",
  mainnet: undefined,
};

/**
 * Why a plain transfer to a Mavna Arrival Contract is refused, or undefined
 * when the destination is not one.
 *
 * The contract only acts on what LayerZero hands it with instructions. Anything
 * sent to it any other way lands in a contract with no way to send it on, so
 * every rail declines it, and says so in words the person can act on.
 */
export function arrivalContractRefusal(
  destination: string,
  arrivalContracts: readonly (string | undefined)[],
): string | undefined {
  if (!arrivalContracts.some((contract) => contract !== undefined && contract === destination)) {
    return undefined;
  }
  return (
    "That address is the Mavna Arrival Contract, which only accepts conversions sent to it " +
    "on your behalf. A plain transfer to it would be stuck there. Send to your own Stellar " +
    "address instead."
  );
}
