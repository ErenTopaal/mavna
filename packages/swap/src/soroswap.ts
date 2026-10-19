import {
  baseUnits,
  basisPoints,
  MavnaError,
  type NetworkId,
  positiveBaseUnits,
  stellarAddress,
} from "@mavna/core";
import {
  Address,
  scValToNative,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  applySlippage,
  type SwapBuildRequest,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
} from "./provider.js";
import { fetchOrThrow, PASSPHRASE, readValidated, toContractId } from "./wire.js";

/**
 * Soroswap. The preferred venue, reached through a proxy that holds the key.
 *
 * Four things about it shape this code:
 *
 * 1. Its key is a SERVER-SIDE SECRET. Anything shipped to a browser is public,
 *    so this provider holds no key at all. It talks to the sponsor service's
 *    `/swap/soroswap/*` endpoints, which add the key on the way out and check
 *    who is asking. An integrator points `proxyUrl` at their own sponsor.
 * 2. Its testnet has indexed markets now, but no route for Circle's testnet USDC
 *    ("No path found"), so on testnet the chain falls through to Aquarius.
 * 3. Its integrator fee is no longer a request parameter. `feeBps` is accepted
 *    and recorded but ignored; the rate in force is the partner profile's,
 *    0 or 25 to 300 bps, set on Soroswap's side. The value is still validated
 *    and sent, so the profile can be seeded from what the integrator asked for.
 * 4. On mainnet its aggregator takes a protocol fee off the input (10 bps at the
 *    time of writing), which is already inside the `amountOut` it quotes.
 */

export interface SoroswapOptions {
  readonly network: NetworkId;
  /** The sponsor service that proxies Soroswap, e.g. `https://sponsor.mavna.app`. */
  readonly proxyUrl: string;
  /** What the integrator asked for, in bps. 0, or 25 to 300, as Soroswap allows. */
  readonly feeBps?: number | undefined;
  /** How long a request gets before it is abandoned. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/** Venues Soroswap can route through. */
export const SOROSWAP_PROTOCOLS: readonly [
  "soroswap",
  "phoenix",
  "aqua",
  "sushi",
  "comet",
  "sdex",
] = ["soroswap", "phoenix", "aqua", "sushi", "comet", "sdex"] as const;
export type SoroswapProtocol = (typeof SOROSWAP_PROTOCOLS)[number];

/** The partner rates Soroswap accepts: off, or 25 to 300 bps. */
export const soroswapFeeBps: z.ZodType<number> = basisPoints.refine(
  (bps: number) => bps === 0 || (bps >= 25 && bps <= 300),
  "Soroswap accepts 0, or 25 to 300 basis points",
);

const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "not a contract address");

/**
 * Soroswap documents amounts as strings and shows some as numbers. Either is
 * accepted, but a number must be one a double holds exactly.
 */
const amountOnWire = z.union([
  baseUnits,
  z.number().refine((n) => Number.isSafeInteger(n) && n >= 0, "not an exact integer amount"),
]);

type Network = "mainnet" | "testnet";

/** An amount as Soroswap sends it: a string, or a number it holds exactly. */
export type SoroswapAmount = string | number;

