import { RpcClient } from "@mavna/stellar";
import { createSwapVenues } from "@mavna/swap";
import {
  Address,
  Networks,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESTINATION, routeFor, STELLAR_USDC, STELLAR_XLM } from "./__fixtures__/scripted";
import { convertOnStellar, type TransferEngine } from "./transfer";

/**
 * The conversion step, through the venue chain rather than the orderbook.
 *
 * Doubles sit at the network: Aquarius's API and the Stellar RPC answer over a
 * stubbed fetch, the RPC client's node answers loads and submissions, and the
 * wallet signs. The venue chain, Aquarius's builder and the step are real.
 */

const AQUA = "https://amm-api-testnet.aqua.network";
const RPC = "https://rpc.example";
const SPONSOR = "https://sponsor.example";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A route whose conversion step turns the USDC that arrived into XLM, as attachSwapLeg builds it. */
function usdcIntoXlm() {
  const base = routeFor("layerzero", { swap: true });
  return {
    ...base,
    steps: base.steps.map((step) =>
      step.kind === "swap"
        ? {
            ...step,
            from: { asset: STELLAR_USDC, baseUnits: "50000000" },
            to: { asset: STELLAR_XLM, baseUnits: "26000000" },
          }
        : step,
    ),
  };
}

/** What Aquarius quotes for an input; a flat 26 XLM unless a test prices by size. */
let quoteOut: (amountIn: number) => number;
beforeEach(() => {
  quoteOut = () => 26_000_000;
});

