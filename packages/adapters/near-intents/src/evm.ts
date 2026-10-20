import { MavnaError } from "@mavna/core";
import { REQUEST_TIMEOUT_MS } from "./api.js";
import type { OriginChain } from "./chains.js";

/**
 * The deposit, and finding it again.
 *
 * Paying into NEAR Intents is a plain ERC-20 transfer to an address 1Click hands
 * out. No contract of 1Click's is called and no allowance is involved, so there
 * is nothing here but `transfer` itself.
 */

export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** `transfer(address,uint256)`. */
export const TRANSFER_SELECTOR = "0xa9059cbb";

/** The `evm-tx` payload for the deposit, in the shape every rail here emits. */
export function transferPayload(token: string, to: string, amount: bigint): string {
  return JSON.stringify({
    to: token,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amount.toString()],
  });
}

/** One JSON-RPC call. Injectable so tests stand at the network boundary. */
export type JsonRpc = (url: string, method: string, params: readonly unknown[]) => Promise<unknown>;

export const fetchJsonRpc: JsonRpc = async (url, method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error !== undefined) throw new Error(body.error.message ?? "JSON-RPC error");
  return body.result;
};

/** Decode `transfer(to, amount)` calldata, or undefined when it is anything else. */
export function decodeTransfer(input: string): { to: string; amount: bigint } | undefined {
  const data = input.toLowerCase();
  // Exactly the selector and two words. Anything longer is some other call that
  // happens to share the first four bytes, and guessing at it is how a deposit
  // address gets read out of a transaction that never paid one.
  if (!data.startsWith(TRANSFER_SELECTOR) || data.length !== 10 + 128) return undefined;
  const toWord = data.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/.test(toWord)) return undefined;
  return { to: `0x${toWord.slice(24)}`, amount: BigInt(`0x${data.slice(74)}`) };
}

export interface SentTransfer {
  readonly token: string;
  readonly to: string;
  readonly amount: bigint;
}

/**
 * URLs that have said which chain they serve, per JSON-RPC transport.
 *
 * Asked once per URL rather than on every lookup, since a status read from a
 * hash alone searches every chain and is polled. Keyed by transport as well,
 * so a test's double is never answered from a real node's record.
 */
const served = new WeakMap<JsonRpc, Map<string, number>>();

async function servesChain(url: string, evmChainId: number, rpc: JsonRpc): Promise<boolean> {
  let known = served.get(rpc);
  if (known === undefined) {
    known = new Map();
    served.set(rpc, known);
  }
  let id = known.get(url);
  if (id === undefined) {
    const answer = await rpc(url, "eth_chainId", []);
    if (typeof answer !== "string") return false;
    id = Number(answer);
    known.set(url, id);
  }
  return id === evmChainId;
}

/**
 * The ERC-20 transfer a transaction made, read off the chain it was sent on.
 *
 * Undefined when no node on the chain has the transaction, or it is not a
 * plain transfer. Every URL is asked before concluding it is not there: a node
 * that is a block behind answers null for a deposit sent seconds ago, and one
 * node's null is not the chain's. A node is believed only once it has said it
 * serves this chain, since a URL pointed at another chain answers confidently
 * about some other transaction. Only when no node answered is it an error.
 */
export async function readTransfer(
  chain: OriginChain,
  txHash: string,
  rpc: JsonRpc,
): Promise<SentTransfer | undefined> {
  const hash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  let lastError: unknown;
  let answered = false;
  for (const url of chain.rpc) {
    let tx: unknown;
    try {
      if (!(await servesChain(url, chain.evmChainId, rpc))) {
        lastError = new Error(`${url} does not serve chain ${chain.evmChainId}`);
        continue;
      }
      tx = await rpc(url, "eth_getTransactionByHash", [hash]);
    } catch (cause) {
      lastError = cause;
      continue;
    }
    answered = true;
    if (tx === null || tx === undefined) continue;
    const fields = tx as { to?: unknown; input?: unknown };
    if (typeof fields.to !== "string" || typeof fields.input !== "string") return undefined;
    const call = decodeTransfer(fields.input);
    if (call === undefined) return undefined;
    return { token: fields.to.toLowerCase(), to: call.to, amount: call.amount };
  }
  if (answered) return undefined;
  throw new MavnaError(`No ${chain.name} node answered for that transaction.`, {
    retryable: true,
    cause: lastError,
  });
}
