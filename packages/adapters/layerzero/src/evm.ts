import { MavnaError } from "@mavna/core";

/**
 * Reading an EVM chain, having first checked it is the chain we meant.
 *
 * LayerZero has no off-chain quoting service. `quoteSend` is a view call on the
 * OFT contract, so this rail cannot price anything without a node, and the node
 * is therefore part of the adapter rather than an optional extra.
 *
 * The chain-id check is not defensive habit. LayerZero's own registry lists
 * `https://op-sepolia-pokt.nodies.app` among Ethereum Sepolia's endpoints, and
 * every LayerZero contract sits at the same address on both chains, so reading
 * through it returns a confident wrong answer instead of an error: OP Sepolia
 * says the Stellar pathway is unsupported, Ethereum Sepolia says it is. One
 * `eth_chainId` call, cached for the life of the reader, removes the whole class.
 */

export interface EvmReaderOptions {
  /** How long a single request may take before it is abandoned. */
  readonly timeoutMs?: number;
  /** Injectable so a caller can supply their own transport or their own node. */
  readonly fetch?: typeof globalThis.fetch;
}

interface Endpoint {
  readonly url: string;
  /** What the node said its chain is. Undefined until it has been asked. */
  chainId: number | undefined;
  /** True once the node has been ruled out, either as wrong or as unreachable. */
  rejected: boolean;
}

export class EvmReader {
  private readonly endpoints: Endpoint[];
  private readonly expectedChainId: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(urls: readonly string[], expectedChainId: number, options: EvmReaderOptions = {}) {
    if (urls.length === 0) {
      throw new MavnaError("An EVM reader needs at least one endpoint to ask.", {
        retryable: false,
      });
    }
    this.endpoints = urls.map((url) => ({ url, chainId: undefined, rejected: false }));
    this.expectedChainId = expectedChainId;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * An `eth_call`, against a node proven to be on the right chain.
   *
   * Returns undefined when the call reverted. A revert is an answer here rather
   * than an exception: an OFT that refuses to quote a pathway is telling us the
   * pathway is not usable, which is exactly what the caller wants to know, and
   * turning that into a throw would mean one unconfigured token takes down a
   * whole quote.
   */
  async call(to: string, data: string): Promise<string | undefined> {
    const result = await this.request("eth_call", [{ to, data }, "latest"], true);
    if (result === undefined) return undefined;
    if (typeof result !== "string" || result === "0x") return undefined;
    return result;
  }

  /** Whether there is contract code at an address. Cheap, and rules out a typo. */
  async hasCode(address: string): Promise<boolean> {
    const code = await this.request("eth_getCode", [address, "latest"], false);
    return typeof code === "string" && code.length > 2;
  }

  private async request(
    method: string,
    params: unknown[],
    revertIsAnswer: boolean,
  ): Promise<unknown> {
    let lastError: unknown;

    for (const endpoint of this.endpoints) {
      if (endpoint.rejected) continue;

      if (endpoint.chainId === undefined) {
        try {
          const raw = await this.send(endpoint.url, "eth_chainId", []);
          endpoint.chainId = Number(raw);
        } catch (cause) {
          endpoint.rejected = true;
          lastError = cause;
          continue;
        }
        if (endpoint.chainId !== this.expectedChainId) {
          // Not a transient failure and not worth retrying: this URL is serving
          // a different chain and always will be.
          endpoint.rejected = true;
          lastError = new MavnaError(
            `${endpoint.url} serves chain ${endpoint.chainId}, not ${this.expectedChainId}.`,
            { retryable: false },
          );
          continue;
        }
      }

      try {
        return await this.send(endpoint.url, method, params);
      } catch (cause) {
        if (revertIsAnswer && cause instanceof ContractRevert) return undefined;
        lastError = cause;
      }
    }

    throw new MavnaError(
      `No usable node answered for chain ${this.expectedChainId}. ` +
        `Last problem: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { retryable: true, cause: lastError },
    );
  }

  private async send(url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new MavnaError(`${url} answered HTTP ${response.status}.`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error !== undefined) {
      const message = String(body.error.message ?? "the node refused the call");
      // A revert carries information; a rate limit carries none. Separating them
      // is what lets a caller treat "this token does not route there" as data
      // while still retrying "you are asking too fast" somewhere else.
      if (/revert|execution reverted/i.test(message)) throw new ContractRevert(message);
      throw new MavnaError(`${url}: ${message}`, {
        retryable: /limit|quota|rate|too many|timeout/i.test(message),
      });
    }
    return body.result;
  }
}

/** A contract said no. Distinct from the node failing to answer at all. */
export class ContractRevert extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRevert";
  }
}
