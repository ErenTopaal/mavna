import type { NetworkId } from "@mavna/core";
import {
  type SoroswapBuildRequest,
  type SoroswapQuoteRequest,
  soroswapBuildRequest,
  soroswapBuilt,
  soroswapQuote,
  soroswapQuoteRequest,
} from "@mavna/swap";
import { z } from "zod";

/**
 * Soroswap, proxied, so its key never leaves this process.
 *
 * Soroswap's API needs a key, and a key in a browser bundle is a published key.
 * The browser's `SoroswapProvider` therefore calls these endpoints instead, and
 * this adds the key on the way out. Because every call spends our key's quota,
 * it is stricter than the sponsor's other endpoints: an origin outside the
 * allowed list is refused outright rather than merely denied CORS, and calls
 * are limited per client and in total.
 *
 * What goes back to the browser is either a Soroswap answer that passed the same
 * schema the browser checks, or one of our own messages. Upstream error text is
 * never relayed, and an answer that somehow contains the key is not sent at all.
 */

export interface SoroswapProxyOptions {
  /** Server-side only. Read from SOROSWAP_API_KEY. */
  readonly apiKey: string;
  /** The network this sponsor serves; a request for the other one is refused. */
  readonly network: NetworkId;
  readonly baseUrl?: string;
  /** Per upstream call. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Calls one client may make per minute. Defaults to 30. */
  readonly perClientPerMinute?: number;
  /** Calls all clients together may make per minute. Defaults to 300. */
  readonly totalPerMinute?: number;
  /** How long a health answer is reused. Defaults to 30 seconds. */
  readonly healthCacheMs?: number;
  readonly now?: () => number;
}

export interface ProxyRequest {
  readonly method: string;
  readonly path: string;
  /** Whether the request's Origin is on the sponsor's allowed list. */
  readonly originAllowed: boolean;
  /** Who is asking, for the per-client limit. See `clientAddress`. */
  readonly client: string;
  readonly body: unknown;
}

export interface ProxyAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface SoroswapProxy {
  /** Whether a path belongs to the proxy at all. */
  owns(path: string): boolean;
  handle(request: ProxyRequest): Promise<ProxyAnswer>;
}

const WINDOW_MS = 60_000;

