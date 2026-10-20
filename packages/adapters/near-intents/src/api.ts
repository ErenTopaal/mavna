import { MavnaError } from "@mavna/core";

/**
 * The 1Click Swap API, the one door into NEAR Intents this rail uses.
 *
 * Everything that comes back is read as input rather than truth: each field this
 * package acts on is checked for shape on the way in, and a reply missing one is
 * an error rather than something to default around. The amounts in particular
 * end up in a transaction somebody signs.
 *
 * Written against OpenAPI 0.1.10 (https://1click.chaindefuser.com/docs/v0/openapi.yaml).
 */

export const ONE_CLICK_URL = "https://1click.chaindefuser.com";

/**
 * How long one call gets. A quote races other rails under a three second bound,
 * but a status read or a build has no race to lose, and an indexer that takes
 * longer than this is better reported than waited on.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface OneClickOptions {
  readonly baseUrl?: string;
  /**
   * A partner JWT from https://partners.near-intents.org. Optional: without it
   * 1Click still quotes, and adds 25 basis points to every quote on top of its
   * partner schedule. Sent as `X-API-Key`. Never put one in a browser bundle.
   */
  readonly apiKey?: string;
  /** How requests leave. Injectable so a test can stand at the network boundary. */
  readonly fetch?: typeof fetch;
}

export interface OneClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  /** The chain's own identity for the token, when it has one. Absent for native coins. */
  readonly contractAddress: string | undefined;
}

export interface QuoteBody {
  readonly dry: boolean;
  readonly swapType: "EXACT_INPUT";
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: "ORIGIN_CHAIN";
  readonly destinationAsset: string;
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: "ORIGIN_CHAIN";
  readonly recipient: string;
  readonly recipientType: "DESTINATION_CHAIN";
  readonly deadline: string;
}

export interface OneClickQuote {
  /** Present only on a quote that is not dry. */
  readonly depositAddress: string | undefined;
  readonly depositMemo: string | undefined;
  readonly amountIn: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly timeEstimate: number;
  /** When the deposit address stops being honoured. Absent on a dry quote. */
  readonly deadline: string | undefined;
  /** Already deducted from amountOut, in the destination asset's base units. */
  readonly withdrawFee: string | undefined;
}

export interface QuoteReply {
  readonly quote: OneClickQuote;
  /** Fees 1Click recorded against this quote, in basis points of the input. */
  readonly appFeesBps: number;
  readonly refundTo: string;
  /** What 1Click recorded it is delivering, and to whom, read back to compare. */
  readonly recipient: string | undefined;
  readonly originAsset: string | undefined;
  readonly destinationAsset: string | undefined;
  readonly signature: string;
  readonly correlationId: string;
}

export type SwapStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

const SWAP_STATUSES: readonly SwapStatus[] = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
];

export interface ChainTx {
  readonly hash: string;
  readonly explorerUrl: string;
}

export interface StatusReply {
  readonly status: SwapStatus;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly refundTo: string;
  readonly quote: OneClickQuote;
  readonly swap: {
    readonly amountOut: string | undefined;
    readonly refundedAmount: string | undefined;
    readonly depositedAmount: string | undefined;
    readonly originTxs: readonly ChainTx[];
    readonly destinationTxs: readonly ChainTx[];
  };
}

/**
 * 1Click said no to a request, with its own reason.
 *
 * Kept apart from a failure to reach it, because "this pair is not quoted" and
 * "the service did not answer" call for different things from a user.
 */
export class OneClickRefused extends MavnaError {
  readonly status: number;
  /** 1Click's own message, for classifying. Never shown to a user as it is. */
  readonly upstream: string;

  constructor(status: number, upstream: string) {
    super(`1Click refused the request (${status}): ${upstream}`, {
      retryable: status >= 500 || status === 429,
    });
    this.name = "OneClickRefused";
    this.status = status;
    this.upstream = upstream;
  }
}

export class OneClickApi {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;
  private tokensCache: Promise<readonly OneClickToken[]> | undefined;