export interface SoroswapRouteLeg {
  readonly swapInfo: {
    readonly protocol: string;
    readonly path: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly percent: string;
  readonly [key: string]: unknown;
}

/**
 * A Soroswap quote, as it travels from Soroswap through the proxy to here and
 * back to /quote/build. Loose on purpose: build wants the quote exactly as
 * Soroswap issued it, unknown fields included, and stripping them would change
 * what it builds. The fields this code relies on are checked.
 */
export interface SoroswapQuote {
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amountIn: SoroswapAmount;
  readonly amountOut: SoroswapAmount;
  readonly otherAmountThreshold: SoroswapAmount;
  readonly tradeType: "EXACT_IN";
  readonly platform: "router" | "aggregator" | "sdex";
  readonly routePlan: readonly SoroswapRouteLeg[];
  readonly rawTrade?: unknown;
  readonly [key: string]: unknown;
}

export const soroswapQuote: z.ZodType<SoroswapQuote> = z.looseObject({
  assetIn: contractAddress,
  assetOut: contractAddress,
  amountIn: amountOnWire,
  amountOut: amountOnWire,
  otherAmountThreshold: amountOnWire,
  tradeType: z.literal("EXACT_IN"),
  platform: z.enum(["router", "aggregator", "sdex"]),
  routePlan: z.array(
    z.looseObject({
      swapInfo: z.looseObject({ protocol: z.string(), path: z.array(z.string()) }),
      percent: z.string(),
    }),
  ),
  rawTrade: z.unknown(),
});

/** What the browser sends the proxy for a quote. */
export interface SoroswapQuoteRequest {
  readonly network: Network;
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amount: string;
  readonly slippageBps: number;
  readonly protocols: readonly SoroswapProtocol[];
  readonly feeBps?: number | undefined;
}

export const soroswapQuoteRequest: z.ZodType<SoroswapQuoteRequest> = z.object({
  network: z.enum(["mainnet", "testnet"]),
  assetIn: contractAddress,
  assetOut: contractAddress,
  amount: positiveBaseUnits,
  slippageBps: basisPoints,
  protocols: z.array(z.enum(SOROSWAP_PROTOCOLS)).min(1),
  feeBps: soroswapFeeBps.optional(),
});

/** What the browser sends the proxy to build a quote it was given. */
export interface SoroswapBuildRequest {
  readonly network: Network;
  readonly quote: SoroswapQuote;
  readonly from: string;
  readonly to: string;
}

export const soroswapBuildRequest: z.ZodType<SoroswapBuildRequest> = z.object({
  network: z.enum(["mainnet", "testnet"]),
  quote: soroswapQuote,
  from: stellarAddress,
  to: stellarAddress,
});

export const soroswapBuilt: z.ZodType<{ readonly xdr: string }> = z.object({
  xdr: z.string().regex(/^[A-Za-z0-9+/]+=*$/, "not base64"),
});

export interface SoroswapHealth {
  readonly network: Network;
  readonly usable: boolean;
  readonly protocols: readonly string[];
}

export const soroswapHealth: z.ZodType<SoroswapHealth> = z.object({
  network: z.enum(["mainnet", "testnet"]),
  usable: z.boolean(),
  protocols: z.array(z.string()),
});

/** The proxy's refusal shape, the same as every other sponsor endpoint. */
const proxyError = z.object({ error: z.string(), retryable: z.boolean() });

export class SoroswapProvider implements SwapProvider {
  readonly id = "soroswap";
  readonly network: NetworkId;
  /**
   * Contract-free: the partner rate is collected by Soroswap and paid out to
   * the partner's address. Whether one is in force is set on Soroswap's side.
   */
  readonly canCollectIntegratorFee = true;

  private readonly proxyUrl: string;
  private readonly feeBps: number | undefined;
  private readonly timeoutMs: number;

  constructor(options: SoroswapOptions) {
    this.network = options.network;
    this.proxyUrl = options.proxyUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (this.proxyUrl === "") {
      throw new MavnaError("Soroswap is reached through a proxy, and none was given.", {
        retryable: false,
      });
    }
    if (options.feeBps !== undefined && !soroswapFeeBps.safeParse(options.feeBps).success) {
      throw new MavnaError(
        `Soroswap takes an integrator fee of 0, or 25 to 300 basis points; got ${options.feeBps}.`,
        { retryable: false },
      );
    }
    this.feeBps = options.feeBps;
  }

