import { MavnaError, type NetworkId } from "@mavna/core";
import { PUBLIC_MAINNET_RPC_URLS } from "@mavna/stellar";
import {
  Address,
  nativeToScVal,
  StrKey,
  scValToNative,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import * as z from "zod";
import {
  applySlippage,
  type SwapBuildRequest,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
  type Usability,
} from "./provider.js";
import { buildContractCall, readContract, rpcHealth } from "./soroban.js";
import { toContractId, validated } from "./wire.js";

/**
 * SushiSwap's concentrated-liquidity pools on Stellar. The venue for USDT0.
 *
 * Sushi publishes no HTTP API for Stellar. Its own app prices by simulating the
 * router's `quote_exact_input` and swaps with `swap_exact_input_hints`, passing
 * each pool's oracle hints so the transaction's footprint is fixed. This does
 * the same, against the same contracts.
 *
 * Mainnet only: Sushi lists Stellar mainnet and no test network, so on testnet
 * this provider says it is unusable rather than pretending.
 */

/**
 * Addresses from Sushi's own sources: the `sushi` npm package's Stellar config
 * (factory, and the router under its quoter name) and the router entry in
 * Sushi's web app. The router is also the quoter.
 */
const FACTORY = "CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF";
const ROUTER = "CDMIM23WOUL5CZBKX3GOA3V5R5AMVIMTCP52KCDQORWELAPLJ27WZCHL";

/** The fee tiers Sushi's Stellar app creates pools at, in hundredths of a bip. */
const FEE_TIERS = [500, 3000, 10_000] as const;

/**
 * Intermediate assets for two-hop routes. There is no direct USDT0/XLM pool,
 * and USDC is where USDT0's liquidity sits, so one hop through either reaches
 * the pairs people actually convert between.
 */
const HUBS = ["USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "native"] as const;

/** Simulation needs addresses for sender and recipient; nothing is moved. */
const ZERO_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Pools exist or they do not, and they are never removed, so a lookup holds a while. */
const POOL_CACHE_MS = 10 * 60_000;

const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "not a contract address");
const quoteResult = z.object({ amount: z.bigint() });
const oracleHints = z.object({
  checkpoint: z.number().int().nonnegative(),
  checkpoint_min: z.number().int().nonnegative(),
  slot: z.bigint(),
});
const sushiRaw = z.object({
  path: z.array(contractAddress).min(2),
  fees: z.array(z.number().int()),
  pools: z.array(contractAddress),
});
type SushiRoute = z.infer<typeof sushiRaw>;

export interface SushiSwapOptions {
  readonly network: NetworkId;
  /** Stellar RPC to simulate against. Defaults to a public mainnet endpoint. */
  readonly rpcUrl?: string;
  /** Per simulation. Defaults to 8 seconds. */
  readonly timeoutMs?: number;
}

export class SushiSwapProvider implements SwapProvider {
  readonly id = "sushiswap";
  readonly network: NetworkId;
  /** The router takes no fee or recipient parameter of ours. */
  readonly canCollectIntegratorFee = false;

  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly pools = new Map<string, { pool: string | undefined; at: number }>();

  constructor(options: SushiSwapOptions) {
    this.network = options.network;
    this.rpcUrl = options.rpcUrl ?? PUBLIC_MAINNET_RPC_URLS[0] ?? "";
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async isUsable(): Promise<boolean> {
    return (await this.usability()).usable;
  }

  async usability(): Promise<Usability> {
    if (this.network !== "mainnet") {
      return { usable: false, because: "SushiSwap has no deployment on this network" };
    }
    return rpcHealth(this.rpcUrl, this.timeoutMs);
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    if (this.network !== "mainnet") {
      throw new MavnaError("SushiSwap has no deployment on Stellar's test network.", {
        retryable: false,
      });
    }
    const tokenIn = toContractId(request.assetIn, this.network);
    const tokenOut = toContractId(request.assetOut, this.network);
    const candidates = await this.routesBetween(tokenIn, tokenOut, request.signal);
    if (candidates.length === 0) {
      throw new MavnaError("SushiSwap has no pool path between these assets.", {
        retryable: false,
      });
    }

    const priced = await Promise.allSettled(
      candidates.map(async (route) => ({
        route,
        amount: await this.price(route, request.amountIn, request.signal),
      })),
    );
    let best: { route: SushiRoute; amount: bigint } | undefined;
    let anyRetryable = false;
    for (const outcome of priced) {
      if (outcome.status === "rejected") {
        const reason: unknown = outcome.reason;
        anyRetryable ||= !(reason instanceof MavnaError) || reason.retryable;
        continue;
      }
      if (best === undefined || outcome.value.amount > best.amount) best = outcome.value;
    }
    if (best === undefined || best.amount <= 0n) {
      throw new MavnaError("SushiSwap could not price this swap on any of its pools.", {
        retryable: anyRetryable,
      });
    }

    const amountOut = best.amount.toString();
    return {
      provider: this.id,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: request.amountIn,
      amountOut,
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      venues: best.route.pools,
      isClassicPathPayment: false,
      raw: best.route,
    };
  }

  /**
   * `swap_exact_input_hints` with fresh oracle hints for every pool on the path.
   *
   * The hints pin which oracle slot the swap touches, and the slot moves every
   * minute, so they are read here at build time rather than kept from the quote.
   */
  async build(request: SwapBuildRequest): Promise<Transaction> {
    if (request.quote.provider !== this.id) {
      throw new MavnaError("This quote came from another venue; build it there.", {
        retryable: false,
      });
    }
    const route = validated("SushiSwap", sushiRaw, request.quote.raw);
    // the quote travelled through the caller, so what executes is checked again
    if (
      route.path[0] !== toContractId(request.quote.assetIn, this.network) ||
      route.path.at(-1) !== toContractId(request.quote.assetOut, this.network)
    ) {
      throw new MavnaError("SushiSwap was handed a swap path for other tokens.", {
        retryable: false,
      });
    }
    if (route.fees.length !== route.path.length - 1 || route.pools.length !== route.fees.length) {
      throw new MavnaError("SushiSwap was handed a swap path that does not hold together.", {
        retryable: false,
      });
    }
    const hints = await Promise.all(route.pools.map((pool) => this.hintsFor(pool)));
    const owner = request.account.accountId();
    return buildContractCall(
      this.rpcUrl,
      this.network,
      request.account,
      ROUTER,
      "swap_exact_input_hints",
      [
        exactInputParams(route, request.quote.amountIn, request.quote.amountOutMinimum, owner),
        xdr.ScVal.scvVec(hints),
      ],
      this.timeoutMs,
      "SushiSwap",
    );
  }

  /** Every direct and one-hub path whose every hop has a pool. */
  private async routesBetween(
    tokenIn: string,
    tokenOut: string,
    caller: AbortSignal | undefined,
  ): Promise<SushiRoute[]> {
    const hubs = HUBS.map((hub) => toContractId(hub, this.network)).filter(
      (hub) => hub !== tokenIn && hub !== tokenOut,
    );
    const [direct, ...viaHubs] = await Promise.all([
      this.poolsFor(tokenIn, tokenOut, caller),
      ...hubs.flatMap((hub) => [
        this.poolsFor(tokenIn, hub, caller),
        this.poolsFor(hub, tokenOut, caller),
      ]),
    ]);
    const routes: SushiRoute[] = (direct ?? []).map(({ fee, pool }) => ({
      path: [tokenIn, tokenOut],
      fees: [fee],
      pools: [pool],
    }));
    hubs.forEach((hub, index) => {
      const first = viaHubs[index * 2] ?? [];
      const second = viaHubs[index * 2 + 1] ?? [];
      for (const a of first) {
        for (const b of second) {
          routes.push({
            path: [tokenIn, hub, tokenOut],
            fees: [a.fee, b.fee],
            pools: [a.pool, b.pool],
          });
        }
      }
    });
    return routes;
  }

  private async poolsFor(
    a: string,
    b: string,
    caller: AbortSignal | undefined,
  ): Promise<{ fee: number; pool: string }[]> {
    const found = await Promise.all(
      FEE_TIERS.map(async (fee) => ({ fee, pool: await this.poolAt(a, b, fee, caller) })),
    );
    return found.flatMap(({ fee, pool }) => (pool === undefined ? [] : [{ fee, pool }]));
  }

  /** The factory orders a pair by the raw bytes of the addresses, not their text. */
  private async poolAt(
    a: string,
    b: string,
    fee: number,
    caller: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const [token0, token1] =
      StrKey.decodeContract(a).compare(StrKey.decodeContract(b)) < 0 ? [a, b] : [b, a];
    const key = `${token0}:${token1}:${fee}`;
    const cached = this.pools.get(key);
    if (cached !== undefined && Date.now() - cached.at < POOL_CACHE_MS) return cached.pool;
    const value = await readContract(
      this.rpcUrl,
      this.network,
      FACTORY,
      "get_pool",
      [address(token0), address(token1), nativeToScVal(fee, { type: "u32" })],
      this.timeoutMs,
      "SushiSwap",
      caller,
    );
    const pool = validated(
      "SushiSwap",
      z.union([contractAddress, z.null(), z.undefined()]),
      scValToNative(value),
    );
    this.pools.set(key, { pool: pool ?? undefined, at: Date.now() });
    return pool ?? undefined;
  }

  private async price(
    route: SushiRoute,
    amountIn: string,
    caller: AbortSignal | undefined,
  ): Promise<bigint> {
    const value = await readContract(
      this.rpcUrl,
      this.network,
      ROUTER,
      "quote_exact_input",
      [exactInputParams(route, amountIn, "0", ZERO_ACCOUNT)],
      this.timeoutMs,
      "SushiSwap",
      caller,
    );
    return validated("SushiSwap", quoteResult, scValToNative(value)).amount;
  }

  private async hintsFor(pool: string): Promise<xdr.ScVal> {
    const value = await readContract(
      this.rpcUrl,
      this.network,
      pool,
      "get_oracle_hints",
      [],
      this.timeoutMs,
      "SushiSwap",
    );
    // A pool missing checkpoint_min is one of Sushi's legacy pools, which its own
    // app refuses to swap through, and so does this.
    const hints = validated("SushiSwap", oracleHints, scValToNative(value));
    return struct({
      checkpoint: nativeToScVal(hints.checkpoint, { type: "u32" }),
      checkpoint_min: nativeToScVal(hints.checkpoint_min, { type: "u32" }),
      slot: nativeToScVal(hints.slot, { type: "u128" }),
    });
  }
}

/** The router's `ExactInputParams`. */
function exactInputParams(
  route: SushiRoute,
  amountIn: string,
  amountOutMinimum: string,
  owner: string,
): xdr.ScVal {
  return struct({
    amount_in: nativeToScVal(BigInt(amountIn), { type: "i128" }),
    amount_out_minimum: nativeToScVal(BigInt(amountOutMinimum), { type: "i128" }),
    // Five minutes: past the transaction's own two-minute bound, so the deadline
    // never fails a transaction the network would still accept.
    deadline: nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 300), { type: "u64" }),
    fees: xdr.ScVal.scvVec(route.fees.map((fee) => nativeToScVal(fee, { type: "u32" }))),
    path: xdr.ScVal.scvVec(route.path.map(address)),
    recipient: address(owner),
    sender: address(owner),
  });
}

function address(value: string): xdr.ScVal {
  return new Address(value).toScVal();
}

/** A contract struct is a map with its field names as symbols, in sorted order. */
function struct(fields: Readonly<Record<string, xdr.ScVal>>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val: fields[key] ?? xdr.ScVal.scvVoid(),
          }),
      ),
  );
}