  constructor(options: OneClickOptions = {}) {
    this.baseUrl = options.baseUrl ?? ONE_CLICK_URL;
    this.apiKey = options.apiKey;
    const injected = options.fetch;
    // called as a plain function, never as a method of this object: a browser's
    // fetch throws "Illegal invocation" when `this` is anything but the window
    this.fetcher = (input, init) => (injected ?? globalThis.fetch)(input, init);
  }

  /**
   * Every token 1Click routes, asked once per adapter.
   *
   * A failed read is not remembered, so the next quote asks again rather than
   * inheriting an outage.
   */
  tokens(): Promise<readonly OneClickToken[]> {
    if (this.tokensCache === undefined) {
      const loading = this.request("GET", "/v0/tokens").then((body) => parseTokens(body));
      this.tokensCache = loading;
      loading.catch(() => {
        if (this.tokensCache === loading) this.tokensCache = undefined;
      });
    }
    return this.tokensCache;
  }

  async quote(body: QuoteBody): Promise<QuoteReply> {
    return parseQuoteReply(await this.request("POST", "/v0/quote", body), body.dry);
  }

  /** Undefined when 1Click has never issued this deposit address. */
  async status(depositAddress: string, memo?: string): Promise<StatusReply | undefined> {
    const query = new URLSearchParams({ depositAddress });
    if (memo !== undefined) query.set("depositMemo", memo);
    try {
      return parseStatus(await this.request("GET", `/v0/status?${query.toString()}`));
    } catch (cause) {
      if (cause instanceof OneClickRefused && cause.status === 404) return undefined;
      throw cause;
    }
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey !== undefined) headers["x-api-key"] = this.apiKey;

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw unreachable(cause);
    }

    if (response.status === 401) {
      // A key that is wrong is configuration, and asking again will not fix it.
      throw new MavnaError(
        "1Click rejected the configured API key. Check the key, or leave it unset.",
        { retryable: false },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      if (isAbort(cause)) throw unreachable(cause);
      if (!response.ok) throw new OneClickRefused(response.status, response.statusText);
      throw new MavnaError("1Click answered with something that is not JSON.", {
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      const message =
        typeof parsed === "object" && parsed !== null && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : response.statusText;
      throw new OneClickRefused(response.status, message);
    }
    return parsed;
  }
}

function unreachable(cause: unknown): MavnaError {
  const detail = isAbort(cause)
    ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return new MavnaError(`1Click could not be reached: ${detail}`, { retryable: true, cause });
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

// What follows reads replies field by field. Each check names the field, so a
// change on 1Click's side surfaces as the field that changed.

function unusable(field: string): MavnaError {
  return new MavnaError(`1Click returned something unusable: ${field}.`, { retryable: true });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unusable(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw unusable(field);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field);
}

function units(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw unusable(`${field} is not base units`);
  return value;
}

function optionalUnits(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return units(value, field);
}

export function parseTokens(body: unknown): readonly OneClickToken[] {
  if (!Array.isArray(body)) throw unusable("tokens is not a list");
  return body.map((item, index) => {
    const row = record(item, `tokens[${index}]`);
    const decimals = row.decimals;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
      throw unusable(`tokens[${index}].decimals`);
    }
    return {
      assetId: text(row.assetId, `tokens[${index}].assetId`),
      decimals,
      blockchain: text(row.blockchain, `tokens[${index}].blockchain`),
      symbol: text(row.symbol, `tokens[${index}].symbol`),
      contractAddress: optionalText(row.contractAddress, `tokens[${index}].contractAddress`),
    };
  });
}

function parseQuote(value: unknown, field: string): OneClickQuote {
  const quote = record(value, field);
  const timeEstimate = quote.timeEstimate;
  if (typeof timeEstimate !== "number" || !Number.isFinite(timeEstimate) || timeEstimate < 0) {
    throw unusable(`${field}.timeEstimate`);
  }
  return {
    depositAddress: optionalText(quote.depositAddress, `${field}.depositAddress`),
    depositMemo: optionalText(quote.depositMemo, `${field}.depositMemo`),
    amountIn: units(quote.amountIn, `${field}.amountIn`),
    minAmountIn: units(quote.minAmountIn, `${field}.minAmountIn`),
    amountOut: units(quote.amountOut, `${field}.amountOut`),
    minAmountOut: units(quote.minAmountOut, `${field}.minAmountOut`),
    timeEstimate,
    deadline: optionalText(quote.deadline, `${field}.deadline`),
    withdrawFee: optionalUnits(quote.withdrawFee, `${field}.withdrawFee`),
  };
}

export function parseQuoteReply(body: unknown, dry: boolean): QuoteReply {
  const reply = record(body, "reply");
  const quote = parseQuote(reply.quote, "quote");
  const request = record(reply.quoteRequest, "quoteRequest");

  // A real quote exists to hand out a deposit address. One without it cannot be
  // paid, and one that comes back with a memo is a deposit this package would
  // build wrongly, since an ERC-20 transfer has nowhere to carry one.
  if (!dry) {
    if (quote.depositAddress === undefined) throw unusable("quote.depositAddress is missing");
    if (!/^0x[0-9a-fA-F]{40}$/.test(quote.depositAddress)) {
      throw unusable("quote.depositAddress is not an EVM address");
    }
    if (quote.depositMemo !== undefined) {
      throw new MavnaError(
        "1Click asked for a memo with this deposit, which an ERC-20 transfer cannot carry. " +
          "Refusing to build a deposit it might not credit.",
        { retryable: false },
      );
    }
  }

  let appFeesBps = 0;
  if (request.appFees !== undefined) {
    if (!Array.isArray(request.appFees)) throw unusable("quoteRequest.appFees");
    for (const [index, item] of request.appFees.entries()) {
      const fee = record(item, `quoteRequest.appFees[${index}]`).fee;
      if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 10_000) {
        throw unusable(`quoteRequest.appFees[${index}].fee`);
      }
      appFeesBps += fee;
    }
  }

  return {
    quote,
    appFeesBps,
    refundTo: text(request.refundTo, "quoteRequest.refundTo"),
    recipient: optionalText(request.recipient, "quoteRequest.recipient"),
    originAsset: optionalText(request.originAsset, "quoteRequest.originAsset"),
    destinationAsset: optionalText(request.destinationAsset, "quoteRequest.destinationAsset"),
    signature: typeof reply.signature === "string" ? reply.signature : "",
    correlationId: typeof reply.correlationId === "string" ? reply.correlationId : "",
  };
}