  /**
   * Asks the proxy whether Soroswap has indexed markets on this network and its
   * aggregator is up. A sponsor run without a key has no such endpoint, and the
   * answer is then simply no.
   */
  async isUsable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.proxyUrl}/swap/soroswap/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return false;
      const parsed = soroswapHealth.safeParse(await response.json());
      return parsed.success && parsed.data.network === this.network && parsed.data.usable;
    } catch {
      // isUsable answers a question; an unreachable proxy is the answer "no".
      return false;
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const assetIn = toContractId(request.assetIn, this.network);
    const assetOut = toContractId(request.assetOut, this.network);
    const body: SoroswapQuoteRequest = {
      network: this.network,
      assetIn,
      assetOut,
      amount: request.amountIn,
      slippageBps: request.maxSlippageBps,
      protocols: protocolsFor(request.destinationKind),
      ...(this.feeBps === undefined ? {} : { feeBps: this.feeBps }),
    };
    const response = await fetchOrThrow("Soroswap", `${this.proxyUrl}/swap/soroswap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await refusal(response, "price this swap");

    const quote = await readValidated("Soroswap", response, soroswapQuote);
    if (
      quote.assetIn !== assetIn ||
      quote.assetOut !== assetOut ||
      String(quote.amountIn) !== request.amountIn
    ) {
      throw new MavnaError("Soroswap answered a different question than the one asked.", {
        retryable: false,
      });
    }
    const isClassic = quote.platform === "sdex";

    // Belt and braces. The protocol set above should already prevent this, but a
    // classic route to a contract address fails at build time with an opaque
    // error, and catching it here says something useful instead.
    if (isClassic && request.destinationKind === "contract") {
      throw new MavnaError(
        "This route runs through Stellar's built-in orderbook, which cannot deliver " +
          "to a contract address. Route through the aggregator instead.",
        { retryable: false },
      );
    }

    const amountOut = String(quote.amountOut);
    return {
      provider: this.id,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: request.amountIn,
      amountOut,
      // Soroswap computes its own threshold from the slippage we sent; ours is
      // recomputed rather than trusted, because it is what bounds the user.
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      venues: quote.routePlan.map((leg) => leg.swapInfo.protocol),
      isClassicPathPayment: isClassic,
      raw: quote,
    };
  }

  async build(request: SwapBuildRequest): Promise<Transaction> {
    if (request.quote.provider !== this.id) {
      throw new MavnaError("This quote came from another venue; build it there.", {
        retryable: false,
      });
    }
    const quote = soroswapQuote.safeParse(request.quote.raw);
    if (!quote.success) {
      throw new MavnaError("This is not a Soroswap quote this provider issued.", {
        retryable: false,
      });
    }
    const owner = request.account.accountId();
    // Soroswap builds to its own threshold, which it derived from the slippage
    // we sent. Ours is never looser, and it is the one the user agreed to, so a
    // quote whose threshold sits below our floor is refused rather than built.
    if (BigInt(String(quote.data.otherAmountThreshold)) < BigInt(request.quote.amountOutMinimum)) {
      throw new MavnaError("Soroswap's floor for this swap is below the one you agreed to.", {
        retryable: true,
      });
    }
    const body: SoroswapBuildRequest = {
      network: this.network,
      quote: quote.data,
      from: owner,
      to: owner,
    };
    const response = await fetchOrThrow("Soroswap", `${this.proxyUrl}/swap/soroswap/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await refusal(response, "build this swap");
    const built = await readValidated("Soroswap", response, soroswapBuilt);

    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(built.xdr, PASSPHRASE[this.network]);
    } catch (cause) {
      throw new MavnaError("Soroswap built something that is not a transaction.", {
        retryable: false,
        cause,
      });
    }
    // The user is about to sign this. It has to be their own transaction, spending
    // from their own account, on the network they are on.
    if (!("source" in tx) || tx.source !== owner) {
      throw new MavnaError("Soroswap built a transaction for a different account.", {
        retryable: false,
      });
    }
    // and it has to be the swap that was quoted, read from the transaction
    // itself rather than from what the quote said it would be
    const why = soroswapBuildMismatch(tx, {
      network: this.network,
      platform: quote.data.platform,
      owner,
      assetIn: toContractId(request.quote.assetIn, this.network),
      assetOut: toContractId(request.quote.assetOut, this.network),
      amountIn: request.quote.amountIn,
      amountOutMinimum: request.quote.amountOutMinimum,
    });
    if (why !== undefined) {
      throw new MavnaError(`Soroswap built ${why}, not the swap that was quoted.`, {
        retryable: false,
      });
    }
    return tx;
  }
}

