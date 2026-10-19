import { MavnaError } from "@mavna/core";
import { Account, Address, Keypair, Networks, scValToNative, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bodyOf,
  type ContractCall,
  json,
  routedFetch,
  sorobanNode,
} from "./__fixtures__/network.js";
import { AquariusProvider } from "./aquarius.js";

const API = "https://amm-api-testnet.aqua.network";
const RPC = "https://rpc.example";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
// Circle's testnet USDC and testnet XLM, as their asset contracts.
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL = "CD3LFMMLBQ6RBJUD3Z2LFDFE6544WDRMWHEZYPI5YDVESYRSO2TT32BX";
const CHAIN = xdr.ScVal.scvVec([xdr.ScVal.scvU32(7)]).toXDR("base64");

const request = {
  assetIn: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  assetOut: "native",
  amountIn: "10000000",
  maxSlippageBps: 100,
  destinationKind: "account" as const,
};

const found = {
  success: true,
  swap_chain_xdr: CHAIN,
  pools: [POOL],
  tokens: ["USDC", "native"],
  tokens_addresses: [USDC, XLM],
  amount: 52_000_000,
  amount_with_fee: 52_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aquarius quotes", () => {
  it("asks for the asset contracts and floors the output by the user's slippage", async () => {
    const net = routedFetch({ [`${API}/api/external/v1/find-path/`]: () => json(found) });
    vi.stubGlobal("fetch", net.fetch);
    const quote = await new AquariusProvider("testnet").quote(request);
    expect(bodyOf(net.calls[0])).toEqual({
      token_in_address: USDC,
      token_out_address: XLM,
      amount: "10000000",
    });
    expect(quote).toMatchObject({
      provider: "aquarius",
      amountOut: "52000000",
      amountOutMinimum: "51480000",
      venues: [POOL],
      isClassicPathPayment: false,
    });
  });

  it("refuses a path that does not start and end at the asked-for assets", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () =>
          json({ ...found, tokens_addresses: [XLM, USDC] }),
      }).fetch,
    );
    const error = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("refuses an amount a double could not hold exactly", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () => json({ ...found, amount: 2 ** 60 }),
      }).fetch,
    );
    const error = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("says no route plainly, and a server error is worth retrying", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${API}/api/external/v1/find-path/`]: () => json({ ...found, success: false, pools: [] }),
      }).fetch,
    );
    const none = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect((none as MavnaError).retryable).toBe(false);

    vi.stubGlobal(
      "fetch",
      routedFetch({ [`${API}/api/external/v1/find-path/`]: () => json({}, 503) }).fetch,
    );
    const down = await new AquariusProvider("testnet").quote(request).catch((e: unknown) => e);
    expect((down as MavnaError).retryable).toBe(true);
  });
});

describe("aquarius builds", () => {
  it("calls swap_chained on the router with the found chain and the user's floor", async () => {
    const owner = Keypair.random().publicKey();
    const seen: ContractCall[] = [];
    const net = routedFetch({
      [`${API}/api/external/v1/find-path/`]: () => json(found),
      [RPC]: sorobanNode((call) => {
        seen.push(call);
        return xdr.ScVal.scvU64(xdr.Uint64.fromString("52000000"));
      }, Networks.TESTNET),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: RPC });
    const quote = await provider.quote(request);
    const tx = await provider.build({ quote, account: new Account(owner, "10") });

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.contract).toBe(ROUTER);
    expect(call?.method).toBe("swap_chained");
    expect(call?.source).toBe(owner);
    const [user, chain, tokenIn, amountIn, floor] = call?.args ?? [];
    expect(user && Address.fromScVal(user).toString()).toBe(owner);
    expect(chain?.toXDR("base64")).toBe(CHAIN);
    expect(tokenIn && Address.fromScVal(tokenIn).toString()).toBe(USDC);
    expect(amountIn && scValToNative(amountIn)).toBe(10_000_000n);
    expect(floor && scValToNative(floor)).toBe(51_480_000n);

    // Assembled from the simulation: resources attached, sequence advanced.
    expect(tx.source).toBe(owner);
    expect(tx.sequence).toBe("11");
    expect(Number(tx.fee)).toBeGreaterThan(12_345);
  });

  it("turns a failed simulation into a refusal that is not retried", async () => {
    const net = routedFetch({
      [`${API}/api/external/v1/find-path/`]: () => json(found),
      [RPC]: sorobanNode(
        () => ({ error: "HostError: Error(Contract, #2006)\nmore" }),
        Networks.TESTNET,
      ),
    });
    vi.stubGlobal("fetch", net.fetch);
    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: RPC });
    const quote = await provider.quote(request);
    const error = await provider
      .build({ quote, account: new Account(Keypair.random().publicKey(), "1") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
    expect((error as MavnaError).message).toContain("Error(Contract, #2006)");
    expect((error as MavnaError).message).not.toContain("more");
  });
});
