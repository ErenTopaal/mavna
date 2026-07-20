import { MavnaError } from "@mavna/core";
import { deploymentFor } from "./chains.js";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { buildForwarderHookData, contractAddressToBytes32, toHex } from "./hook.js";

/**
 * The burn, on the EVM side of a transfer into Stellar.
 *
 * This is the irreversible step. Circle warns twice, in red, on separate pages:
 * get `mintRecipient` or `destinationCaller` wrong and "funds become permanently
 * stuck and cannot be recovered".
 *
 * So this module validates everything before it produces anything, and the
 * assertions are the point. It returns call parameters rather than a signed
 * transaction, because nothing in this codebase signs on a user's behalf.
 */

/**
 * CCTP V2 on Ethereum Sepolia.
 *
 * Kept as a named constant because it is the deployment every live test in this
 * repository runs against, but it is no longer the ONLY one: the full verified
 * set is in `chains.ts` and `buildBurn` reads from there. Treating Sepolia as
 * the whole world was a real limitation and is gone.
 */
export const EVM_TESTNET = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  domain: 0,
} as const;

/**
 * Only two finality thresholds exist and only two are meaningful.
 *
 * Circle: "Any minFinalityThreshold value below 1000 is treated as 1000, and any
 * value above 1000 is treated as 2000." So there is no slider to offer a user,
 * only a choice between fast and standard.
 */
export const FINALITY = {
  /** Faster, costs a fee that varies by source chain. */
  fast: 1000,
  /** Slower, and free from every chain that reaches Stellar. */
  standard: 2000,
} as const;

export interface BurnParams {
  readonly amount: bigint;
  /** The real recipient on Stellar. May be an account, contract or muxed address. */
  readonly stellarRecipient: string;
  readonly network: "testnet" | "mainnet";
  /**
   * Which chain the burn happens on, as this codebase names it.
   *
   * Required rather than defaulted. A default would mean a caller who forgot it
   * silently burns on the wrong chain, and there is no recovering from that.
   */
  readonly sourceChainId: string;
  readonly finality?: number;
  /**
   * Ceiling on the fee, in the SOURCE chain's units for an EVM burn.
   *
   * Note this differs from a Stellar-sourced burn, where the same field is in
   * Stellar's seven-decimal local units. Circle's own repository contradicts
   * itself about that; the contract is authoritative and wants local.
   */
  readonly maxFee: bigint;
}

export interface BurnCall {
  readonly contract: string;
  readonly functionName: "depositForBurnWithHook";
  readonly args: readonly [
    amount: bigint,
    destinationDomain: number,
    mintRecipient: `0x${string}`,
    burnToken: `0x${string}`,
    destinationCaller: `0x${string}`,
    maxFee: bigint,
    minFinalityThreshold: number,
    hookData: `0x${string}`,
  ];
  /** What this will do, in terms that mean something. Consent needs understanding. */
  readonly describes: string;
}

/**
 * Build the burn call.
 *
 * Both `mintRecipient` and `destinationCaller` are set to Circle's Stellar
 * forwarder, NOT to the user. That is counter-intuitive and is the single most
 * important line here: the forwarder receives the mint and passes it on to the
 * address carried in the hook data. Naming the user directly means the funds
 * arrive somewhere nothing can move them from.
 */
export function buildBurn(params: BurnParams): BurnCall {
  if (params.amount <= 0n) {
    throw new MavnaError("Refusing to burn a non-positive amount.", { retryable: false });
  }
  if (params.maxFee >= params.amount) {
    // The contract rejects this too, but failing here costs nothing and explains
    // itself, whereas the on-chain revert does not.
    throw new MavnaError("The fee ceiling must be smaller than the amount being sent.", {
      retryable: false,
    });
  }

  const deployment = deploymentFor(params.network, params.sourceChainId);
  if (deployment === undefined) {
    throw new MavnaError(
      `No verified CCTP deployment for ${params.sourceChainId} on ${params.network}. ` +
        "Run scripts/verify-cctp-chains.mjs to add one; guessing an address here is how " +
        "funds become permanently unrecoverable.",
      { retryable: false },
    );
  }

  const forwarder = CCTP_CONTRACTS[params.network].cctpForwarder;

  // Refuses anything that is not a contract address, which is what stops a user
  // account being named as the mint recipient.
  const forwarderBytes32 = toHex(contractAddressToBytes32(forwarder));

  // Validates the recipient before encoding a single byte.
  const hookData = toHex(buildForwarderHookData(params.stellarRecipient));

  const finality = params.finality ?? FINALITY.standard;
  if (finality !== FINALITY.fast && finality !== FINALITY.standard) {
    throw new MavnaError(
      `Finality must be ${FINALITY.fast} or ${FINALITY.standard}; anything else is coerced ` +
        "to one of them and pretending otherwise would mislead the caller.",
      { retryable: false },
    );
  }

  return {
    contract: deployment.tokenMessengerV2,
    functionName: "depositForBurnWithHook",
    args: [
      params.amount,
      STELLAR_DOMAIN,
      forwarderBytes32,
      deployment.usdc as `0x${string}`,
      // Set deliberately. Leaving it zero would let anyone call receive_message
      // directly, minting to the forwarder WITHOUT forwarding, which strands the
      // funds in the forwarder contract.
      forwarderBytes32,
      params.maxFee,
      finality,
      hookData,
    ],
    describes:
      `Send ${params.amount} USDC base units to ${params.stellarRecipient} on Stellar, ` +
      `via Circle, ${finality === FINALITY.fast ? "on the fast path" : "on the standard path"}.`,
  };
}

/** The minimal ABI needed for the burn and its approval. */
export const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;