describe("converting on Stellar", () => {
  /** When set, the node's simulation of the swap fails with this host error. */
  let hostError: string | undefined;
  afterEach(() => {
    hostError = undefined;
  });

  /** The network doubles and a real venue chain; what crossed the boundary is returned. */
  function setUp() {
    const simulated: string[] = [];
    const pathsAsked: string[] = [];
    const amountsAsked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The testnet sponsor holds no Soroswap key, so it has no proxy.
      if (url.startsWith(`${SPONSOR}/swap/soroswap/health`)) return respond({}, 404);
      if (url.startsWith(`${AQUA}/api/external/v1/pools/`)) return respond({ count: 3 });
      if (url.startsWith(`${AQUA}/api/external/v1/find-path/`)) {
        // one pool straight between whatever was asked, as Aquarius encodes a chain
        const asked = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          token_in_address: string;
          token_out_address: string;
        };
        pathsAsked.push(`${asked.token_in_address} ${asked.token_out_address}`);
        amountsAsked.push(String((asked as { amount?: unknown }).amount));
        const tokenIn = asked.token_in_address;
        const tokenOut = asked.token_out_address;
        return respond({
          success: true,
          swap_chain_xdr: xdr.ScVal.scvVec([
            xdr.ScVal.scvVec([
              xdr.ScVal.scvVec([new Address(tokenIn).toScVal(), new Address(tokenOut).toScVal()]),
              xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
              new Address(tokenOut).toScVal(),
            ]),
          ]).toXdr("base64"),
          pools: ["CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX"],
          tokens_addresses: [tokenIn, tokenOut],
          amount: quoteOut(Number((asked as { amount?: unknown }).amount)),
        });
      }
      if (url.startsWith(RPC)) {
        const tx = TransactionBuilder.fromXdr(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}").params.transaction,
          Networks.TESTNET,
        );
        if ("operations" in tx && tx.operations[0]?.type === "invokeHostFunction") {
          const call = xdr.expectUnionVariant(
            tx.operations[0].func,
            "hostFunctionTypeInvokeContract",
          ).invokeContract;
          simulated.push(
            `${Address.fromScAddress(call.contractAddress).toString()} ${call.functionName.toString()}`,
          );
        }
        if (hostError !== undefined) {
          return respond({ jsonrpc: "2.0", id: 1, result: { latestLedger: 10, error: hostError } });
        }
        return respond({
          jsonrpc: "2.0",
          id: 1,
          result: {
            latestLedger: 10,
            minResourceFee: "100",
            transactionData: new SorobanDataBuilder().setResourceFee(100).build().toXdr("base64"),
            results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr("base64") }],
          },
        });
      }
      throw new TypeError(`fetch failed: nothing answers ${url}`);
    });

    const node = new RpcClient({ url: RPC, baseDelayMs: 0, sleep: async () => {} });
    vi.spyOn(node, "loadAccount").mockImplementation(async (id) => {
      const { Account } = await import("@stellar/stellar-sdk");
      return new Account(id, "7");
    });
    const sent: string[] = [];
    vi.spyOn(node.server, "sendTransaction").mockImplementation(async (tx) => {
      sent.push(tx.toXdr());
      return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 10 } as never;
    });
    vi.spyOn(node.server, "getTransaction").mockImplementation(
      async () =>
        ({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          latestLedger: 11,
          txHash: "ab".repeat(32),
        }) as never,
    );

    const signed: string[] = [];
    const engine: Pick<
      TransferEngine,
      "network" | "stellar" | "swapVenues" | "rpc" | "usdcOnStellar"
    > = {
      network: "testnet",
      stellar: {
        connect: async () => DESTINATION,
        sign: async (unsigned: string) => {
          signed.push(unsigned);
          return unsigned;
        },
        disconnect: async () => {},
      },
      swapVenues: createSwapVenues({ network: "testnet", soroswapProxyUrl: SPONSOR, rpcUrl: RPC }),
      rpc: node,
      usdcOnStellar: STELLAR_USDC,
    };

    return { engine, simulated, signed, sent, pathsAsked, amountsAsked };
  }

  it("quotes through the venue chain, builds with the venue that quoted, and submits", async () => {
    const { engine, simulated, signed, sent } = setUp();
    await convertOnStellar(engine, usdcIntoXlm(), DESTINATION, "50000000");

    expect(simulated).toEqual([`${ROUTER} swap_chained`]);
    expect(signed).toHaveLength(1);
    expect(sent).toEqual(signed);
    const tx = TransactionBuilder.fromXdr(signed[0] ?? "", Networks.TESTNET);
    expect("source" in tx && tx.source).toBe(DESTINATION);
  });

  it("converts what the route delivered into what it promised, not always USDC into XLM", async () => {
    // a conversion step from XLM into USDC, the other way round
    const base = routeFor("layerzero", { swap: true });
    const route = {
      ...base,
      receivesAtLeast: { asset: STELLAR_USDC, baseUnits: "1" },
      steps: base.steps.map((step) =>
        step.kind === "swap"
          ? {
              ...step,
              from: { asset: STELLAR_XLM, baseUnits: "50000000" },
              to: { asset: STELLAR_USDC, baseUnits: "26000000" },
            }
          : step,
      ),
    };
    const run = setUp();
    await convertOnStellar(run.engine, route, DESTINATION, "50000000");
    expect(run.pathsAsked).toEqual([`${XLM} ${USDC}`]);
    expect(run.sent).toHaveLength(1);
  });

  it("converts exactly what arrived for this transfer, never the account's other funds", async () => {
    const run = setUp();
    // the route expected 50 USDC; 49.5 landed, and that is all that may be spent
    await convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "49500000");
    expect(run.amountsAsked).toEqual(["49500000"]);
  });

  it("refuses to convert when nothing measurable arrived", async () => {
    const run = setUp();
    await expect(convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "0")).rejects.toThrow(
      /nothing.*arrived/i,
    );
    expect(run.signed).toEqual([]);
  });

  it("will not convert below the least XLM the user was shown", async () => {
    // Aquarius now quotes 26 XLM, so 50 bps of slippage floors it at 25.87
    const shown = (baseUnits: string) => ({
      ...usdcIntoXlm(),
      receivesAtLeast: { asset: STELLAR_XLM, baseUnits },
    });
    const held = setUp();
    await convertOnStellar(held.engine, shown("25870000"), DESTINATION, "50000000");
    expect(held.sent).toHaveLength(1);

    const moved = setUp();
    await expect(
      convertOnStellar(moved.engine, shown("25870001"), DESTINATION, "50000000"),
    ).rejects.toThrow(/price moved.*USDC has arrived/);
    expect(moved.signed).toEqual([]);
  });

  it("holds a smaller conversion to the rate the user was shown, not to the whole amount's floor", async () => {
    // the sponsor's repayment left 40 of the 50 priced, at the same 0.52 XLM per USDC
    quoteOut = (amountIn) => Math.floor((amountIn * 26) / 50);
    const run = setUp();
    expect(await convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "40000000")).toBe(
      "converted",
    );
    expect(run.sent).toHaveLength(1);
  });

  it("does not resend a signed conversion the network turned away for its sequence", async () => {
    const run = setUp();
    const node = run.engine.rpc;
    let sends = 0;
    vi.spyOn(node.server, "sendTransaction").mockImplementation(async () => {
      sends += 1;
      return {
        status: "ERROR",
        hash: "ab".repeat(32),
        latestLedger: 10,
        errorResult: new xdr.TransactionResult({
          feeCharged: xdr.Int64.fromString("100"),
          result: xdr.TransactionResultResult.txBadSeq(),
          ext: xdr.TransactionResultExt.v0(),
        }),
      } as never;
    });
    await expect(
      convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "50000000"),
    ).rejects.toThrow(/txBadSeq/);
    expect(sends).toBe(1);
  });

  it("tells the user a swap could not be prepared without the host's own error text", async () => {
    hostError = "HostError: Error(Contract, #6)\nEvent log (newest first): ...";
    const run = setUp();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "50000000").catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("Aquarius could not prepare this swap right now.");
    expect((error as Error).message).not.toMatch(/HostError/);
    // kept for whoever runs the page, in the console
    expect(warned.mock.calls.flat().join(" ")).toMatch(/HostError: Error\(Contract, #6\)/);
    expect(run.signed).toEqual([]);
  });

  it("leaves an amount the venue would turn into nothing as it arrived", async () => {
    quoteOut = () => 0;
    const run = setUp();
    expect(await convertOnStellar(run.engine, usdcIntoXlm(), DESTINATION, "1")).toBe("too-small");
    expect(run.signed).toEqual([]);
  });
});
