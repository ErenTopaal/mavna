import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PUBLIC_MAINNET_RPC_URLS, RpcClient } from "@mavna/stellar";
import { SoroswapProvider, STELLAR_USDT0 } from "@mavna/swap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSoroswapProxy } from "./soroswap.js";

/**
 * Soroswap on mainnet, through the proxy, read-only.
 *
 * The browser's provider talks to the proxy exactly as it would in production;
 * the proxy holds the real key from SOROSWAP_API_KEY. Quotes and a build are
 * asked for, nothing is signed or sent. A build is Soroswap simulating the swap
 * for a real holder of the input asset.
 */

const key = process.env.SOROSWAP_API_KEY ?? "";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** A large public USDC holder, from stellar.expert on 2026-10-19. */
const USDC_HOLDER = "GC5LF63GRVIT5ZXXCXLPI3RX2YXKJQFZVBSAO6AUELN3YIMSWPD6Z6FH";

let server: Server | undefined;
let proxyUrl = "";
const relayed: string[] = [];

beforeAll(async () => {
  if (key === "") return;
  const proxy = createSoroswapProxy({ apiKey: key, network: "mainnet" });
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    req.on("end", () => {
      void proxy
        .handle({
          method: req.method ?? "",
          path: (req.url ?? "").split("?")[0] ?? "",
          originAllowed: true,
          client: "live-test",
          body: text === "" ? undefined : JSON.parse(text),
        })
        .then((answer) => {
          const body = JSON.stringify(answer.body);
          relayed.push(body);
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(body);
        });
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
});

describe.skipIf(key === "")("Soroswap through the proxy, live", () => {
  it("is usable on mainnet", async () => {
    expect(await new SoroswapProvider({ network: "mainnet", proxyUrl }).isUsable()).toBe(true);
  });

  it("prices USDC into XLM and USDT0 into USDC", async () => {
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl });
    for (const [assetIn, assetOut] of [
      [USDC, "native"],
      [STELLAR_USDT0, USDC],
    ] as const) {
      const quote = await provider.quote({
        assetIn,
        assetOut,
        amountIn: "100000000",
        maxSlippageBps: 50,
        destinationKind: "account",
      });
      expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
      expect(BigInt(quote.amountOutMinimum)).toBeLessThanOrEqual(BigInt(quote.amountOut));
      expect(quote.venues.length).toBeGreaterThan(0);
    }
  });

  it("builds an unsigned swap for a real holder", async () => {
    const provider = new SoroswapProvider({ network: "mainnet", proxyUrl });
    const quote = await provider.quote({
      assetIn: USDC,
      assetOut: "native",
      amountIn: "10000000",
      maxSlippageBps: 100,
      destinationKind: "account",
    });
    const account = await new RpcClient({ url: PUBLIC_MAINNET_RPC_URLS[0] ?? "" }).loadAccount(
      USDC_HOLDER,
    );
    const tx = await provider.build({ quote, account });
    expect(tx.source).toBe(USDC_HOLDER);
    expect(tx.signatures).toHaveLength(0);
  });

  it("never relayed the key", () => {
    expect(relayed.length).toBeGreaterThan(0);
    for (const body of relayed) expect(body.includes(key)).toBe(false);
  });
});
