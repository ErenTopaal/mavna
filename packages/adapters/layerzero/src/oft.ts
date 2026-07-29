import { MavnaError } from "@mavna/core";
import { classifyAddress } from "@mavna/stellar";
import { StrKey } from "@stellar/stellar-sdk";
import { encodePacked } from "viem";
import { readableAmount } from "./config.js";

/**
 * The OFT call, on the EVM side of a transfer into Stellar.
 *
 * Every signature, struct and constant here was read out of LayerZero's own
 * published Solidity rather than from documentation or memory:
 * `packages/layerzero-v2/evm/oapp/contracts/oft/interfaces/IOFT.sol` for the
 * calls, `.../oapp/libs/OptionsBuilder.sol` and
 * `.../protocol/contracts/messagelib/libs/ExecutorOptions.sol` for the option
 * bytes, `.../protocol/contracts/interfaces/IMessageLibManager.sol` and
 * `.../messagelib/contracts/uln/UlnBase.sol` for the DVN configuration.
 *
 * The option encoding is additionally checked against a live deployment: the
 * bytes this file produces for 500,000 gas are byte for byte the bytes Tether's
 * USDT0 adapter has enforced on the Stellar mainnet pathway since it shipped.
 */

/** OFTCore.SEND. The message type enforced options and quoting are keyed by. */
export const MSG_TYPE_SEND = 1;
/** OFTCore.SEND_AND_CALL. Not used here; a compose message is a different product. */
export const MSG_TYPE_SEND_AND_CALL = 2;

/** OptionsBuilder.TYPE_3. Legacy types 1 and 2 are not accepted by the ULN. */
const OPTIONS_TYPE_3 = 3;
/** ExecutorOptions.WORKER_ID. The DVN worker is 2 and is not what we are pricing. */
const EXECUTOR_WORKER_ID = 1;
/** ExecutorOptions.OPTION_TYPE_LZRECEIVE. */
const OPTION_TYPE_LZRECEIVE = 1;

/**
 * The executor option that pays for `lzReceive` on the far side.
 *
 * Layout, from `ExecutorOptions`: the whole blob opens with one `uint16` type
 * marker, then each option is `[worker id][size][type][payload]` where `size`
 * counts the payload plus the single type byte, and NOT the worker id or the
 * size field itself. Getting that `+1` wrong does not fail quietly: the ULN's
 * own decoder insists the cursor lands exactly on the end of the blob.
 *
 * `value` is omitted entirely when zero rather than encoded as sixteen zero
 * bytes, because the decoder accepts only a 16 or 32 byte payload and treats the
 * longer form as a native drop the executor would have to fund.
 */
export function executorLzReceiveOption(gas: bigint, value = 0n): `0x${string}` {
  if (gas <= 0n) {
    throw new MavnaError("An lzReceive option with no gas pays for no delivery.", {
      retryable: false,
    });
  }
  if (value === 0n) {
    return encodePacked(
      ["uint16", "uint8", "uint16", "uint8", "uint128"],
      [OPTIONS_TYPE_3, EXECUTOR_WORKER_ID, 17, OPTION_TYPE_LZRECEIVE, gas],
    );
  }
  return encodePacked(
    ["uint16", "uint8", "uint16", "uint8", "uint128", "uint128"],
    [OPTIONS_TYPE_3, EXECUTOR_WORKER_ID, 33, OPTION_TYPE_LZRECEIVE, gas, value],
  );
}

/**
 * A Stellar destination as the 32 bytes a LayerZero message can carry.
 *
 * Both address forms reduce to the same 32 bytes, and the Stellar side puts them
 * back together by asking the ledger: `resolve_address` in LayerZero's
 * `oft-core-stellar-contracts` builds a contract address from the payload, and
 * uses it if a contract exists there, otherwise treats the payload as an account
 * public key. So nothing about which kind of address this is travels with the
 * message, and nothing needs to.
 *
 * A muxed address cannot be sent. It is an account plus a 64-bit sub-account id,
 * which is 40 bytes, and there is nowhere in the message to put the extra eight.
 * Truncating to the underlying account would deliver real money to a custodian
 * with no idea which customer it belongs to, so this refuses instead.
 */
export function stellarRecipientToBytes32(address: string): `0x${string}` {
  const classified = classifyAddress(address);

  if (classified.kind === "muxed") {
    throw new MavnaError(
      "LayerZero carries a 32-byte recipient, and a muxed address does not fit in one. " +
        "Sending to the account it wraps would arrive with no way to tell whose money it is. " +
        "Use the underlying G address and carry the customer id yourself.",
      { retryable: false },
    );
  }
  if (!classified.canReceive) {
    throw new MavnaError(`${classified.kind} addresses cannot receive a payment on Stellar.`, {
      retryable: false,
    });
  }

  const raw =
    classified.kind === "contract"
      ? StrKey.decodeContract(address)
      : StrKey.decodeEd25519PublicKey(address);

  return `0x${Buffer.from(raw).toString("hex")}`;
}

