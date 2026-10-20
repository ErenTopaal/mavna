import type { Asset, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { RpcClient, XlmPriceSource } from "@mavna/stellar";
import { xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NearIntentsAdapter, slippageOf } from "./adapter.js";
import { ORIGIN_CHAINS } from "./chains.js";
import type { JsonRpc } from "./evm.js";

/**
 * The rail end to end, with every remote answer held still at its boundary:
 * 1Click through the injected fetch, Horizon through the global one, origin
 * chains through the injected JSON-RPC, and the Stellar node through the real
 * RpcClient's server. Everything above those is the real code.
 *
 * The token rows are copied from 1Click's live `/v0/tokens` on 19 October 2026.
 */

const ONE_CLICK = "https://1click.test";
const HORIZON = "https://horizon.test";

const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_ID = `USDC:${CIRCLE}`;
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ARB_USDC_ASSET = `nep141:arb-${ARB_USDC}.omft.near`;
const STELLAR_USDC_ASSET =
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";
const STELLAR_XLM_ASSET =
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";

const TOKENS = [
  {
    assetId: ARB_USDC_ASSET,
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-19T15:04:30.660Z",
    contractAddress: ARB_USDC,
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-19T15:04:30.660Z",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    assetId: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
    decimals: 18,
    blockchain: "bsc",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-19T15:04:30.660Z",
    contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  },
  {
    assetId: STELLAR_XLM_ASSET,
    decimals: 7,
    blockchain: "stellar",
    symbol: "XLM",
    price: 0.176333,
    priceUpdatedAt: "2026-10-19T15:04:30.660Z",
    coingeckoId: "stellar",
  },
  {
    assetId: STELLAR_USDC_ASSET,
    decimals: 7,
    blockchain: "stellar",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-10-19T15:04:30.660Z",
    contractAddress: CIRCLE,
  },
];

const ACCOUNT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
const CONTRACT = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const MUXED = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ";
const SENDER = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const DEPOSIT = "0x76b4c56085ed136a8744d52be956396624a730e8";
const TX = `0x${"ab".repeat(32)}`;
const BASE_RESERVE = 5_000_000;

interface Ledger {
  account: boolean;
  trustline: boolean;
  /** The trustline's limit, when a test makes it tight. */
  trustlineLimit?: bigint;
}

interface OneClick {
  tokens: () => Response;
  quote: (body: Record<string, unknown>) => Response;
  status: (depositAddress: string) => Response;
}

let ledger: Ledger;
let oneClick: OneClick;
let quoteBodies: Record<string, unknown>[];
let asked: string[];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quoteReply(
  body: Record<string, unknown>,
  over: Record<string, unknown> = {},
  echoed: Record<string, unknown> = {},
): Response {
  const dry = body.dry === true;
  return json({
    quote: {
      ...(dry ? {} : { depositAddress: DEPOSIT, deadline: "2026-10-19T17:00:00.000Z" }),
      amountIn: body.amount,
      amountInFormatted: "10.0",
      amountInUsd: "10",
      minAmountIn: body.amount,
      amountOut: "99500000",
      amountOutFormatted: "9.95",
      amountOutUsd: "9.95",
      minAmountOut: "99000000",
      timeEstimate: 47,
      withdrawFee: "20000",
      ...over,
    },
    quoteRequest: { ...body, appFees: [{ recipient: "fees.near", fee: 25 }], ...echoed },
    signature: "ed25519:sig",
    timestamp: "2026-10-19T15:08:12.041Z",
    correlationId: "c0rr",
  });
}

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

const oneClickFetch: typeof fetch = async (input, init) => {
  const url = urlOf(input);
  if (url === `${ONE_CLICK}/v0/tokens`) return oneClick.tokens();
  if (url === `${ONE_CLICK}/v0/quote`) {
    if (typeof init?.body !== "string") throw new Error("the quote was sent without a JSON body");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    quoteBodies.push(body);
    return oneClick.quote(body);
  }
  if (url.startsWith(`${ONE_CLICK}/v0/status?`)) {
    const deposit = new URL(url).searchParams.get("depositAddress") ?? "";
    asked.push(`status ${deposit}`);
    return oneClick.status(deposit);
  }
  throw new Error(`the 1Click double has no answer for ${url}`);
};

function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://soroban.test",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => {
    const entries: unknown[] = [];
    for (const key of keys) {
      const kind = key.type;
      asked.push(`ledger ${kind}`);
      if (key.type === "account" && ledger.account) {
        entries.push({
          key,
          val: xdr.LedgerEntryData.account(
            new xdr.AccountEntry({
              accountId: key.account.accountId,
              balance: 50_000_000n,
              seqNum: 1n,
              numSubEntries: 0,
              inflationDest: null,
              flags: 0,
              homeDomain: "",
              thresholds: new Uint8Array([1, 0, 0, 0]),
              signers: [],
              ext: xdr.AccountEntryExt.v0(),
            }),
          ),
        });
      }
      if (key.type === "trustline" && ledger.trustline) {
        entries.push({
          key,
          val: xdr.LedgerEntryData.trustline(
            new xdr.TrustLineEntry({
              accountId: key.trustLine.accountId,
              asset: key.trustLine.asset,
              balance: 0n,
              limit: ledger.trustlineLimit ?? 10n ** 15n,
              flags: 1,
              ext: xdr.TrustLineEntryExt.v0(),
            }),
          ),
        });
      }
    }
    return { entries, latestLedger: 100 } as never;
  });
  return client;
}

