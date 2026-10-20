import { MavnaError, type NetworkId } from "@mavna/core";
import {
  Account,
  Contract,
  rpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import * as z from "zod";
import type { Usability } from "./provider.js";
import { boundedBy, causeOf, PASSPHRASE, readValidated } from "./wire.js";

/**
 * Soroban reads and builds for the contract venues, over plain JSON-RPC.
 *
 * Not through `rpc.Server`, because its calls take no AbortSignal: a hung node
 * would hold a quote open past the route race's bound, and the venue chain
 * could never move on to the next venue. The SDK still does the parts that are
 * easy to get subtly wrong, decoding the simulation and assembling the
 * transaction from it.
 */

/**
 * Simulation needs a source but never checks that it exists, so quotes are
 * simulated from the all-zero account rather than from anyone real. Sushi's own
 * app quotes the same way.
 */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const simulationResult = z.object({
  latestLedger: z.number().int(),
  error: z.string().optional(),
  transactionData: z.string().optional(),
  events: z.array(z.string()).optional(),
  minResourceFee: z.string().optional(),
  results: z.array(z.object({ auth: z.array(z.string()).optional(), xdr: z.string() })).optional(),
  restorePreamble: z.object({ minResourceFee: z.string(), transactionData: z.string() }).optional(),
});

const rpcEnvelope = z.union([
  z.object({ id: z.union([z.string(), z.number()]), result: simulationResult }),
  z.object({
    id: z.union([z.string(), z.number()]).nullable(),
    error: z.object({ code: z.number(), message: z.string() }),
  }),
]);

const healthEnvelope = z.object({ result: z.object({ status: z.string() }) });

export interface Simulated {
  readonly raw: rpc.Api.RawSimulateTransactionResponse;
  /** The host function's return value. */
  readonly retval: xdr.ScVal;
}

/**
 * Simulate a transaction, bounded by a timeout.
 *
 * A node that cannot be reached is retryable. A simulation the contract itself
 * failed is not: asking again asks the same contract the same question.
 */
export async function simulate(
  rpcUrl: string,
  tx: Transaction,
  timeoutMs: number,
  venue: string,
  caller?: AbortSignal,
): Promise<Simulated> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: { transaction: tx.toXdr() },
      }),
      signal: boundedBy(timeoutMs, caller),
    });
  } catch (cause) {
    throw new MavnaError(`The Stellar RPC did not answer for ${venue}.`, {
      retryable: true,
      cause,
    });
  }
  if (!response.ok) {
    throw new MavnaError(
      `The Stellar RPC refused ${venue}'s simulation (HTTP ${response.status}).`,
      {
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
  const body = await readValidated("The Stellar RPC", response, rpcEnvelope);
  if ("error" in body) {
    throw new MavnaError(`The Stellar RPC could not simulate ${venue}: ${body.error.message}`, {
      retryable: true,
    });
  }
  const result = body.result;
  if (result.error !== undefined) {
    throw new MavnaError(`${venue} cannot do this right now: ${firstLine(result.error)}`, {
      retryable: false,
    });
  }
  const first = result.results?.[0];
  if (first === undefined) {
    throw new MavnaError(`${venue}'s simulation returned no result.`, { retryable: false });
  }
  if (result.restorePreamble !== undefined) {
    // Archived state needs its own restore transaction first, which is a second
    // signature nobody agreed to. Saying so beats building something that fails.
    throw new MavnaError(`${venue} needs archived state restored before it can swap.`, {
      retryable: false,
    });
  }
  return {
    raw: {
      id: String(body.id),
      latestLedger: result.latestLedger,
      ...(result.transactionData === undefined ? {} : { transactionData: result.transactionData }),
      ...(result.events === undefined ? {} : { events: result.events }),
      ...(result.minResourceFee === undefined ? {} : { minResourceFee: result.minResourceFee }),
      results: [{ xdr: first.xdr, ...(first.auth === undefined ? {} : { auth: first.auth }) }],
    },
    retval: xdr.ScVal.fromXdr(first.xdr, "base64"),
  };
}

/** Call a contract function read-only and return what it would return. */
export async function readContract(
  rpcUrl: string,
  network: NetworkId,
  contract: string,
  method: string,
  args: readonly xdr.ScVal[],
  timeoutMs: number,
  venue: string,
  caller?: AbortSignal,
): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE[network],
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(60)
    .build();
  return (await simulate(rpcUrl, tx, timeoutMs, venue, caller)).retval;
}

/**
 * Build, simulate and assemble one contract call from the account that will
 * sign it. The result is unsigned and ready for the owner's wallet.
 */
export async function buildContractCall(
  rpcUrl: string,
  network: NetworkId,
  account: Account,
  contract: string,
  method: string,
  args: readonly xdr.ScVal[],
  timeoutMs: number,
  venue: string,
): Promise<Transaction> {
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE[network],
  })
    .addOperation(new Contract(contract).call(method, ...args))
    // Two minutes covers a wallet prompt. Longer would let a stale floor execute.
    .setTimeout(120)
    .build();
  const { raw } = await simulate(rpcUrl, tx, timeoutMs, venue);
  return rpc.assembleTransaction(tx, raw).build();
}

/** Whether the RPC answers getHealth with "healthy". */
export async function rpcHealthy(rpcUrl: string, timeoutMs: number): Promise<boolean> {
  return (await rpcHealth(rpcUrl, timeoutMs)).usable;
}

/** The same, with why when it is not. */
export async function rpcHealth(rpcUrl: string, timeoutMs: number): Promise<Usability> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { usable: false, because: `${rpcUrl} answered HTTP ${response.status}` };
    const parsed = healthEnvelope.safeParse(await response.json());
    if (!parsed.success) return { usable: false, because: `${rpcUrl} answered in another shape` };
    return parsed.data.result.status === "healthy"
      ? { usable: true }
      : { usable: false, because: `${rpcUrl} reports ${parsed.data.result.status}` };
  } catch (cause) {
    // isUsable answers a question; an unreachable node is the answer "no".
    return { usable: false, because: `${rpcUrl} did not answer (${causeOf(cause)})` };
  }
}

/** Host errors carry a multi-line diagnostic dump; the first line is the reason. */
function firstLine(text: string): string {
  return (text.split("\n")[0] ?? text).slice(0, 200);
}