/** The Stellar contract a 32-byte peer refers to. */
export function bytes32ToStellarContract(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (hex.length !== 64) {
    throw new MavnaError(`A peer must be 32 bytes; this one is ${hex.length / 2}.`, {
      retryable: false,
    });
  }
  return StrKey.encodeContract(Buffer.from(hex, "hex"));
}

/** True when a bytes32 read back from a contract is unset. */
export function isZeroBytes32(value: string): boolean {
  return /^0x0{64}$/.test(value);
}

export interface OftMessage {
  /** The recipient, as the 32 bytes the wire carries. */
  readonly sendTo: `0x${string}`;
  /** The amount, in SHARED decimals. Not the source's and not Stellar's. */
  readonly amountSd: bigint;
  readonly hasCompose: boolean;
}

/**
 * The message an OFT send actually puts on the wire.
 *
 * Layout, from LayerZero's `OFTMsgCodec`: 32 bytes of recipient, then an eight
 * byte big-endian amount in shared decimals, then optionally a 32 byte composer
 * and a payload. Reading it is how the amount that will land is known exactly,
 * rather than inferred from what was sent: the amount here is post-fee and
 * post-dust, because it is the number the destination will credit.
 */
export function decodeOftMessage(payload: string): OftMessage {
  const hex = payload.startsWith("0x") ? payload.slice(2) : payload;
  if (hex.length < 80) {
    throw new MavnaError(
      `An OFT message is at least 40 bytes; this payload is ${Math.floor(hex.length / 2)}.`,
      { retryable: false },
    );
  }
  return {
    sendTo: `0x${hex.slice(0, 64)}`,
    amountSd: BigInt(`0x${hex.slice(64, 80)}`),
    hasCompose: hex.length > 80,
  };
}

/**
 * The same amount, counted in Stellar's units.
 *
 * Shared decimals are the lowest common denominator across every chain the token
 * lives on, and each side scales into its own. Stellar's seven against a shared
 * six means every amount is ten times larger on arrival, which is exactly the
 * kind of factor that turns 5 USDT into 0.5 if it is done with a number instead
 * of a BigInt.
 */
export function sharedToStellar(amountSd: bigint, decimalsDiff: number): bigint {
  if (decimalsDiff < 0) {
    throw new MavnaError(
      "A Stellar OFT with fewer local decimals than shared decimals would lose precision on " +
        "every transfer. Refusing to quote one.",
      { retryable: false },
    );
  }
  return amountSd * 10n ** BigInt(decimalsDiff);
}

/**
 * A source-chain amount as the destination will count it.
 *
 * Two conversions, in this order and not the other: down into shared decimals,
 * which is where the dust the contract silently truncates is lost, then up into
 * Stellar's. Doing it as one ratio would quote an amount including dust that
 * never leaves the source chain.
 */
export function localToStellar(
  amountLd: bigint,
  localDecimals: number,
  sharedDecimals: number,
  stellarDecimals: number,
): bigint {
  if (localDecimals < sharedDecimals) {
    throw new MavnaError(
      `A token with ${localDecimals} decimals cannot carry ${sharedDecimals} shared decimals.`,
      { retryable: false },
    );
  }
  const amountSd = amountLd / 10n ** BigInt(localDecimals - sharedDecimals);
  return sharedToStellar(amountSd, stellarDecimals - sharedDecimals);
}

/**
 * The same journey back, for turning a promise made in Stellar's units into the
 * floor the source contract will enforce in its own.
 */
export function stellarToLocal(
  amountStellar: bigint,
  localDecimals: number,
  sharedDecimals: number,
  stellarDecimals: number,
): bigint {
  const amountSd = amountStellar / 10n ** BigInt(stellarDecimals - sharedDecimals);
  return amountSd * 10n ** BigInt(localDecimals - sharedDecimals);
}

export interface SendParam {
  readonly dstEid: number;
  readonly to: `0x${string}`;
  readonly amountLD: bigint;
  readonly minAmountLD: bigint;
  readonly extraOptions: `0x${string}`;
  readonly composeMsg: `0x${string}`;
  readonly oftCmd: `0x${string}`;
}

export interface SendParamInputs {
  readonly dstEid: number;
  readonly stellarRecipient: string;
  readonly amount: bigint;
  /** The floor the user has agreed to, already worked out from their slippage. */
  readonly minAmount: bigint;
  /**
   * Extra executor options, or `0x` to let the OApp's own enforced options
   * stand. Never invented: the caller passes what discovery read off the chain.
   */
  readonly extraOptions: `0x${string}`;
}

