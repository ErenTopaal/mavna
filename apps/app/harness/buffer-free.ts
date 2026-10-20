/*
 * Built only for the browser tests (MAVNA_BROWSER_HARNESS=1), through the app's
 * own vite config, so these calls run the packages exactly as the app bundles
 * them: no Node globals, no polyfills. Every rail path that once reached for
 * Node's Buffer is driven here, and the spec answers their network calls.
 */

import { AxelarAdapter } from "@mavna/adapter-axelar";
import { LayerZeroAdapter } from "@mavna/adapter-layerzero";
import type { QuoteRequest, Route, RouteRejection } from "@mavna/core";
import {
  createNetworkConfig,
  PUBLIC_MAINNET_RPC_URLS,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
} from "@mavna/stellar";
import { AquariusProvider } from "@mavna/swap";

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

function route(result: Route | RouteRejection): Route {
  if (!isRoute(result)) throw new Error(`declined: ${result.reason}: ${result.explanation}`);
  return result;
}

function rpcFor(network: "testnet" | "mainnet") {
  const rpcUrl = network === "mainnet" ? PUBLIC_MAINNET_RPC_URLS[0] : PUBLIC_TESTNET_RPC_URL;
  if (rpcUrl === undefined) throw new Error(`no public rpc is known for ${network}`);
  const config = createNetworkConfig({ id: network, rpcUrl });
  return { config, rpc: new RpcClient({ url: config.rpcUrl }) };
}

// valid, well formed, and has never existed on either network
const UNFUNDED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

async function layerzeroQuote(): Promise<string> {
  // mainnet, because no OFT is peered to Stellar testnet; quoting only reads
  const { config, rpc } = rpcFor("mainnet");
  const adapter = new LayerZeroAdapter({
    network: "mainnet",
    rpc,
    baseReserveStroops: config.baseReserveStroops,
  });
  const { from, to } = await adapter.sendableAssets("arbitrum");
  const request: QuoteRequest = {
    from,
    to,
    sends: { asset: from, baseUnits: (25n * 10n ** BigInt(from.decimals)).toString() },
    destination: UNFUNDED,
    maxSlippageBps: 50,
  };
  return route(await adapter.quote(request)).receives.baseUnits;
}

async function axelarBuild(): Promise<number> {
  const { config, rpc } = rpcFor("testnet");
  const adapter = new AxelarAdapter({
    network: "testnet",
    rpc,
    baseReserveStroops: config.baseReserveStroops,
  });
  const ixe = {
    chainId: "base-sepolia",
    id: "0xA813265d59c9bC06e439E61fA133B5f23134b2Ce",
    symbol: "IXE",
    decimals: 7,
    curatedBy: "Axelar",
  };
  const quoted = route(
    await adapter.quote({
      from: ixe,
      to: {
        chainId: "stellar-testnet",
        id: "CCYDJCO2DQV3YWQJHKZCOKWXWH46KRBJAJLLI7SGRMBYSY65Q2MIASCI",
        symbol: "IXE",
        decimals: 7,
        curatedBy: "Axelar",
      },
      sends: { asset: ixe, baseUnits: "10000000" },
      destination: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
      maxSlippageBps: 50,
    }),
  );
  return (await adapter.buildTransactions(quoted)).length;
}

// testnet XLM and USDC, as their Stellar asset contracts
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

async function aquariusComposeQuote(): Promise<{ service: number; listed: number }> {
  const aquarius = new AquariusProvider("testnet");
  const ask = { assetIn: XLM, assetOut: USDC, amountIn: "100000000", maxSlippageBps: 100 };
  // the service's chosen path, and the one built from the router's own pools,
  // which is how a compose route asks
  const service = await aquarius.quotePath(ask);
  const listed = await aquarius.quotePath({ ...ask, via: [] });
  return { service: service.path.length, listed: listed.path.length };
}

declare global {
  interface Window {
    mavnaHarness: {
      layerzeroQuote: typeof layerzeroQuote;
      axelarBuild: typeof axelarBuild;
      aquariusComposeQuote: typeof aquariusComposeQuote;
    };
  }
}

window.mavnaHarness = { layerzeroQuote, axelarBuild, aquariusComposeQuote };