function parseTxs(value: unknown, field: string): readonly ChainTx[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw unusable(field);
  return value.map((item, index) => {
    const row = record(item, `${field}[${index}]`);
    return {
      hash: text(row.hash, `${field}[${index}].hash`),
      explorerUrl: typeof row.explorerUrl === "string" ? row.explorerUrl : "",
    };
  });
}

export function parseStatus(body: unknown): StatusReply {
  const reply = record(body, "status reply");
  const status = reply.status;
  if (typeof status !== "string" || !(SWAP_STATUSES as readonly string[]).includes(status)) {
    throw unusable("status");
  }
  const quoteResponse = record(reply.quoteResponse, "quoteResponse");
  const request = record(quoteResponse.quoteRequest, "quoteResponse.quoteRequest");
  const details =
    reply.swapDetails === undefined || reply.swapDetails === null
      ? {}
      : record(reply.swapDetails, "swapDetails");
  return {
    status: status as SwapStatus,
    updatedAt: typeof reply.updatedAt === "string" ? reply.updatedAt : "",
    correlationId: typeof reply.correlationId === "string" ? reply.correlationId : "",
    originAsset: text(request.originAsset, "quoteRequest.originAsset"),
    destinationAsset: text(request.destinationAsset, "quoteRequest.destinationAsset"),
    refundTo: text(request.refundTo, "quoteRequest.refundTo"),
    quote: parseQuote(quoteResponse.quote, "quoteResponse.quote"),
    swap: {
      amountOut: optionalUnits(details.amountOut, "swapDetails.amountOut"),
      refundedAmount: optionalUnits(details.refundedAmount, "swapDetails.refundedAmount"),
      depositedAmount: optionalUnits(details.depositedAmount, "swapDetails.depositedAmount"),
      originTxs: parseTxs(details.originChainTxHashes, "swapDetails.originChainTxHashes"),
      destinationTxs: parseTxs(
        details.destinationChainTxHashes,
        "swapDetails.destinationChainTxHashes",
      ),
    },
  };
}
