import { ERC20_ABI, type NativeCurrency } from "@mavna/adapter-cctp";
import type { AllowanceCheck, Route, UnsignedTransaction } from "@mavna/core";
import type { Abi, Address, Hash } from "viem";
import { type Connection, chainFor, isUserRejection, switchChain } from "./wallet.js";

/**
 * Signing and sending what the SDK built.
 *
 * This lives in the app rather than the SDK, deliberately. The SDK builds
 * transactions and hands them over; it never signs and never submits, so a
 * reviewer can confirm non-custody by noting that no package under `packages/`
 * imports a signer. Every line that touches a key is in front of you here.
 */

/** How far along an execution is, in terms the interface can render. */
export type ExecutionEvent =
  | { readonly kind: "skipped"; readonly index: number; readonly why: string }
  | { readonly kind: "awaiting-signature"; readonly index: number; readonly describes: string }
  | { readonly kind: "sent"; readonly index: number; readonly hash: Hash }
  | { readonly kind: "confirmed"; readonly index: number; readonly hash: Hash };

export interface ExecuteOptions {
  readonly connection: Connection;
  readonly route: Route;
  readonly transactions: readonly UnsignedTransaction[];
  readonly chainName: string;
  readonly evmChainId: number;
  /** Undefined for a chain the registry does not carry. Nothing is guessed. */
  readonly nativeCurrency: NativeCurrency | undefined;
  readonly onEvent: (event: ExecutionEvent) => void;
}

/** What an `evm-tx` payload carries. Parsed, never trusted as-is. */
interface EvmCall {
  readonly to: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

/**
 * Run the transactions in order, skipping the ones that turn out unnecessary.
 *
 * Order is not cosmetic. The approval has to land before the burn or the burn
 * reverts, so each transaction is waited for rather than fired off together.
 * Slower, and the alternative is a user paying gas to watch the second one fail.
 */
export async function execute(options: ExecuteOptions): Promise<readonly Hash[]> {
  const { connection, transactions, onEvent } = options;

  if (connection.chainId !== options.evmChainId) {
    await switchChain(connection.provider, options.evmChainId, options.chainName);
  }

  const chain = chainFor(options.evmChainId, options.chainName, options.nativeCurrency);
  const hashes: Hash[] = [];

  for (const [index, transaction] of transactions.entries()) {
    if (transaction.format !== "evm-tx") {
      throw new Error(
        `This page can only send from EVM chains today, and this transfer needs a ` +
          `${transaction.format} signature. Nothing has been sent.`,
      );
    }

    const skip = await unnecessary(transaction, connection);
    if (skip !== undefined) {
      onEvent({ kind: "skipped", index, why: skip });
      continue;
    }

    const call = parseCall(transaction.payload);
    onEvent({ kind: "awaiting-signature", index, describes: transaction.describes });

    let hash: Hash;
    try {
      hash = await connection.wallet.writeContract({
        chain,
        account: connection.address,
        address: call.to,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      });
    } catch (cause) {
      if (isUserRejection(cause)) {
        // Nothing was sent, and saying so is the point: a user who is unsure
        // whether their money moved will try again, and trying again is how one
        // payment becomes two.
        throw new Error(
          index === 0
            ? "You did not approve, so nothing was sent."
            : "You did not confirm the transfer. The approval went through, but no funds moved.",
        );
      }
      throw cause;
    }

    onEvent({ kind: "sent", index, hash });
    const receipt = await connection.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `The ${index === 0 ? "approval" : "transfer"} was rejected by the network. ` +
          "Your funds have not moved.",
      );
    }

    onEvent({ kind: "confirmed", index, hash });
    hashes.push(hash);
  }

  return hashes;
}

/**
 * Decide whether a transaction can be left unsent.
 *
 * The SDK states the condition and cannot evaluate it: reading an allowance needs
 * a node on the source chain, and the wallet is the thing already connected to
 * one. Asking a user to approve what they have already approved costs them gas
 * for a transaction that changes nothing.
 */
async function unnecessary(
  transaction: UnsignedTransaction,
  connection: Connection,
): Promise<string | undefined> {
  const condition = transaction.unnecessaryWhen;
  if (condition === undefined) return undefined;

  const allowance = await readAllowance(condition, connection);
  return allowance >= BigInt(condition.atLeastBaseUnits)
    ? "You have already allowed this, so there is nothing to sign."
    : undefined;
}

function readAllowance(condition: AllowanceCheck, connection: Connection): Promise<bigint> {
  return connection.reader.readContract({
    address: condition.token as Address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [connection.address, condition.spender as Address],
  });
}

/**
 * Read an `evm-tx` payload back into a call.
 *
 * Arguments come across as strings so the payload survives JSON, which has no
 * bigint. Anything that is all digits goes back to a bigint; a hex address or
 * hook blob stays a string. Getting this backwards encodes an amount as text and
 * the contract rejects it, which is loud, rather than silently sending the wrong
 * number, which is not.
 */
function parseCall(payload: string): EvmCall {
  const raw = JSON.parse(payload) as {
    to: string;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  };

  return {
    to: raw.to as Address,
    abi: raw.abi,
    functionName: raw.functionName,
    args: raw.args.map((arg) => (typeof arg === "string" && /^\d+$/.test(arg) ? BigInt(arg) : arg)),
  };
}
