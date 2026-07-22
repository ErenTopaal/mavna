import { MavnaError, type NetworkId } from "@mavna/core";
import { keccak256, toBytes } from "viem";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { buildForwarderHookData, contractAddressToBytes32 } from "./hook.js";

/**
 * The burn, on Starknet.
 *
 * Loaded on demand, like the Solana builder, so it costs nothing to integrators
 * who never send from Starknet.
 *
 * No Starknet SDK is pulled in for this. All that is needed beyond plain
 * arithmetic is a selector, which is keccak with the top six bits cleared, and
 * `viem` is already here for the EVM side. Adding a second large library to
 * compute one hash would be a poor trade.
 *
 * `scripts/verify-cctp-starknet.mjs` re-derives everything below from the chain:
 * the contract classes, the selector against the class's own entry points, and
 * USDC out of the contract's `get_local_token`.
 */

export interface StarknetDeployment {
  readonly tokenMessengerMinterV2: string;
  readonly messageTransmitterV2: string;
  readonly usdc: string;
  readonly explorer: string;
}

/**
 * Circle's Starknet deployment.
 *
 * The two contract addresses come from Circle and were then confirmed on-chain:
 * the testnet pair resolves to a class on Sepolia and the mainnet pair does not,
 * which is how each was assigned to its network rather than by trusting the order
 * of a table. USDC was read out of the token messenger's own `get_local_token`.
 */
export const STARKNET_DEPLOYMENTS: Readonly<Record<NetworkId, StarknetDeployment>> = {
  testnet: {
    tokenMessengerMinterV2: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
    messageTransmitterV2: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
    usdc: "0x512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
    explorer: "https://sepolia.starkscan.co",
  },
  mainnet: {
    tokenMessengerMinterV2: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
    messageTransmitterV2: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
    usdc: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    explorer: "https://starkscan.co",
  },
};

export interface StarknetBurnParams {
  readonly amount: bigint;
  readonly stellarRecipient: string;
  readonly network: NetworkId;
  readonly maxFee: bigint;
  readonly finality: number | undefined;
}

/** One call in a Starknet invoke. A wallet turns an array of these into a transaction. */
export interface StarknetCall {
  readonly contractAddress: string;
  readonly entrypoint: string;
  readonly calldata: readonly string[];
}

export interface StarknetInvoke {
  readonly calls: readonly StarknetCall[];
  readonly describes: string;
}

/** Starknet's field is 252 bits, so a selector is keccak with the top bits cleared. */
const SELECTOR_MASK = (1n << 250n) - 1n;

export function starknetSelector(name: string): string {
  return `0x${(BigInt(keccak256(toBytes(name))) & SELECTOR_MASK).toString(16)}`;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** Cairo splits a u256 into two 128-bit felts, low first. */
function u256(value: bigint): [string, string] {
  if (value < 0n || value >= 1n << 256n) {
    throw new MavnaError(`Value does not fit in a u256: ${value}`, { retryable: false });
  }
  return [hex(value & ((1n << 128n) - 1n)), hex(value >> 128n)];
}

/**
 * Cairo's `ByteArray`, which is not simply a length and some bytes.
 *
 * It is a list of full 31-byte words, then whatever is left over as a single
 * partial word with its own length. Getting the split wrong does not fail to
 * encode; it produces a burn whose hook data decodes to something else on the far
 * side, which is where the recipient lives.
 */
export function byteArrayCalldata(bytes: Uint8Array): string[] {
  const WORD = 31;
  const fullWords = Math.floor(bytes.length / WORD);
  const out: string[] = [String(fullWords)];

  for (let i = 0; i < fullWords; i += 1) {
    out.push(hex(bytesToBigInt(bytes.subarray(i * WORD, (i + 1) * WORD))));
  }

  const rest = bytes.subarray(fullWords * WORD);
  out.push(hex(bytesToBigInt(rest)), String(rest.length));
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Build the Starknet burn.
 *
 * Two calls, not one: Starknet has no allowance-free transfer, so the token must
 * be approved for the messenger first. Wallets there submit multiple calls in a
 * single transaction as a matter of course, so this is still one signature.
 *
 * `mint_recipient` and `destination_caller` are both Circle's Stellar forwarder,
 * exactly as on every other chain, and getting either wrong is exactly as
 * unrecoverable.
 */
export function buildStarknetBurn(params: StarknetBurnParams): StarknetInvoke {
  if (params.amount <= 0n) {
    throw new MavnaError("Refusing to burn a non-positive amount.", { retryable: false });
  }
  if (params.maxFee >= params.amount) {
    throw new MavnaError("The fee ceiling must be smaller than the amount being sent.", {
      retryable: false,
    });
  }

  const deployment = STARKNET_DEPLOYMENTS[params.network];
  const forwarder = CCTP_CONTRACTS[params.network].cctpForwarder;
  // Refuses anything that is not a contract address, which is what stops a user
  // account being named as the mint recipient.
  const forwarderValue = bytesToBigInt(contractAddressToBytes32(forwarder));
  // Validates the recipient before encoding a single felt.
  const hookData = buildForwarderHookData(params.stellarRecipient);

  const finality = params.finality ?? 2000;
  if (finality !== 1000 && finality !== 2000) {
    throw new MavnaError(
      "Finality must be 1000 or 2000; anything else is coerced to one of them and " +
        "pretending otherwise would mislead the caller.",
      { retryable: false },
    );
  }

  const calls: StarknetCall[] = [
    {
      contractAddress: deployment.usdc,
      entrypoint: "approve",
      calldata: [deployment.tokenMessengerMinterV2, ...u256(params.amount)],
    },
    {
      contractAddress: deployment.tokenMessengerMinterV2,
      entrypoint: "deposit_for_burn_with_hook",
      // Positional and in the ABI's declared order. Cairo does not name arguments
      // on the wire, so a field out of place is a burn with wrong arguments rather
      // than a decode error.
      calldata: [
        ...u256(params.amount),
        String(STELLAR_DOMAIN),
        ...u256(forwarderValue),
        deployment.usdc,
        ...u256(forwarderValue),
        ...u256(params.maxFee),
        String(finality),
        ...byteArrayCalldata(hookData),
      ],
    },
  ];

  return {
    calls,
    describes:
      `Send ${params.amount} USDC base units to ${params.stellarRecipient} on Stellar, ` +
      `via Circle, ${finality === 1000 ? "on the fast path" : "on the standard path"}.`,
  };
}
