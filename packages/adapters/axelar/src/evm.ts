import { MavnaError } from "@mavna/core";
import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeString,
  decodeUint,
  encodeAddress,
  encodeBytes32,
  encodeCall,
  encodeStringCall,
  SELECTORS,
} from "./abi.js";
import { requestJson } from "./http.js";

/**
 * Asking an EVM chain a question, over its published node.
 *
 * Every read here exists because the answer decides whether a user's funds move
 * or vanish, and because no off-chain index is authoritative for it. Axelar's own
 * asset API does not list the one token that reaches Stellar on testnet, while
 * the token service on that chain answers for it immediately. The chain is the
 * source of truth; the indexes are conveniences.
 */

/** How a call reaches a node. Injectable so tests can hold one still. */
export type EthCall = (rpcUrl: string, to: string, data: string) => Promise<string>;

interface JsonRpcResponse {
  readonly result?: string;
  readonly error?: { readonly message?: string; readonly code?: number };
}

/**
 * A read that reverted, as opposed to one that failed to happen.
 *
 * The two need telling apart. `deployedTokenManager` reverting means the token is
 * not linked on this chain, which is an answer and a reason to decline. A node
 * that timed out means nothing at all, and treating it as "not linked" would tell
 * a user their token is unsupported because someone's server was busy.
 */
export class EvmRevert extends MavnaError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "EvmRevert";
  }
}

export const fetchEthCall: EthCall = async (rpcUrl, to, data) => {
  const reply = await requestJson("An EVM node", rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });

  if (!reply.ok) {
    throw new MavnaError(`An EVM node answered HTTP ${reply.status}.`, {
      retryable: reply.status >= 500 || reply.status === 429,
    });
  }

  const body = reply.body as JsonRpcResponse;

  // A revert arrives as a JSON-RPC error with a 200, so branching on the status
  // code alone would read every revert as a success with no result.
  if (body.error !== undefined) {
    const message = body.error.message ?? "";
    if (isRevert(body.error.code, message)) {
      throw new EvmRevert(message || "an EVM read reverted with no reason given");
    }
    // Public nodes report rate limits, lag and internal faults this same way,
    // and reading one as a revert would decline a token that is fine.
    throw new MavnaError(`An EVM node could not answer: ${message || "no reason given"}`, {
      retryable: true,
    });
  }
  if (typeof body.result !== "string") {
    throw new MavnaError("An EVM node answered without a result.", { retryable: true });
  }
  return body.result;
};

/**
 * Code 3 is the standard revert code. Older nodes send a revert as -32000 and
 * Nethermind as -32015, so the message decides there; anything that does not say
 * it reverted is not taken as the contract's answer.
 */
function isRevert(code: number | undefined, message: string): boolean {
  if (code === 3) return true;
  return /revert|invalid opcode/i.test(message);
}

export class EvmReader {
  // Declared and assigned rather than written as constructor parameters. The repo
  // runs `erasableSyntaxOnly`, which forbids any syntax that emits runtime code,
  // and a parameter property is exactly that.
  private readonly rpcUrl: string;
  private readonly call: EthCall;

  constructor(rpcUrl: string, call: EthCall = fetchEthCall) {
    this.rpcUrl = rpcUrl;
    this.call = call;
  }

  /** The ERC-20 the token service has registered under this token id, on this chain. */
  async registeredTokenAddress(service: string, tokenId: string): Promise<string> {
    const data = encodeCall(SELECTORS.registeredTokenAddress, [encodeBytes32(tokenId)]);
    return decodeAddress(await this.call(this.rpcUrl, service, data));
  }

  /**
   * The token manager, which reverts when there is not one.
   *
   * Deliberately not `tokenManagerAddress`, which Axelar's own comment says
   * "does not need to exist already": it derives an address arithmetically and
   * answers for a token that was never linked here. That confident wrong answer
   * is exactly what this call avoids.
   */
  async deployedTokenManager(service: string, tokenId: string): Promise<string> {
    const data = encodeCall(SELECTORS.deployedTokenManager, [encodeBytes32(tokenId)]);
    return decodeAddress(await this.call(this.rpcUrl, service, data));
  }

  /** How the token manager moves the token, and which token it moves. */
  async tokenManagerKind(tokenManager: string): Promise<{ type: number; token: string }> {
    const data = encodeCall(SELECTORS.getImplementationTypeAndTokenAddress);
    const result = await this.call(this.rpcUrl, tokenManager, data);
    return { type: Number(decodeUint(result, 0)), token: decodeAddress(result, 1) };
  }

  /** A token deployed by the service knows its own id. Plain ERC-20s do not. */
  async interchainTokenId(token: string): Promise<string> {
    const data = encodeCall(SELECTORS.interchainTokenId);
    return decodeBytes32(await this.call(this.rpcUrl, token, data));
  }

  /** The gas service the token service itself pays into. */
  async gasService(service: string): Promise<string> {
    return decodeAddress(await this.call(this.rpcUrl, service, encodeCall(SELECTORS.gasService)));
  }

  async decimals(token: string): Promise<number> {
    const data = encodeCall(SELECTORS.decimals);
    return Number(decodeUint(await this.call(this.rpcUrl, token, data)));
  }

  async symbol(token: string): Promise<string> {
    const data = encodeCall(SELECTORS.symbol);
    return decodeString(await this.call(this.rpcUrl, token, data));
  }

  async allowance(token: string, owner: string, spender: string): Promise<bigint> {
    const data = encodeCall(SELECTORS.allowance, [encodeAddress(owner), encodeAddress(spender)]);
    return decodeUint(await this.call(this.rpcUrl, token, data));
  }

  /**
   * Whether this chain's token service will route to the named chain.
   *
   * Two versions are live and they answer through DIFFERENT functions, which is
   * the trap this method exists to close. Token service 2.2.0 has
   * `isTrustedChain`. Token service 2.1.x does not, and answers `trustedAddress`
   * instead, returning "hub" for a chain reached through the hub and an empty
   * string for one it does not know.
   *
   * Asking 2.2.0 for a `trustedAddress` returns an empty string for chains it
   * trusts perfectly well. That is not an error, it is a confident "no", and
   * acting on it would decline every route on those chains. Confirmed both ways
   * against the live contracts: on hyperliquid `isTrustedChain` answers and
   * `trustedAddress` returns empty, on ethereum `isTrustedChain` reverts and
   * `trustedAddress` returns "hub".
   *
   * So both are tried, and only a chain that answers neither is refused.
   */
  async trustsChain(service: string, chainId: string): Promise<boolean> {
    try {
      const data = encodeStringCall(SELECTORS.isTrustedChain, chainId);
      return decodeBool(await this.call(this.rpcUrl, service, data));
    } catch (cause) {
      if (!(cause instanceof EvmRevert)) throw cause;
    }

    const data = encodeStringCall(SELECTORS.trustedAddress, chainId);
    return decodeString(await this.call(this.rpcUrl, service, data)).length > 0;
  }
}