export function buildSendParam(inputs: SendParamInputs): SendParam {
  if (inputs.amount <= 0n) {
    throw new MavnaError("Refusing to send a non-positive amount.", { retryable: false });
  }
  if (inputs.minAmount > inputs.amount) {
    throw new MavnaError(
      "The minimum to receive is larger than the amount being sent, which can never be met.",
      { retryable: false },
    );
  }

  return {
    dstEid: inputs.dstEid,
    to: stellarRecipientToBytes32(inputs.stellarRecipient),
    amountLD: inputs.amount,
    // Set from the user's own slippage tolerance rather than left at zero. Zero
    // means "accept anything", which on a rail that can charge a fee in transit
    // is an unbounded loss the user never agreed to.
    minAmountLD: inputs.minAmount,
    extraOptions: inputs.extraOptions,
    // No compose message. Delivering tokens and then calling a contract is a
    // different product with a different failure mode, and quoting for one and
    // sending the other is how a transfer lands somewhere unexpected.
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

export interface ApprovalCall {
  /** The ERC-20 contract, which is where an allowance is recorded. */
  readonly contract: string;
  readonly functionName: "approve";
  readonly args: readonly [spender: `0x${string}`, amount: bigint];
  readonly describes: string;
}

/**
 * The approval a locking adapter cannot do without.
 *
 * Whether it is needed is a question for the contract, never for us.
 * `OFTAdapter.approvalRequired()` returns true because its `_debit` calls
 * `innerToken.safeTransferFrom(_from, address(this), amount)`, while plain
 * `OFT.approvalRequired()` returns false because its `_debit` burns the sender's
 * own balance and no allowance is involved. Both are `virtual`, and USDT0 proves
 * why that matters: the same token answers true on Ethereum, where it locks real
 * USDT, and false on Arbitrum, Optimism and Polygon, where it mints and burns.
 * Assuming either from the deployment's name would be wrong most of the time.
 *
 * The allowance is for exactly this transfer, never unlimited. An infinite
 * approval is convenient once and then sits on the user's account forever as a
 * standing claim on their funds.
 */
export function buildApproval(inputs: {
  readonly token: string;
  readonly spender: `0x${string}`;
  readonly amount: bigint;
  readonly decimals: number;
  readonly symbol: string;
}): ApprovalCall {
  if (inputs.amount <= 0n) {
    throw new MavnaError("Refusing to approve a non-positive amount.", { retryable: false });
  }
  return {
    contract: inputs.token,
    functionName: "approve",
    args: [inputs.spender, inputs.amount],
    describes:
      `Let the LayerZero transfer contract move ${readableAmount(inputs.amount, inputs.decimals)} ` +
      `${inputs.symbol} from your wallet, once. This does not send anything on its own.`,
  };
}

/** Just enough of IOFT to quote, to send, and to learn what the contract is. */
export const OFT_ABI = [
  {
    type: "function",
    name: "quoteSend",
    stateMutability: "view",
    inputs: [
      {
        name: "_sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
      { name: "_payInLzToken", type: "bool" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quoteOFT",
    stateMutability: "view",
    inputs: [
      {
        name: "_sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "minAmountLD", type: "uint256" },
          { name: "maxAmountLD", type: "uint256" },
        ],
      },
      {
        name: "oftFeeDetails",
        type: "tuple[]",
        components: [
          // Signed, because a fee detail can describe a rebate as well as a cost.
          { name: "feeAmountLD", type: "int256" },
          { name: "description", type: "string" },
        ],
      },
      {
        name: "",
        type: "tuple",
        components: [
          { name: "amountSentLD", type: "uint256" },
          { name: "amountReceivedLD", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [
      {
        name: "_sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" },
        ],
      },
      {
        name: "_fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
      { name: "_refundAddress", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "guid", type: "bytes32" },
          { name: "nonce", type: "uint64" },
          {
            name: "fee",
            type: "tuple",
            components: [
              { name: "nativeFee", type: "uint256" },
              { name: "lzTokenFee", type: "uint256" },
            ],
          },
        ],
      },
      {
        name: "",
        type: "tuple",
        components: [
          { name: "amountSentLD", type: "uint256" },
          { name: "amountReceivedLD", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "approvalRequired",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "sharedDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "oftVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "interfaceId", type: "bytes4" },
      { name: "version", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "peers",
    stateMutability: "view",
    inputs: [{ name: "_eid", type: "uint32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "enforcedOptions",
    stateMutability: "view",
    inputs: [
      { name: "_eid", type: "uint32" },
      { name: "_msgType", type: "uint16" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "endpoint",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Just enough ERC-20 for the approval, and for a caller to check it is needed. */
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/** The endpoint reads that decide whether a pathway exists and who verifies it. */
export const ENDPOINT_ABI = [
  {
    type: "function",
    name: "eid",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "isSupportedEid",
    stateMutability: "view",
    inputs: [{ name: "_eid", type: "uint32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "defaultSendLibrary",
    stateMutability: "view",
    inputs: [{ name: "_eid", type: "uint32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getSendLibrary",
    stateMutability: "view",
    inputs: [
      { name: "_sender", type: "address" },
      { name: "_eid", type: "uint32" },
    ],
    outputs: [{ name: "lib", type: "address" }],
  },
  {
    type: "function",
    name: "isDefaultSendLibrary",
    stateMutability: "view",
    inputs: [
      { name: "_sender", type: "address" },
      { name: "_eid", type: "uint32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getConfig",
    stateMutability: "view",
    inputs: [
      { name: "_oapp", type: "address" },
      { name: "_lib", type: "address" },
      { name: "_eid", type: "uint32" },
      { name: "_configType", type: "uint32" },
    ],
    outputs: [{ name: "config", type: "bytes" }],
  },
] as const;
