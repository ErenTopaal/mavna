import {
  Address,
  FeeBumpTransaction,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Test doubles for the network, and only the network.
 *
 * Every provider here is exercised for real; what is replaced is `fetch`, so a
 * test decides what a venue, the proxy or a Stellar RPC node answers and then
 * watches what the real code does with it.
 */

export interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that dispatches by URL prefix and records every call. */
export function routedFetch(routes: Readonly<Record<string, Handler>>): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const double = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    init?.signal?.throwIfAborted();
    const prefix = Object.keys(routes)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    const handler = prefix === undefined ? undefined : routes[prefix];
    if (handler === undefined) throw new TypeError(`fetch failed: nothing answers ${url}`);
    return handler(url, init);
  };
  return { fetch: double, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function bodyOf(call: Recorded | undefined): unknown {
  const body = call?.init?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

/** What a contract call in a simulated transaction asked for. */
export interface ContractCall {
  readonly contract: string;
  readonly method: string;
  readonly args: readonly xdr.ScVal[];
  readonly source: string;
}

/**
 * The answer a simulated contract call gets: a return value, one with what it
 * cost in instructions, or a host error.
 */
export type CallAnswer =
  | xdr.ScVal
  | { readonly value: xdr.ScVal; readonly instructions: number }
  | { readonly error: string };

/**
 * A Stellar RPC node that answers getHealth and simulateTransaction, handing
 * each simulated contract call to `answer`.
 */
export function sorobanNode(
  answer: (call: ContractCall) => CallAnswer,
  passphrase: string = Networks.PUBLIC,
): Handler {
  return (_url, init) => {
    const request: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    if (!isRpcRequest(request)) return json({ error: "bad request" }, 400);
    if (request.method === "getHealth") {
      return json({ jsonrpc: "2.0", id: request.id, result: { status: "healthy" } });
    }
    const tx = TransactionBuilder.fromXdr(String(request.params?.transaction), passphrase);
    if (tx instanceof FeeBumpTransaction) return json({ error: "fee bump" }, 400);
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction") return json({ error: "not a call" }, 400);
    const invoke = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
    const call: ContractCall = {
      contract: Address.fromScAddress(invoke.contractAddress).toString(),
      method: invoke.functionName.toString(),
      args: invoke.args,
      source: tx.source,
    };
    const result = answer(call);
    if ("error" in result) {
      return json({
        jsonrpc: "2.0",
        id: request.id,
        result: { latestLedger: 100, error: result.error },
      });
    }
    const [value, instructions] =
      result instanceof xdr.ScVal ? [result, 0] : [result.value, result.instructions];
    return json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        latestLedger: 100,
        minResourceFee: "12345",
        transactionData: new SorobanDataBuilder()
          .setResourceFee(12_345)
          .setResources(instructions, 0, 0)
          .build()
          .toXdr("base64"),
        results: [{ auth: [], xdr: value.toXdr("base64") }],
      },
    });
  };
}

function isRpcRequest(
  value: unknown,
): value is { id: number; method: string; params?: { transaction?: string } } {
  return typeof value === "object" && value !== null && "method" in value && "id" in value;
}
