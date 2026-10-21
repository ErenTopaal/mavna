import { type ComposeHop, MavnaError, type NetworkId } from "@mavna/core";
import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { Address, nativeToScVal, scValToNative, type Transaction, xdr } from "@stellar/stellar-sdk";
import * as z from "zod";
import {
  applySlippage,
  type SwapBuildRequest,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
  SwapRefusal,
  type Usability,
} from "./provider.js";
import { buildContractCall, readContract } from "./soroban.js";
import {
  boundedBy,
  causeOf,
  fetchOrThrow,
  readValidated,
  toContractId,
  validated,
} from "./wire.js";

/**
 * Aquarius. The fallback venue, on both networks.
 *
 * Needs no key, has real liquidity on testnet (including Circle's testnet USDC
 * now), and routes across its own pools. Its swaps run through its router
 * contract, so they can deliver to a contract address, which is what makes it a
 * venue the Arrival Contract can call.
 *
 * It earns us nothing, and that is a deliberate accepted trade rather than an
 * oversight. Its `provider_fee` parameter is quote ARITHMETIC ONLY: it changes
 * the displayed net figure and moves no money, and there is no recipient field
 * anywhere in its request. Verified against the live service: passing a fee
 * changed only the reported `amount_with_fee` and left the actual `amount`
 * identical.
 */

const BASE_URL: Readonly<Record<NetworkId, string>> = {
  testnet: "https://amm-api-testnet.aqua.network",
  mainnet: "https://amm-api.aqua.network",
};

/**
 * The router every pool trusts, read from the `Router` key of a live pool's
 * instance storage on each network. Mainnet's also matches Aquarius's docs.
 */
const ROUTER: Readonly<Record<NetworkId, string>> = {
  mainnet: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  testnet: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
};

const DEFAULT_RPC: Readonly<Record<NetworkId, string>> = {
  mainnet: PUBLIC_MAINNET_RPC_URLS[0] ?? "",
  testnet: PUBLIC_TESTNET_RPC_URL,
};

/** Without a bound, a hung exchange holds the whole route race open. */
const DEFAULT_TIMEOUT_MS = 10_000;

const findPath = z.object({
  success: z.boolean(),
  swap_chain_xdr: z.string(),
  pools: z.array(z.string()),
  tokens_addresses: z.array(z.string()),
  // The service reports amounts as JSON numbers. Anything above what a double
  // holds exactly was already mangled before it reached us, so it is refused.
  amount: z.number().refine(Number.isSafeInteger, "not an exact integer amount"),
});

/** What build needs from a quote, kept as the quote's raw payload. */
const aquariusRaw = z.object({
  tokenIn: z.string().regex(/^C[A-Z2-7]{55}$/),
  tokenOut: z.string().regex(/^C[A-Z2-7]{55}$/),
  swapChainXdr: z.string(),
});

/**
 * The swap chain decoded and walked, or why it cannot be used.
 *
 * `swap_chained` executes this chain, not the answer's token list, so the
 * chain itself has to start where we asked, connect hop to hop, and end in the
 * asked token: `out_min` is enforced in whatever the last step produces. Each
 * step is (pool's token set, pool hash, token out of this step).
 */
export function swapChainMismatch(
  chainXdr: string,
  tokenIn: string,
  tokenOut: string,
): string | undefined {
  let steps: unknown;
  try {
    steps = scValToNative(xdr.ScVal.fromXdr(chainXdr, "base64"));
  } catch {
    return "does not decode";
  }
  if (!Array.isArray(steps) || steps.length === 0) return "is empty";
  let holding = tokenIn;
  for (const step of steps) {
    if (!Array.isArray(step) || step.length !== 3) return "has a step that is not a pool swap";
    const [tokens, , out] = step as [unknown, unknown, unknown];
    if (!Array.isArray(tokens) || typeof out !== "string") return "has a step that cannot be read";
    if (!tokens.includes(holding) || !tokens.includes(out) || out === holding) {
      return "has a step that does not take what the one before produced";
    }
    holding = out;
  }
  return holding === tokenOut ? undefined : "ends in another token";
}

const poolsPage = z.object({ count: z.number().int() });

export interface AquariusOptions {
  readonly timeoutMs?: number;
  /** Stellar RPC used to simulate the swap at build time. */
  readonly rpcUrl?: string;
}

export class AquariusProvider implements SwapProvider {
  readonly id = "aquarius";
  readonly network: NetworkId;
  /** No contract-free mechanism exists. See the note at the top of this file. */
  readonly canCollectIntegratorFee = false;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rpcUrl: string;

  constructor(network: NetworkId, baseUrl?: string, options: AquariusOptions = {}) {
    this.network = network;
    this.baseUrl = baseUrl ?? BASE_URL[network];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rpcUrl = options.rpcUrl ?? DEFAULT_RPC[network];
  }

