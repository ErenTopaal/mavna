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
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESTINATION, routeFor, STELLAR_USDC } from "./__fixtures__/scripted";
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

describe("converting on Stellar", () => {
  it("quotes through the venue chain, builds with the venue that quoted, and submits", async () => {
    const simulated: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The testnet sponsor holds no Soroswap key, so it has no proxy.
      if (url.startsWith(`${SPONSOR}/swap/soroswap/health`)) return respond({}, 404);
      if (url.startsWith(`${AQUA}/api/external/v1/pools/`)) return respond({ count: 3 });
      if (url.startsWith(`${AQUA}/api/external/v1/find-path/`)) {
        return respond({
          success: true,
          // one pool straight from USDC to XLM, as Aquarius encodes a chain
          swap_chain_xdr: xdr.ScVal.scvVec([
            xdr.ScVal.scvVec([
              xdr.ScVal.scvVec([new Address(USDC).toScVal(), new Address(XLM).toScVal()]),
              xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
              new Address(XLM).toScVal(),
            ]),
          ]).toXDR("base64"),
          pools: ["CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX"],
          tokens_addresses: [USDC, XLM],
          amount: 26_000_000,
        });
      }
      if (url.startsWith(RPC)) {
        const tx = TransactionBuilder.fromXDR(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}").params.transaction,
          Networks.TESTNET,
        );
        if ("operations" in tx && tx.operations[0]?.type === "invokeHostFunction") {
          const call = tx.operations[0].func.invokeContract();
          simulated.push(
            `${Address.fromScAddress(call.contractAddress()).toString()} ${call.functionName().toString()}`,
          );
        }
        return respond({
          jsonrpc: "2.0",
          id: 1,
          result: {
            latestLedger: 10,
            minResourceFee: "100",
            transactionData: new SorobanDataBuilder().setResourceFee(100).build().toXDR("base64"),
            results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
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
      sent.push(tx.toXDR());
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

    await convertOnStellar(engine, routeFor("layerzero", { swap: true }), DESTINATION);

    expect(simulated).toEqual([`${ROUTER} swap_chained`]);
    expect(signed).toHaveLength(1);
    expect(sent).toEqual(signed);
    const tx = TransactionBuilder.fromXDR(signed[0] ?? "", Networks.TESTNET);
    expect("source" in tx && tx.source).toBe(DESTINATION);
  });
});