const upstreamHealth = z.object({
  status: z.object({ indexer: z.record(z.string(), z.array(z.string())) }),
  aggregator: z
    .object({
      mainnet: z
        .object({
          enabled: z.boolean().optional(),
          paused: z.boolean().nullable().optional(),
          degraded: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export function createSoroswapProxy(options: SoroswapProxyOptions): SoroswapProxy {
  if (options.apiKey.length === 0) {
    throw new Error("The Soroswap proxy needs SOROSWAP_API_KEY.");
  }
  const baseUrl = (options.baseUrl ?? "https://api.soroswap.finance").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const perClient = options.perClientPerMinute ?? 30;
  const total = options.totalPerMinute ?? 300;
  const healthCacheMs = options.healthCacheMs ?? 30_000;
  const now = options.now ?? Date.now;

  const clients = new Map<string, { start: number; count: number }>();
  let totalWindow = { start: 0, count: 0 };
  let health: { at: number; answer: ProxyAnswer } | undefined;

  const refuse = (status: number, error: string, retryable: boolean): ProxyAnswer => ({
    status,
    body: { error, retryable },
  });

  /** Fixed one-minute windows. Pruned on every call, so the map holds one window's clients. */
  function admit(client: string): boolean {
    const at = now();
    for (const [key, window] of clients) {
      if (at - window.start >= WINDOW_MS) clients.delete(key);
    }
    if (at - totalWindow.start >= WINDOW_MS) totalWindow = { start: at, count: 0 };
    const mine = clients.get(client) ?? { start: at, count: 0 };
    if (mine.count >= perClient || totalWindow.count >= total) return false;
    mine.count += 1;
    totalWindow.count += 1;
    clients.set(client, mine);
    return true;
  }

  async function upstream(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; json: unknown } | "unreachable"> {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
      return { status: response.status, json };
    } catch {
      return "unreachable";
    }
  }

  const authorised = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify(body),
  });

  /** One mapping from Soroswap's status to ours, for quote and build alike. */
  function failure(status: number | "unreachable", what: string): ProxyAnswer {
    if (status === "unreachable") return refuse(502, "Soroswap did not answer.", true);
    if (status === 400) return refuse(422, `Soroswap could not ${what} for these assets.`, false);
    if (status === 409) {
      return refuse(409, "Soroswap's fee rate changed since this quote. Quote again.", true);
    }
    if (status === 429) return refuse(429, "Soroswap is busy. Try again shortly.", true);
    if (status === 401 || status === 403) {
      // The operator's problem, not the caller's, and not something to retry.
      console.error(`[sponsor] Soroswap refused this server's key (HTTP ${status}).`);
      return refuse(502, "The swap service is misconfigured here.", false);
    }
    return refuse(502, `Soroswap could not ${what} (HTTP ${status}).`, status >= 500);
  }

  /** The last line of defence for the key: nothing carrying it is ever sent. */
  function guarded(answer: ProxyAnswer): ProxyAnswer {
    if (JSON.stringify(answer.body).includes(options.apiKey)) {
      console.error("[sponsor] A Soroswap answer contained the API key; it was not relayed.");
      return refuse(502, "Soroswap answered with something that cannot be relayed.", false);
    }
    return answer;
  }

  async function healthNow(): Promise<ProxyAnswer> {
    if (health !== undefined && now() - health.at < healthCacheMs) return health.answer;
    const result = await upstream("/health", { method: "GET" });
    if (result === "unreachable" || result.status !== 200) {
      return { status: 200, body: { network: options.network, usable: false, protocols: [] } };
    }
    const parsed = upstreamHealth.safeParse(result.json);
    if (!parsed.success) {
      return { status: 200, body: { network: options.network, usable: false, protocols: [] } };
    }
    const protocols = parsed.data.status.indexer[options.network] ?? [];
    const aggregator = options.network === "mainnet" ? parsed.data.aggregator?.mainnet : undefined;
    const aggregatorUp =
      aggregator === undefined ||
      (aggregator.enabled !== false && aggregator.paused !== true && aggregator.degraded !== true);
    const answer: ProxyAnswer = {
      status: 200,
      body: { network: options.network, usable: protocols.length > 0 && aggregatorUp, protocols },
    };
    health = { at: now(), answer };
    return answer;
  }

  async function quote(body: SoroswapQuoteRequest): Promise<ProxyAnswer> {
    const result = await upstream(
      `/quote?network=${options.network}`,
      authorised({
        assetIn: body.assetIn,
        assetOut: body.assetOut,
        amount: body.amount,
        tradeType: "EXACT_IN",
        protocols: body.protocols,
        slippageBps: body.slippageBps,
        // Recorded by Soroswap, not applied: the rate in force is the partner
        // profile's. Sent so the profile can be seeded from what was asked for.
        ...(body.feeBps === undefined ? {} : { feeBps: body.feeBps }),
      }),
    );
    if (result === "unreachable" || result.status < 200 || result.status >= 300) {
      return failure(result === "unreachable" ? result : result.status, "price a swap");
    }
    const parsed = soroswapQuote.safeParse(result.json);
    if (!parsed.success) {
      return refuse(502, "Soroswap answered with a quote that cannot be used.", false);
    }
    return { status: 200, body: { ...parsed.data } };
  }

  async function build(body: SoroswapBuildRequest): Promise<ProxyAnswer> {
    const result = await upstream(
      `/quote/build?network=${options.network}`,
      authorised({ quote: body.quote, from: body.from, to: body.to }),
    );
    if (result === "unreachable" || result.status < 200 || result.status >= 300) {
      return failure(result === "unreachable" ? result : result.status, "build this swap");
    }
    const parsed = soroswapBuilt.safeParse(result.json);
    if (!parsed.success) {
      return refuse(502, "Soroswap answered with a transaction that cannot be used.", false);
    }
    return { status: 200, body: { xdr: parsed.data.xdr } };
  }

  return {
    owns: (path) => path.startsWith("/swap/soroswap/"),

    async handle(request) {
      if (!request.originAllowed) {
        return refuse(403, "This origin may not use the swap service here.", false);
      }
      const route = `${request.method} ${request.path}`;
      if (
        route !== "GET /swap/soroswap/health" &&
        route !== "POST /swap/soroswap/quote" &&
        route !== "POST /swap/soroswap/build"
      ) {
        return refuse(404, "No such endpoint.", false);
      }
      if (!admit(request.client)) {
        return refuse(429, "Too many swap requests. Try again in a minute.", true);
      }

      if (route === "GET /swap/soroswap/health") return guarded(await healthNow());

      if (route === "POST /swap/soroswap/quote") {
        const parsed = soroswapQuoteRequest.safeParse(request.body);
        if (!parsed.success) return refuse(400, describe(parsed.error), false);
        if (parsed.data.network !== options.network) {
          return refuse(400, `This sponsor serves ${options.network}.`, false);
        }
        return guarded(await quote(parsed.data));
      }

      const parsed = soroswapBuildRequest.safeParse(request.body);
      if (!parsed.success) return refuse(400, describe(parsed.error), false);
      if (parsed.data.network !== options.network) {
        return refuse(400, `This sponsor serves ${options.network}.`, false);
      }
      return guarded(await build(parsed.data));
    },
  };
}

function describe(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first?.path.join(".") || "request";
  return `The swap request is not usable: ${where} ${first?.message ?? "failed validation"}.`;
}
