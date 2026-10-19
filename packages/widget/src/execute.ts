import { ERC20_ABI, type NativeCurrency } from "@mavna/adapter-cctp";
import {
  type AllowanceCheck,
  type Route,
  SENDER_ADDRESS,
  type UnsignedTransaction,
} from "@mavna/core";
import type { Abi, AbiFunction, AbiParameter, Address, Hash } from "viem";
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
  /** Native currency sent with the call, when the payload carries any. */
  readonly value: bigint | undefined;
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

  await assertBalanceCovers(options);

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

    const call = parseCall(transaction.payload, connection.address);
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
        value: call.value,
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
 * Refuse before the first signature if the wallet cannot cover the transfer.
 *
 * Without this the flow asks for the approval, the user pays gas for it, and then
 * the burn reverts on a balance the app could have read at any point. It is the
 * same failure the missing approval caused, one step later, and just as avoidable.
 *
 * The allowance the burn needs is read from the approval's own stated condition,
 * so this cannot drift from what is actually being asked for.
 */
export async function assertBalanceCovers(
  options: Pick<ExecuteOptions, "connection" | "route" | "transactions" | "nativeCurrency">,
): Promise<void> {
  const { connection } = options;
  const condition = options.transactions
    .map((t) => t.unnecessaryWhen)
    .find((c) => c?.kind === "erc20-allowance");

  if (condition !== undefined) {
    const needed = BigInt(condition.atLeastBaseUnits);
    const held = await connection.reader.readContract({
      address: condition.token as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [connection.address],
    });

    if (held < needed) {
      const { symbol, decimals } = options.route.sends.asset;
      throw new Error(
        `This wallet holds ${format(held, decimals)} ${symbol} and the transfer needs ` +
          `${format(needed, decimals)}. Nothing has been sent.`,
      );
    }
  }

  // The delivery fee rides on the send itself, so the wallet needs that much
  // native currency on top of the gas. Gas cannot be known before signing, which
  // makes this a floor and not a guarantee, but it catches the common failure.
  const fee = options.transactions
    .filter((t) => t.format === "evm-tx")
    .reduce((sum, t) => sum + (parseCall(t.payload, connection.address).value ?? 0n), 0n);
  if (fee === 0n) return;

  const native = await connection.reader.getBalance({ address: connection.address });
  if (native < fee) {
    const currency = options.nativeCurrency;
    const label = currency?.symbol ?? "the native token";
    const decimals = currency?.decimals ?? 18;
    throw new Error(
      `This transfer needs ${format(fee, decimals)} ${label} to pay for delivery, plus gas, ` +
        `and this wallet holds ${format(native, decimals)}. Nothing has been sent.`,
    );
  }
}

/** Base units to a readable figure, without going near a float. */
function format(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
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
 * bigint. What goes back to a bigint is decided by the ABI's own type for that
 * slot, not by how the string looks: an amount is a uint, and a text field that
 * happens to be all digits is still text. Getting this wrong encodes an amount
 * as text and the contract rejects it, or worse, sends the wrong number.
 *
 * `value` is the native amount a payable call carries (a LayerZero or Axelar
 * delivery fee). It stays undefined when the payload has none, so a plain call
 * is not turned into a zero-value payable one.
 */
export function parseCall(payload: string, sender: Address): EvmCall {
  const raw = JSON.parse(payload) as {
    to: string;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    value?: string;
  };

  const inputs = inputsFor(raw.abi, raw.functionName, raw.args.length);

  return {
    to: raw.to as Address,
    abi: raw.abi,
    functionName: raw.functionName,
    args: raw.args.map((arg, i) => coerce(arg, inputs[i], sender)),
    value: raw.value === undefined ? undefined : BigInt(raw.value),
  };
}

function inputsFor(
  abi: Abi,
  functionName: string,
  argCount: number,
): readonly (AbiParameter | undefined)[] {
  const candidates = abi.filter(
    (item): item is AbiFunction => item.type === "function" && item.name === functionName,
  );
  // Overloads share a name, so the argument count is what tells them apart.
  const match = candidates.find((f) => f.inputs.length === argCount);
  if (match === undefined) {
    throw new Error(
      `The transfer asks for ${functionName} with ${argCount} arguments, and its own ` +
        "interface has no such function. Nothing has been sent.",
    );
  }
  return match.inputs;
}

const INTEGER_TYPE = /^u?int\d*$/;
const ARRAY_TYPE = /^(.*)\[\d*\]$/;

function coerce(arg: unknown, param: AbiParameter | undefined, sender: Address): unknown {
  if (arg === SENDER_ADDRESS) return sender;
  if (param === undefined) return arg;

  if (typeof arg === "string") {
    return INTEGER_TYPE.test(param.type) && /^-?\d+$/.test(arg) ? BigInt(arg) : arg;
  }

  const element = ARRAY_TYPE.exec(param.type);
  if (Array.isArray(arg)) {
    if (element !== null) {
      const inner = { ...param, type: element[1] } as AbiParameter;
      return arg.map((item) => coerce(item, inner, sender));
    }
    const components = "components" in param ? param.components : [];
    return arg.map((item, i) => coerce(item, components[i], sender));
  }

  if (typeof arg === "object" && arg !== null && "components" in param) {
    const byName = new Map(param.components.map((c) => [c.name, c]));
    return Object.fromEntries(
      Object.entries(arg).map(([key, item]) => [key, coerce(item, byName.get(key), sender)]),
    );
  }

  return arg;
}
