import { MavnaError } from "@mavna/core";
import { encodeStellarDestination } from "./abi.js";

/**
 * The transfer itself, on the EVM side.
 *
 * Gas is paid inline by the token service; the gas service is never called
 * directly for a transfer. The dangerous part is that paying NOTHING is not an
 * error. Axelar's own source reads:
 *
 *     if (gasValue > 0) { _payGas(hubAddress, payload, gasValue); }
 *     gateway.callContract(ITS_HUB_CHAIN_NAME, hubAddress, payload);
 *
 * The message goes out either way. A transfer sent with no gas is emitted,
 * accepted, and then sits there with the user's tokens already taken and nothing
 * to pay for delivery. That is the easiest way to lose funds on this rail, so a
 * gas value of zero cannot be expressed here: it is a required argument and a
 * non-positive one throws before anything is built.
 */

/**
 * The six-argument form, which is the only portable one.
 *
 * There is a shorter four-argument `interchainTransfer` in the newest token
 * service and it is what Axelar's documentation shows. Its selector is absent
 * from the implementation deployed on Ethereum, Base, Avalanche, Sepolia and Base
 * Sepolia, which all still run 2.1.1; calling it there hits the fallback rather
 * than the function. Checked against the deployed bytecode rather than the docs.
 *
 * The six-argument form exists on every version, and it has a second advantage
 * here: the gas value is an argument in its own right rather than being implied
 * by `msg.value`, so it can be stated, checked, and shown to a user.
 */
export const INTERCHAIN_TOKEN_SERVICE_ABI = [
  {
    type: "function",
    name: "interchainTransfer",
    stateMutability: "payable",
    inputs: [
      { name: "tokenId", type: "bytes32" },
      { name: "destinationChain", type: "string" },
      { name: "destinationAddress", type: "bytes" },
      { name: "amount", type: "uint256" },
      { name: "metadata", type: "bytes" },
      { name: "gasValue", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Just enough ERC-20 for the approval and for a caller to check it is needed. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Empty metadata, meaning a plain transfer of value and nothing else.
 *
 * Anything four bytes or longer is read as a version followed by a payload for a
 * contract on the far side. A user moving money is not calling a contract, so
 * this stays empty and the token lands with the recipient rather than being
 * handed to something to execute.
 */
const NO_METADATA = "0x";

export interface TransferParams {
  readonly tokenService: string;
  readonly tokenId: string;
  /** Axelar's own name for the Stellar chain, resolved at runtime. Never typed in. */
  readonly destinationChain: string;
  /** A Stellar account or contract address. */
  readonly destination: string;
  readonly amount: bigint;
  /**
   * What to pay for delivery, in the sending chain's own currency.
   *
   * Required, and required to be positive. There is no default and no way to omit
   * it, because the contract treats zero as "skip payment" and sends the message
   * regardless.
   */
  readonly gasValue: bigint;
  /** For the sentence shown to the user. */
  readonly symbol: string;
  readonly decimals: number;
}

export interface TransferCall {
  readonly contract: string;
  readonly functionName: "interchainTransfer";
  readonly args: readonly [
    tokenId: string,
    destinationChain: string,
    destinationAddress: string,
    amount: bigint,
    metadata: string,
    gasValue: bigint,
  ];
  /** Native currency to send with the call. Equal to the gas value, always. */
  readonly value: bigint;
  readonly describes: string;
}

export function buildInterchainTransfer(params: TransferParams): TransferCall {
  if (params.amount <= 0n) {
    throw new MavnaError("Refusing to send a non-positive amount.", { retryable: false });
  }
  if (params.gasValue <= 0n) {
    throw new MavnaError(
      "Refusing to send an interchain transfer with no delivery payment. Axelar emits " +
        "the message anyway when the gas value is zero, which takes the tokens and " +
        "leaves nothing to pay for delivering them.",
      { retryable: false },
    );
  }
  if (params.destinationChain.length === 0) {
    throw new MavnaError(
      "Refusing to send without a destination chain name. Axelar's names are versioned " +
        "and an empty or stale one is rejected only after the tokens have gone.",
      { retryable: false },
    );
  }

  // Validates the address before encoding a byte of it.
  const destination = encodeStellarDestination(params.destination);

  return {
    contract: params.tokenService,
    functionName: "interchainTransfer",
    args: [
      params.tokenId,
      params.destinationChain,
      destination,
      params.amount,
      NO_METADATA,
      params.gasValue,
    ],
    // The contract forwards exactly `gasValue` to the gas service and keeps no
    // change, so sending more than that leaves the surplus in the contract.
    value: params.gasValue,
    describes:
      `Send ${readable(params.amount, params.decimals)} ${params.symbol} to ` +
      `${params.destination} on Stellar, through Axelar, including the cost of delivery.`,
  };
}

export interface ApprovalCall {
  readonly contract: string;
  readonly functionName: "approve";
  readonly args: readonly [spender: string, amount: bigint];
  readonly describes: string;
}

/**
 * The approval, for the tokens that need one.
 *
 * The spender is the token SERVICE and not the token manager, which is the
 * counter-intuitive part and the one worth being sure about. The service
 * delegatecalls its token handler, so the handler's `transferFrom` runs as the
 * service and the allowance is read against the service's address. The tokens
 * still end up in the token manager. Approving the manager instead leaves the
 * transfer reverting with the user's gas spent.
 *
 * The allowance is for exactly this transfer, never unlimited. A standing
 * infinite claim on someone's balance is convenient once and then sits there.
 */
export function buildApproval(params: {
  readonly token: string;
  readonly spender: string;
  readonly amount: bigint;
  readonly symbol: string;
  readonly decimals: number;
}): ApprovalCall {
  if (params.amount <= 0n) {
    throw new MavnaError("Refusing to approve a non-positive amount.", { retryable: false });
  }
  return {
    contract: params.token,
    functionName: "approve",
    args: [params.spender, params.amount],
    describes:
      `Let the transfer service move ${readable(params.amount, params.decimals)} ` +
      `${params.symbol} from your wallet, once. This does not send anything on its own.`,
  };
}

/** An integer amount as a person reads it, without going through a float. */
export function readable(baseUnits: bigint, decimals: number): string {
  if (decimals <= 0) return baseUnits.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}