/**
 * The contracts a Soroswap build may call, by network.
 *
 * Mainnet: aggregator v3, which the API has built every Soroban swap against
 * since 2026-09-24 (docs.soroswap.finance, aggregator v3 reference), and the
 * Soroswap router (soroswap/core public/mainnet.contracts.json; its deployed
 * wasm hash 4c3db3eb... matches that file). There is no v3 on testnet.
 */
export const SOROSWAP_CONTRACTS: Readonly<
  Record<NetworkId, { readonly aggregator?: string; readonly router: string }>
> = {
  mainnet: {
    aggregator: "CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4",
    router: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
  },
  testnet: { router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD" },
};

export interface SoroswapExpected {
  readonly network: NetworkId;
  readonly platform: "router" | "aggregator" | "sdex";
  readonly owner: string;
  /** Contract ids, as quoted. */
  readonly assetIn: string;
  readonly assetOut: string;
  readonly amountIn: string;
  /** Our floor, which the built minimum may not undercut. */
  readonly amountOutMinimum: string;
}

const STROOPS_PER_UNIT = 10_000_000n;

/** A classic amount ("56.2468868") in base units. */
function classicUnits(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0").slice(0, 7));
}

/**
 * Why a built transaction is not the quoted swap, or undefined when it is.
 *
 * One operation, sourced by the owner, and for each platform the call it must
 * be: aggregator v3 `swap_exact_in` (user, token_in, amount_in, token_out,
 * min_out, routes, partner), which pays `user`; the router's
 * `swap_exact_tokens_for_tokens` (amount_in, amount_out_min, path, to,
 * deadline); or a classic strict-send path payment to the owner. In every case
 * exactly the quoted input, the quoted tokens at both ends, and a minimum at or
 * above ours.
 */
export function soroswapBuildMismatch(
  tx: Transaction,
  expected: SoroswapExpected,
): string | undefined {
  if (tx.operations.length !== 1) return `${tx.operations.length} operations`;
  const [op] = tx.operations;
  if (op === undefined) return "nothing";
  if (op.source !== undefined && op.source !== expected.owner) {
    return "an operation for another account";
  }
  const floor = BigInt(expected.amountOutMinimum);
  const amountIn = BigInt(expected.amountIn);

  if (expected.platform === "sdex") {
    if (op.type !== "pathPaymentStrictSend") return `a ${op.type} operation`;
    const passphrase = PASSPHRASE[expected.network];
    if (op.destination !== expected.owner) return "a payment to another account";
    if (op.sendAsset.contractId(passphrase) !== expected.assetIn)
      return "a payment of another asset";
    if (op.destAsset.contractId(passphrase) !== expected.assetOut)
      return "a payment into another asset";
    if (classicUnits(op.sendAmount) !== amountIn) return "a payment of another amount";
    if (classicUnits(op.destMin) < floor) return "a payment with a lower minimum";
    return undefined;
  }

  if (op.type !== "invokeHostFunction") return `a ${op.type} operation`;
  const fn = op.func;
  if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return "something other than a contract call";
  }
  const call = fn.invokeContract();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  const name = call.functionName().toString();
  let args: unknown[];
  try {
    args = call.args().map((arg) => scValToNative(arg) as unknown);
  } catch {
    return "a call with arguments that cannot be read";
  }
  const known = SOROSWAP_CONTRACTS[expected.network];

  if (expected.platform === "aggregator") {
    if (known.aggregator === undefined || contract !== known.aggregator)
      return "a call to another contract";
    if (name !== "swap_exact_in" || args.length !== 7) return `a call to ${name}`;
    const [user, tokenIn, gross, tokenOut, minOut, routes] = args;
    if (user !== expected.owner) return "a swap paying another account";
    if (tokenIn !== expected.assetIn || tokenOut !== expected.assetOut)
      return "a swap of other tokens";
    if (typeof gross !== "bigint" || gross !== amountIn) return "a swap of another amount";
    if (typeof minOut !== "bigint" || minOut < floor) return "a swap with a lower minimum";
    if (!Array.isArray(routes) || routes.length === 0) return "a swap with no route";
    for (const route of routes) {
      const ends = routeEnds(route);
      if (ends === undefined || ends[0] !== expected.assetIn || ends[1] !== expected.assetOut) {
        return "a route between other tokens";
      }
    }
    return undefined;
  }

  if (contract !== known.router) return "a call to another contract";
  if (name !== "swap_exact_tokens_for_tokens" || args.length !== 5) return `a call to ${name}`;
  const [gross, minOut, path, to] = args;
  if (to !== expected.owner) return "a swap paying another account";
  if (typeof gross !== "bigint" || gross !== amountIn) return "a swap of another amount";
  if (typeof minOut !== "bigint" || minOut < floor) return "a swap with a lower minimum";
  if (!Array.isArray(path) || path[0] !== expected.assetIn || path.at(-1) !== expected.assetOut) {
    return "a swap between other tokens";
  }
  return undefined;
}