  async isUsable(): Promise<boolean> {
    return (await this.usability()).usable;
  }

  async usability(): Promise<Usability> {
    const url = `${this.baseUrl}/api/external/v1/pools/?size=1`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok)
        return { usable: false, because: `${url} answered HTTP ${response.status}` };
      const parsed = poolsPage.safeParse(await response.json());
      if (!parsed.success) return { usable: false, because: `${url} answered in another shape` };
      return parsed.data.count > 0
        ? { usable: true }
        : { usable: false, because: "Aquarius lists no pools on this network" };
    } catch (cause) {
      // isUsable answers a question; an unreachable service is the answer "no".
      return { usable: false, because: `${url} did not answer (${causeOf(cause)})` };
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    const tokenIn = toContractId(request.assetIn, this.network);
    const tokenOut = toContractId(request.assetOut, this.network);
    const response = await fetchOrThrow("Aquarius", `${this.baseUrl}/api/external/v1/find-path/`, {
      signal: boundedBy(this.timeoutMs, request.signal),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenIn,
        token_out_address: tokenOut,
        amount: request.amountIn,
      }),
    });

    if (!response.ok) {
      throw new MavnaError(`Aquarius could not price this swap (HTTP ${response.status}).`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const body = await readValidated("Aquarius", response, findPath);

    if (!body.success || body.pools.length === 0) {
      throw new MavnaError("Aquarius has no route between these assets.", { retryable: false });
    }
    // The chain is what gets executed, so it has to start and end where we asked.
    if (body.tokens_addresses[0] !== tokenIn || body.tokens_addresses.at(-1) !== tokenOut) {
      throw new MavnaError("Aquarius answered a different question than the one asked.", {
        retryable: false,
      });
    }

    const chainWhy = swapChainMismatch(body.swap_chain_xdr, tokenIn, tokenOut);
    if (chainWhy !== undefined) {
      throw new MavnaError(`Aquarius returned a swap path that ${chainWhy}.`, {
        retryable: false,
      });
    }

    // The service's figure can lag the pools: on testnet it went on quoting a
    // pool as it was before a swap moved it, and a floor set from that reverts.
    // The router prices the same chain against the pools as they are now.
    const quoted = BigInt(body.amount);
    const now = await this.priceChain(
      tokenIn,
      decodeSwapChain(body.swap_chain_xdr),
      BigInt(request.amountIn),
      request.signal,
    );
    const amountOut = (now < quoted ? now : quoted).toString();

    return {
      provider: this.id,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: request.amountIn,
      amountOut,
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      venues: [...body.pools],
      // Aquarius routes through Soroban pools, so this is never a classic path
      // payment and can therefore deliver to a contract address.
      isClassicPathPayment: false,
      raw: { tokenIn, tokenOut, swapChainXdr: body.swap_chain_xdr },
    };
  }

  /** What the router's `estimate_swap` gives for `amountIn` along these hops, now. */
  private async priceChain(
    tokenIn: string,
    hops: readonly ComposeHop[],
    amountIn: bigint,
    signal: AbortSignal | undefined,
  ): Promise<bigint> {
    let holding = tokenIn;
    let amount = amountIn;
    for (const hop of hops) {
      let estimate: xdr.ScVal;
      try {
        estimate = await readContract(
          this.rpcUrl,
          this.network,
          ROUTER[this.network],
          "estimate_swap",
          [
            xdr.ScVal.scvVec(hop.tokens.map((t) => new Address(t).toScVal())),
            new Address(holding).toScVal(),
            new Address(hop.tokenOut).toScVal(),
            xdr.ScVal.scvBytes(bytesOfHex(hop.poolIndex)),
            nativeToScVal(amount, { type: "u128" }),
          ],
          this.timeoutMs,
          "Aquarius",
          signal,
        );
      } catch (cause) {
        if (cause instanceof MavnaError && cause.retryable) throw cause;
        throw new SwapRefusal(
          "Aquarius's router would not price the path its service found.",
          causeOf(cause),
          { retryable: true, cause },
        );
      }
      amount = BigInt(scValToNative(estimate) as bigint);
      holding = hop.tokenOut;
    }
    return amount;
  }

  /**
   * The same quote with the route as hops, for a contract that calls the router
   * itself (the Arrival Contract). The hops are checked to start from what is
   * sold and end in what is bought, so a chain for some other pair is refused.
   */
  async quotePath(
    request: Omit<SwapQuoteRequest, "destinationKind"> & {
      /**
       * The only tokens the path may pass through. Given, the path is built from
       * the router's own pools between these, not from Aquarius's quoting
       * service, which routes through whatever token prices best.
       */
      readonly via?: readonly string[];
    },
  ): Promise<PathQuote> {
    if (request.via !== undefined) return this.listedPath({ ...request, via: request.via });
    const quote = await this.quote({ ...request, destinationKind: "contract" });
    // quote() has already walked this chain from the asked token to the asked one
    const raw = validated("Aquarius", aquariusRaw, quote.raw);
    const path = decodeSwapChain(raw.swapChainXdr);
    let holding = raw.tokenIn;
    for (const hop of path) {
      if (!hop.tokens.includes(holding) || !hop.tokens.includes(hop.tokenOut)) {
        throw new MavnaError("Aquarius returned a swap chain that does not connect.", {
          retryable: false,
        });
      }
      holding = hop.tokenOut;
    }
    if (holding !== raw.tokenOut) {
      throw new MavnaError("Aquarius returned a swap chain that ends in another asset.", {
        retryable: false,
      });
    }
    return {
      provider: quote.provider,
      amountOut: quote.amountOut,
      amountOutMinimum: quote.amountOutMinimum,
      path,
    };
  }

  /**
   * The best path from `assetIn` to `assetOut` that touches only listed
   * tokens: straight, or one hop through each token in `via`. Pools come from
   * the router's `get_pools` and each hop is priced by its `estimate_swap`, so
   * the path is one the router itself would run, between tokens the Arrival
   * Contract will call.
   */
  private async listedPath(request: {
    readonly assetIn: string;
    readonly assetOut: string;
    readonly amountIn: string;
    readonly maxSlippageBps: number;
    readonly via: readonly string[];
  }): Promise<PathQuote> {
    const router = ROUTER[this.network];
    const read = (method: string, args: xdr.ScVal[]) =>
      readContract(this.rpcUrl, this.network, router, method, args, this.timeoutMs, "Aquarius");
    // the router keys a pool by its tokens in address byte order, not string order
    const ordered = (tokens: readonly string[]): string[] =>
      [...tokens].sort((a, b) =>
        compareBytes(new Address(a).toScAddress().toXdr(), new Address(b).toScAddress().toXdr()),
      );
    const vecOf = (tokens: readonly string[]) =>
      xdr.ScVal.scvVec(tokens.map((t) => new Address(t).toScVal()));

    // a pool key is the 32 bytes the router hands out, passed back as they came
    type PoolKey = Uint8Array;
    const pools = new Map<string, readonly PoolKey[]>();
    // the router's refusals, kept for the answer when nothing connects
    const refusals: string[] = [];
    const unreadablePools = (): never => {
      throw new MavnaError(
        "The Aquarius router listed its pools in a shape it does not document.",
        {
          retryable: false,
        },
      );
    };
    const poolsOf = async (tokens: readonly string[]): Promise<readonly PoolKey[]> => {
      const key = tokens.join(",");
      const known = pools.get(key);
      if (known !== undefined) return known;
      let found: PoolKey[] = [];
      try {
        const answer = await read("get_pools", [vecOf(tokens)]);
        found =
          answer.type === "scvMap"
            ? (answer.map ?? []).map((entry) =>
                entry.key.type === "scvBytes" ? entry.key.bytes.toBytes() : unreadablePools(),
              )
            : unreadablePools();
      } catch (cause) {
        // a node that did not answer is not a pair with no pools
        if (cause instanceof MavnaError && cause.retryable) throw cause;
        refusals.push(`get_pools: ${causeOf(cause)}`);
        found = [];
      }
      pools.set(key, found);
      return found;
    };

    const bestHop = async (
      from: string,
      to: string,
      amount: bigint,
    ): Promise<{ out: bigint; hop: ComposeHop } | undefined> => {
      const tokens = ordered([from, to]);
      let best: { out: bigint; hop: ComposeHop } | undefined;
      for (const index of await poolsOf(tokens)) {
        let out: bigint;
        try {
          const estimate = await read("estimate_swap", [
            vecOf(tokens),
            new Address(from).toScVal(),
            new Address(to).toScVal(),
            xdr.ScVal.scvBytes(index),
            nativeToScVal(amount, { type: "u128" }),
          ]);
          out = BigInt(scValToNative(estimate) as bigint);
        } catch (cause) {
          if (cause instanceof MavnaError && cause.retryable) throw cause;
          refusals.push(`estimate_swap: ${causeOf(cause)}`);
          continue;
        }
        if (best === undefined || out > best.out) {
          best = { out, hop: { tokens, poolIndex: hexOf(index), tokenOut: to } };
        }
      }
      return best;
    };

    const routes: string[][] = [
      [request.assetIn, request.assetOut],
      ...request.via
        .filter((t) => t !== request.assetIn && t !== request.assetOut)
        .map((t) => [request.assetIn, t, request.assetOut]),
    ];
    let best: { out: bigint; path: ComposeHop[] } | undefined;
    for (const route of routes) {
      let amount = BigInt(request.amountIn);
      const path: ComposeHop[] = [];
      for (let i = 0; i + 1 < route.length; i++) {
        const hop = await bestHop(route[i] as string, route[i + 1] as string, amount);
        if (hop === undefined || hop.out <= 0n) {
          path.length = 0;
          break;
        }
        path.push(hop.hop);
        amount = hop.out;
      }
      if (path.length === route.length - 1 && (best === undefined || amount > best.out)) {
        best = { out: amount, path };
      }
    }
    if (best === undefined) {
      // the router's own refusals are an operator's to read, not the user's
      throw new SwapRefusal(
        "Aquarius has no pools that connect these assets through tokens the Arrival Contract uses.",
        [...new Set(refusals)].join("; "),
        { retryable: false },
      );
    }
    const amountOut = best.out.toString();
    return {
      provider: this.id,
      amountOut,
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      path: best.path,
    };
  }

  /**
   * `swap_chained(user, swaps_chain, token_in, in_amount, out_min)` on the
   * router, the call Aquarius documents for a strict-send swap along a found
   * path. The owner is both payer and recipient.
   */
  async build(request: SwapBuildRequest): Promise<Transaction> {
    if (request.quote.provider !== this.id) {
      throw new MavnaError("This quote came from another venue; build it there.", {
        retryable: false,
      });
    }
    const raw = validated("Aquarius", aquariusRaw, request.quote.raw);
    // the quote travelled through the caller, so what executes is checked again
    if (
      raw.tokenIn !== toContractId(request.quote.assetIn, this.network) ||
      raw.tokenOut !== toContractId(request.quote.assetOut, this.network)
    ) {
      throw new MavnaError("Aquarius returned a swap path for other tokens.", { retryable: false });
    }
    const chainWhy = swapChainMismatch(raw.swapChainXdr, raw.tokenIn, raw.tokenOut);
    if (chainWhy !== undefined) {
      throw new MavnaError(`Aquarius returned a swap path that ${chainWhy}.`, {
        retryable: false,
      });
    }
    let chain: xdr.ScVal;
    try {
      chain = xdr.ScVal.fromXdr(raw.swapChainXdr, "base64");
    } catch (cause) {
      throw new MavnaError("Aquarius returned a swap path that does not decode.", {
        retryable: false,
        cause,
      });
    }
    return buildContractCall(
      this.rpcUrl,
      this.network,
      request.account,
      ROUTER[this.network],
      "swap_chained",
      [
        new Address(request.account.accountId()).toScVal(),
        chain,
        new Address(raw.tokenIn).toScVal(),
        nativeToScVal(BigInt(request.quote.amountIn), { type: "u128" }),
        nativeToScVal(BigInt(request.quote.amountOutMinimum), { type: "u128" }),
      ],
      this.timeoutMs,
      "Aquarius",
    );
  }
}