/** Each origin chain's node: only Arbitrum's knows the transaction. */
let chainTxs: Record<string, unknown>;
let chainDown: Set<string>;
const jsonRpc: JsonRpc = async (url, method, params) => {
  if (chainDown.has(url)) throw new Error(`${url} refused the connection`);
  if (method === "eth_chainId") {
    const chain = ORIGIN_CHAINS.mainnet.find((c) => c.rpc.includes(url));
    return `0x${(chain?.evmChainId ?? 0).toString(16)}`;
  }
  if (method !== "eth_getTransactionByHash") throw new Error(`no answer for ${method}`);
  asked.push(`tx ${url}`);
  return chainTxs[`${url} ${String(params[0])}`] ?? null;
};

function adapter(network: "mainnet" | "testnet" = "mainnet"): NearIntentsAdapter {
  return new NearIntentsAdapter({
    network,
    rpc: stellarNode(),
    baseReserveStroops: BASE_RESERVE,
    prices: new XlmPriceSource({ horizonUrl: HORIZON }),
    baseUrl: ONE_CLICK,
    fetch: oneClickFetch,
    jsonRpc,
  });
}

const arbUsdc: Asset = {
  chainId: "arbitrum",
  id: ARB_USDC,
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};
const stellarUsdc: Asset = {
  chainId: "stellar",
  id: USDC_ID,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};
const stellarXlm: Asset = {
  chainId: "stellar",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};

const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: arbUsdc,
  to: stellarUsdc,
  sends: { asset: arbUsdc, baseUnits: "10000000" },
  destination: ACCOUNT,
  maxSlippageBps: 50,
  ...over,
});

function routeOf(result: Route | RouteRejection): Route {
  if ("reason" in result) throw new Error(`declined: ${result.reason}: ${result.explanation}`);
  return result;
}

function rejectionOf(result: Route | RouteRejection): RouteRejection {
  if (!("reason" in result)) throw new Error("expected a decline, got a route");
  return result;
}

