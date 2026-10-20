import { MavnaError, type NetworkId } from "@mavna/core";
import { requestJson } from "./http.js";

/**
 * Axelar's published list of interchain tokens.
 *
 * Useful and NOT authoritative, which is the whole reason this file says so out
 * loud. It is the only way to learn the token id of a plain ERC-20 that was
 * brought into the service as a canonical token, because such a token has no idea
 * it is one and cannot be asked. Mainnet USDC is exactly that case.
 *
 * But it is an index, and it lags. On testnet it lists four tokens and none of
 * them reach Stellar, while the token service on hyperliquid has a token
 * registered for Stellar right now and will answer for it if asked. So this is
 * consulted for what the chain cannot answer, and the chain settles everything.
 */

const ASSETS_API: Readonly<Record<NetworkId, string>> = {
  testnet: "https://testnet.api.axelarscan.io/api/getITSAssets",
  mainnet: "https://api.axelarscan.io/api/getITSAssets",
};

export interface ItsAsset {
  readonly tokenId: string;
  readonly symbol: string;
  /** Where this token lives on each chain, keyed by Axelar's chain identifier. */
  readonly chains: ReadonlyMap<string, { address: string; decimals: number | undefined }>;
}

interface RawAsset {
  readonly id?: string;
  readonly symbol?: string;
  readonly decimals?: number;
  readonly chains?: Record<string, { tokenAddress?: string; decimals?: number }>;
}

const cache = new Map<NetworkId, Promise<readonly ItsAsset[]>>();

export function loadItsAssets(network: NetworkId): Promise<readonly ItsAsset[]> {
  const existing = cache.get(network);
  if (existing !== undefined) return existing;

  const loading = fetchAssets(network).catch((cause: unknown) => {
    cache.delete(network);
    throw cause;
  });
  cache.set(network, loading);
  return loading;
}

export function forgetItsAssets(): void {
  cache.clear();
}

async function fetchAssets(network: NetworkId): Promise<readonly ItsAsset[]> {
  const reply = await requestJson("Axelar's interchain token list", ASSETS_API[network]);
  if (!reply.ok) {
    throw new MavnaError(`Axelar's interchain token list answered HTTP ${reply.status}.`, {
      retryable: reply.status >= 500 || reply.status === 429,
    });
  }

  const rows = reply.body as RawAsset[];
  if (!Array.isArray(rows)) {
    throw new MavnaError("Axelar's interchain token list came back in an unexpected shape.", {
      retryable: false,
    });
  }

  const assets: ItsAsset[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.chains === undefined) continue;
    const chains = new Map<string, { address: string; decimals: number | undefined }>();
    for (const [chain, entry] of Object.entries(row.chains)) {
      if (typeof entry?.tokenAddress !== "string") continue;
      // Per-chain decimals override the token's own, because the same token is
      // deployed with different precision on different chains. Hedera's AXE has
      // six where its home chain has eighteen.
      chains.set(chain, { address: entry.tokenAddress, decimals: entry.decimals ?? row.decimals });
    }
    assets.push({ tokenId: withPrefix(row.id), symbol: row.symbol ?? "", chains });
  }
  return assets;
}

/** The token id Axelar publishes for a token at this address on this chain. */
export async function tokenIdFromIndex(
  network: NetworkId,
  chainId: string,
  address: string,
): Promise<string | undefined> {
  const assets = await loadItsAssets(network);
  const wanted = address.toLowerCase();
  for (const asset of assets) {
    const entry = asset.chains.get(chainId);
    if (entry !== undefined && entry.address.toLowerCase() === wanted) return asset.tokenId;
  }
  return undefined;
}

function withPrefix(id: string): string {
  return id.startsWith("0x") ? id.toLowerCase() : `0x${id.toLowerCase()}`;
}