/** A venue quote that a contract can execute itself, hop by hop. */
export interface PathQuote {
  readonly provider: string;
  readonly amountOut: string;
  readonly amountOutMinimum: string;
  readonly path: readonly ComposeHop[];
}

/**
 * Decode Aquarius's swap chain into the hops its router takes.
 *
 * The chain is the router's own `swap_chained` argument,
 * `Vec<(Vec<Address>, BytesN<32>, Address)>`, so a contract that calls the
 * router with these hops runs exactly the route that was priced. Anything not
 * in that shape is refused rather than guessed at.
 */
export function decodeSwapChain(swapChainXdr: string): readonly ComposeHop[] {
  let chain: xdr.ScVal;
  try {
    chain = xdr.ScVal.fromXdr(swapChainXdr, "base64");
  } catch (cause) {
    throw new MavnaError("Aquarius returned a swap chain that is not readable.", {
      retryable: false,
      cause,
    });
  }
  const bad = (): never => {
    throw new MavnaError("Aquarius returned a swap chain in a shape its router does not take.", {
      retryable: false,
    });
  };
  const vec = (v: xdr.ScVal): xdr.ScVal[] => (v.type === "scvVec" ? (v.vec ?? []) : bad());
  const address = (v: xdr.ScVal): string =>
    v.type === "scvAddress" ? Address.fromScVal(v).toString() : bad();

  const hops = vec(chain).map((hop): ComposeHop => {
    const [tokens, index, out] = vec(hop);
    if (tokens === undefined || index === undefined || out === undefined || vec(hop).length !== 3) {
      return bad();
    }
    const indexBytes = index.type === "scvBytes" ? index.bytes.toBytes() : bad();
    if (indexBytes.length !== 32) bad();
    return {
      tokens: vec(tokens).map(address),
      poolIndex: hexOf(indexBytes),
      tokenOut: address(out),
    };
  });
  if (hops.length === 0) bad();
  return hops;
}

// the browser has no Buffer global, so bytes are handled as plain Uint8Array

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function bytesOfHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