/** A transfer(to, amount) call to `token`, as a node returns it. */
function transferTx(token: string, to: string, amount: bigint): Record<string, string> {
  return {
    to: token,
    input: `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
  };
}

function statusReply(status: string, details: Record<string, unknown> = {}): Response {
  return json({
    correlationId: "c0rr",
    status,
    updatedAt: "2026-10-19T15:10:00.000Z",
    quoteResponse: {
      quote: {
        depositAddress: DEPOSIT,
        amountIn: "10000000",
        amountInFormatted: "10",
        amountInUsd: "10",
        minAmountIn: "10000000",
        amountOut: "99500000",
        amountOutFormatted: "9.95",
        amountOutUsd: "9.95",
        minAmountOut: "99000000",
        timeEstimate: 47,
        deadline: "2026-10-19T16:00:00.000Z",
      },
      quoteRequest: {
        originAsset: ARB_USDC_ASSET,
        destinationAsset: STELLAR_USDC_ASSET,
        refundTo: SENDER,
      },
    },
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...details,
    },
  });
}

beforeEach(() => {
  ledger = { account: true, trustline: true };
  quoteBodies = [];
  asked = [];
  chainTxs = {};
  chainDown = new Set();
  oneClick = {
    tokens: () => json(TOKENS),
    quote: (body) => quoteReply(body),
    status: () => json({ message: "Deposit address not found" }, 404),
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.startsWith(`${HORIZON}/order_book`)) {
      asked.push("horizon order book");
      // 0.2 USDC per XLM both ways, so one USDC is five XLM.
      return json({
        bids: [{ price: "0.2", amount: "1000" }],
        asks: [{ price: "0.2", amount: "5000" }],
      });
    }
    throw new Error(`the fetch double has no answer for ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("quoting", () => {
  it("asks 1Click for a dry quote and reports what the solvers would deliver", async () => {
    const route = routeOf(await adapter().quote(ask()));

    expect(quoteBodies).toHaveLength(1);
    const body = quoteBodies[0] ?? {};
    expect(body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 50,
      originAsset: ARB_USDC_ASSET,
      destinationAsset: STELLAR_USDC_ASSET,
      amount: "10000000",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipient: ACCOUNT,
      recipientType: "DESTINATION_CHAIN",
    });
    // A dry quote's refund address is a fresh stand-in, never anybody's wallet.
    expect(body.refundTo).toMatch(/^0x[0-9a-f]{40}$/);
    expect(body.refundTo).not.toBe(SENDER.toLowerCase());

    expect(route.source).toBe("near-intents");
    expect(route.trustModel).toBe("solver-network");
    expect(route.fromChain.id).toBe("arbitrum");
    expect(route.toChain.id).toBe("stellar");
    expect(route.receives).toEqual({ asset: { ...stellarUsdc }, baseUnits: "99500000" });
    expect(route.receivesAtLeast.baseUnits).toBe("99000000");
    expect(route.deliveredAtLeast).toEqual(route.receivesAtLeast);
    expect(route.deliveredAtLeast.asset.id).toBe(USDC_ID);
    expect(route.estimatedSeconds).toBe(47);
    expect(route.steps.map((s) => s.kind)).toEqual(["bridge"]);
    expect(route.signaturesRequired).toBe(1);
    expect(route.fees).toEqual([
      {
        kind: "bridge",
        total: { asset: arbUsdc, baseUnits: "25000" },
        recipients: [
          {
            name: "NEAR Intents",
            amount: { asset: arbUsdc, baseUnits: "25000" },
            address: undefined,
          },
        ],
        includedInQuote: true,
      },
      {
        kind: "bridge",
        total: { asset: stellarUsdc, baseUnits: "20000" },
        recipients: [
          {
            name: "NEAR Intents withdrawal",
            amount: { asset: stellarUsdc, baseUnits: "20000" },
            address: undefined,
          },
        ],
        includedInQuote: true,
      },
    ]);
  });

  it("has nothing on the test network, and says so without asking anyone", async () => {
    const result = rejectionOf(
      await adapter("testnet").quote(ask({ to: { ...stellarUsdc, chainId: "stellar-testnet" } })),
    );
    expect(result.reason).toBe("chain-unsupported");
    expect(result.explanation).toMatch(/main network only/);
    expect(quoteBodies).toHaveLength(0);
    expect(await adapter("testnet").supportedChains()).toEqual([]);
  });

  it("refuses contract and muxed destinations before asking 1Click, since it refuses both", async () => {
    for (const destination of [CONTRACT, MUXED]) {
      const result = rejectionOf(await adapter().quote(ask({ destination })));
      expect(result.reason).toBe("destination-unsupported");
    }
    expect(quoteBodies).toHaveLength(0);
  });

  it("declines a token 1Click does not carry from that chain", async () => {
    const other: Asset = {
      ...arbUsdc,
      id: "0x1111111111111111111111111111111111111111",
      symbol: "FOO",
    };
    const result = rejectionOf(
      await adapter().quote(ask({ from: other, sends: { asset: other, baseUnits: "1" } })),
    );
    expect(result.reason).toBe("asset-unsupported");
    expect(result.explanation).toBe("NEAR Intents does not take FOO deposits on Arbitrum One.");
  });

  it("declines when its decimals disagree with 1Click's, so the amount is never misread", async () => {
    const bscUsdc: Asset = {
      chainId: "bsc",
      id: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      symbol: "USDC",
      decimals: 6,
      curatedBy: undefined,
    };
    const result = rejectionOf(
      await adapter().quote(
        ask({ from: bscUsdc, sends: { asset: bscUsdc, baseUnits: "10000000" } }),
      ),
    );
    expect(result.reason).toBe("asset-unsupported");
    expect(result.explanation).toMatch(/18 decimals, not 6/);
  });

  it("matches the Stellar asset by issuer, never by symbol", async () => {
    const lookalike: Asset = { ...stellarUsdc, id: `USDC:${ACCOUNT}` };
    const result = rejectionOf(await adapter().quote(ask({ to: lookalike })));
    expect(result.reason).toBe("asset-unsupported");
    expect(result.explanation).toBe(
      "NEAR Intents delivers XLM and USDC on Stellar, and not the asset asked for.",
    );
  });

  it("says plainly when 1Click is not quoting into Stellar, without echoing its words", async () => {
    oneClick.quote = () => json({ message: "Quoting for this pair is not available" }, 400);
    const result = rejectionOf(await adapter().quote(ask()));
    expect(result).toEqual({
      source: "near-intents",
      reason: "temporarily-unavailable",
      explanation:
        "NEAR Intents is not quoting transfers from Arbitrum One into Stellar right now. Nothing has been sent.",
      retryable: true,
    });
  });

  it("tells no liquidity apart from an outage", async () => {
    oneClick.quote = () => json({ message: "No liquidity available" }, 400);
    expect(rejectionOf(await adapter().quote(ask())).reason).toBe("no-liquidity");

    oneClick.tokens = () => {
      throw new TypeError("fetch failed");
    };
    const down = rejectionOf(await adapter().quote(ask()));
    expect(down.reason).toBe("temporarily-unavailable");
    expect(down.retryable).toBe(true);
  });

  it("declines a reply quoting a different amount than was asked", async () => {
    oneClick.quote = (body) => quoteReply(body, { amountIn: "9000000" });
    expect(rejectionOf(await adapter().quote(ask())).reason).toBe("errored");
  });

  it("plans the account's preparation when it cannot hold USDC yet", async () => {
    ledger = { account: true, trustline: false };
    const route = routeOf(await adapter().quote(ask()));
    expect(route.steps.map((s) => s.kind)).toEqual(["prepare-account", "bridge", "settle-account"]);
    expect(route.signaturesRequired).toBe(2);
    expect(route.fees.at(-1)).toMatchObject({
      kind: "account-reserve",
      total: { baseUnits: "5000000" },
      includedInQuote: true,
    });
  });

  it("declines an account whose trustline has no room for what the solvers deliver", async () => {
    // the solvers quote 9.95 USDC; the limit leaves room for 5
    ledger = { account: true, trustline: true, trustlineLimit: 50_000_000n };
    const result = rejectionOf(await adapter().quote(ask()));
    expect(result.reason).toBe("destination-unsupported");
    expect(result.explanation).toMatch(/room for only 5 USDC/);
  });

  it("refuses to set up an account for less than the reserve it borrows", async () => {
    ledger = { account: false, trustline: false };
    oneClick.quote = (body) => quoteReply(body, { amountOut: "3000000", minAmountOut: "2900000" });
    const result = rejectionOf(
      await adapter().quote(ask({ sends: { asset: arbUsdc, baseUnits: "300000" } })),
    );
    expect(result.reason).toBe("amount-too-small");
    expect(asked).toContain("horizon order book");
  });

  it("delivers XLM only to an account that already exists", async () => {
    ledger = { account: false, trustline: false };
    const missing = rejectionOf(await adapter().quote(ask({ to: stellarXlm })));
    expect(missing.reason).toBe("destination-unsupported");
    expect(missing.explanation).toMatch(/does not exist yet/);

    ledger = { account: true, trustline: false };
    const route = routeOf(await adapter().quote(ask({ to: stellarXlm })));
    expect(route.receives.asset.id).toBe("native");
    expect(quoteBodies.at(-1)?.destinationAsset).toBe(STELLAR_XLM_ASSET);
    expect(route.steps.map((s) => s.kind)).toEqual(["bridge"]);
  });

  it.each([0.5, -1, 10_000, 12_000, Number.NaN])(
    "declines a slippage of %s basis points without asking 1Click",
    async (bps) => {
      const result = rejectionOf(await adapter().quote(ask({ maxSlippageBps: bps })));
      expect(result.reason).toBe("errored");
      expect(result.retryable).toBe(false);
      expect(result.explanation).toMatch(/whole number of basis points/);
    },
  );

  it("keeps 1Click's configuration complaint out of what the user reads", async () => {
    oneClick.tokens = () => new Response("unauthorized", { status: 401 });
    const result = rejectionOf(await adapter().quote(ask()));
    expect(result.explanation).toBe(
      "NEAR Intents could not quote this transfer. Nothing has been sent.",
    );
    expect(result.detail).toMatch(/API key/);
  });

  it("lists the EVM chains 1Click currently carries a token on", async () => {
    expect(await adapter().supportedChains()).toEqual(["arbitrum", "base", "bsc"]);
  });
});

describe("building", () => {
  it("refuses without the sending wallet, since the refund would have nowhere to go", async () => {
    const route = routeOf(await adapter().quote(ask()));
    await expect(adapter().buildTransactions(route)).rejects.toThrow(/sending wallet's address/);
    await expect(adapter().buildTransactions(route, { sender: undefined })).rejects.toThrow(
      /sending wallet's address/,
    );
  });

  it("asks for the real quote with the wallet as the refund, and pays its deposit address", async () => {
    const near = adapter();
    const route = routeOf(await near.quote(ask()));
    const txs = await near.buildTransactions(route, { sender: SENDER });

    const real = quoteBodies.at(-1) ?? {};
    expect(real).toMatchObject({
      dry: false,
      refundTo: SENDER,
      recipient: ACCOUNT,
      amount: "10000000",
    });
    // The gap between price and floor, rounded up: 0.5% of 99500000 is the floor.
    expect(real.slippageTolerance).toBe(51);

    expect(txs).toHaveLength(1);
    const [tx] = txs;
    expect(tx?.chainId).toBe("arbitrum");
    expect(tx?.format).toBe("evm-tx");
    expect(tx?.unnecessaryWhen).toBeUndefined();
    expect(JSON.parse(tx?.payload ?? "{}")).toEqual({
      to: ARB_USDC,
      abi: [
        {
          type: "function",
          name: "transfer",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "transfer",
      args: [DEPOSIT, "10000000"],
    });
    expect(tx?.describes).toContain(`deposit address ${DEPOSIT}`);
    expect(tx?.describes).toContain(`returned to ${SENDER}`);
    // 1Click's Stellar assets are HOT Omni tokens (nep245:v2_1.omni.hot.tg:1100_...),
    // so the payout on Stellar is a HOT Bridge withdrawal, and consent has to say so
    expect(tx?.describes).toContain("HOT Bridge");
    expect(tx?.describes).not.toContain("inventory");
  });

  it("refuses a real quote whose floor fell below the route's", async () => {
    const near = adapter();
    const route = routeOf(await near.quote(ask()));
    oneClick.quote = (body) =>
      quoteReply(body, { amountOut: "99400000", minAmountOut: "98900000" });
    await expect(near.buildTransactions(route, { sender: SENDER })).rejects.toThrow(/price moved/);
  });

  it.each([
    ["recipient", { recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI" }],
    ["destination asset", { destinationAsset: "nep141:wrap.near" }],
    ["origin asset", { originAsset: "nep141:eth.omft.near" }],
  ])("refuses a real quote 1Click recorded for another %s", async (_what, echoed) => {
    const near = adapter();
    const route = routeOf(await near.quote(ask()));
    oneClick.quote = (body) => quoteReply(body, {}, echoed);
    await expect(near.buildTransactions(route, { sender: SENDER })).rejects.toThrow(
      /recorded a different/,
    );
  });

  it("refuses a deposit that would need a memo, which a token transfer cannot carry", async () => {
    const near = adapter();
    const route = routeOf(await near.quote(ask()));
    oneClick.quote = (body) => quoteReply(body, { depositMemo: "1234" });
    await expect(near.buildTransactions(route, { sender: SENDER })).rejects.toThrow(/memo/);
  });

  it("reads the price off the bridge step once a swap leg has rewritten what is received", async () => {
    const route = routeOf(await adapter().quote(ask()));
    const converted: Route = {
      ...route,
      receives: { asset: stellarXlm, baseUnits: "497500000" },
      receivesAtLeast: { asset: stellarXlm, baseUnits: "490000000" },
    };
    expect(slippageOf(converted)).toBe(slippageOf(route));
  });
});

describe("status", () => {
  it("is idle for a deposit address 1Click never issued", async () => {
    expect(
      await adapter().status({
        sourceTxHash: undefined,
        depositAddress: DEPOSIT,
        destinationAddress: undefined,
        sourceChainId: undefined,
      }),
    ).toEqual({ phase: "idle" });
  });

  it("finds the deposit address from the transaction alone, searching every chain", async () => {
    chainTxs[`https://arb1.arbitrum.io/rpc ${TX}`] = transferTx(ARB_USDC, DEPOSIT, 10_000_000n);
    oneClick.status = () =>
      statusReply("PROCESSING", {
        originChainTxHashes: [{ hash: TX, explorerUrl: "https://arbiscan.io/tx/x" }],
      });

    const phase = await adapter().status({
      sourceTxHash: TX,
      depositAddress: undefined,
      destinationAddress: undefined,
      sourceChainId: undefined,
    });
    expect(asked).toContain(`status ${DEPOSIT}`);
    expect(phase).toEqual({
      phase: "pending",
      ref: { chainId: "arbitrum", txHash: TX, explorerUrl: "https://arbiscan.io/tx/x" },
      expectedByUnix: Date.parse("2026-10-19T15:10:00.000Z") / 1000 + 47,
    });
  });

  it("is idle for a transaction that is not a transfer of a token 1Click carries", async () => {
    chainTxs[`https://arb1.arbitrum.io/rpc ${TX}`] = transferTx(
      "0x1111111111111111111111111111111111111111",
      DEPOSIT,
      1n,
    );
    const phase = await adapter().status({
      sourceTxHash: TX,
      depositAddress: undefined,
      destinationAddress: undefined,
      sourceChainId: "arbitrum",
    });
    expect(phase).toEqual({ phase: "idle" });
    expect(asked.filter((a) => a.startsWith("status"))).toEqual([]);
  });

  it("says it could not look rather than that nothing is there, when no node answered", async () => {
    chainDown.add("https://arb1.arbitrum.io/rpc");
    chainDown.add("https://arbitrum.drpc.org");
    await expect(
      adapter().status({
        sourceTxHash: TX,
        depositAddress: undefined,
        destinationAddress: undefined,
        sourceChainId: "arbitrum",
      }),
    ).rejects.toThrow(/No Arbitrum One node answered/);
  });

  it("is idle by destination address alone, which cannot name a deposit", async () => {
    expect(
      await adapter().status({
        sourceTxHash: undefined,
        depositAddress: undefined,
        destinationAddress: ACCOUNT,
        sourceChainId: undefined,
      }),
    ).toEqual({ phase: "idle" });
  });

  const byDeposit = {
    sourceTxHash: TX,
    depositAddress: DEPOSIT,
    destinationAddress: undefined,
    sourceChainId: "arbitrum",
  };

  it("reports a settled transfer as delivered, linked to the Stellar transaction", async () => {
    oneClick.status = () =>
      statusReply("SUCCESS", {
        amountOut: "99600000",
        destinationChainTxHashes: [{ hash: "f00d", explorerUrl: "" }],
      });
    expect(await adapter().status(byDeposit)).toEqual({
      phase: "done",
      ref: {
        chainId: "stellar",
        txHash: "f00d",
        explorerUrl: "https://stellar.expert/explorer/public/tx/f00d",
      },
      received: {
        asset: {
          chainId: "stellar",
          id: USDC_ID,
          symbol: "USDC",
          decimals: 7,
          curatedBy: undefined,
        },
        baseUnits: "99600000",
      },
    });
  });

  it("reports only the quoted floor as received when 1Click does not say what settled", async () => {
    oneClick.status = () =>
      statusReply("SUCCESS", { destinationChainTxHashes: [{ hash: "f00d", explorerUrl: "" }] });
    const phase = await adapter().status(byDeposit);
    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    expect(phase.received.baseUnits).toBe("99000000");
  });

  it("never reads a short settlement as delivered", async () => {
    oneClick.status = () => statusReply("SUCCESS", { amountOut: "50000000" });
    const phase = await adapter().status(byDeposit);
    expect(phase.phase).toBe("partial");
    if (phase.phase !== "partial") return;
    expect(phase.received.baseUnits).toBe("50000000");
    expect(phase.expected.baseUnits).toBe("99500000");
    expect(phase.remedy).toMatchObject({ kind: "contact", reference: DEPOSIT });
  });

  it("reports a refund as returned to the wallet, in the asset that was sent", async () => {
    oneClick.status = () => statusReply("REFUNDED", { refundedAmount: "9700000" });
    const phase = await adapter().status(byDeposit);
    expect(phase).toMatchObject({
      phase: "refunded",
      to: SENDER,
      returned: { asset: { chainId: "arbitrum", id: ARB_USDC, decimals: 6 }, baseUnits: "9700000" },
    });
  });

  it("reports a short deposit as stalled until the quote expires", async () => {
    oneClick.status = () => statusReply("INCOMPLETE_DEPOSIT");
    const phase = await adapter().status(byDeposit);
    expect(phase).toMatchObject({
      phase: "stalled",
      remedy: { kind: "wait", untilUnix: Date.parse("2026-10-19T16:00:00.000Z") / 1000 },
    });
  });

  it("reports a failure with the deposit address as the reference support needs", async () => {
    oneClick.status = () => statusReply("FAILED");
    expect(await adapter().status(byDeposit)).toMatchObject({
      phase: "failed",
      cause: "NEAR Intents could not complete this transfer.",
      remedy: { kind: "contact", reference: DEPOSIT },
    });
  });

  it("reads a deposit address with nothing paid in yet as not started", async () => {
    oneClick.status = () => statusReply("PENDING_DEPOSIT");
    expect(await adapter().status({ ...byDeposit, sourceTxHash: undefined })).toEqual({
      phase: "idle",
    });
    expect((await adapter().status(byDeposit)).phase).toBe("pending");
  });
});