/** The token a v3 route starts from and the one it ends in. */
function routeEnds(route: unknown): [unknown, unknown] | undefined {
  if (typeof route !== "object" || route === null) return undefined;
  const hops = (route as { hops?: unknown }).hops;
  if (!Array.isArray(hops) || hops.length === 0) return undefined;
  const body = (hop: unknown): Record<string, unknown> | undefined =>
    Array.isArray(hop) && typeof hop[1] === "object" && hop[1] !== null
      ? (hop[1] as Record<string, unknown>)
      : undefined;
  const first = body(hops[0]);
  const last = body(hops.at(-1));
  if (first === undefined || last === undefined) return undefined;
  // an Aquarius hop names what it produces in its last step, the others directly
  const steps = last.steps;
  const out = Array.isArray(steps) ? (steps.at(-1) as unknown[] | undefined)?.[2] : last.token_out;
  return [first.token_in, out];
}

/**
 * Which venues may be used, decided by where the money is going.
 *
 * Stellar's built-in orderbook is excluded for contract destinations. Soroswap's
 * own guidance is blunt about it: "Exclude 'sdex' for smart wallets". Their
 * on-chain aggregator only handles Soroban protocols, so orderbook routes execute
 * as classic path payments, and a classic path payment cannot pay a contract.
 *
 * The sharp edge is that the orderbook OFTEN WINS ON PRICE, so including it and
 * discovering the problem at build time is a real trap. Decide first.
 */
export function protocolsFor(destinationKind: "account" | "contract"): SoroswapProtocol[] {
  const soroban: SoroswapProtocol[] = ["soroswap", "phoenix", "aqua", "sushi", "comet"];
  return destinationKind === "contract" ? soroban : [...soroban, "sdex"];
}

/** Turn a proxy refusal into an error with the proxy's own retry advice. */
async function refusal(response: Response, what: string): Promise<MavnaError> {
  let parsed: z.infer<typeof proxyError> | undefined;
  try {
    const result = proxyError.safeParse(await response.json());
    if (result.success) parsed = result.data;
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    return new MavnaError(`Soroswap could not ${what}: ${parsed.error}`, {
      retryable: parsed.retryable,
    });
  }
  return new MavnaError(`Soroswap could not ${what} (HTTP ${response.status}).`, {
    retryable: response.status === 429 || response.status >= 500,
  });
}
