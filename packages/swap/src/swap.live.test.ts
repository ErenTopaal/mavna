import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AquariusProvider } from "./aquarius.js";
import { SushiSwapProvider } from "./sushiswap.js";
import { STELLAR_USDT0 } from "./venues.js";

/**
 * Against the live venues, read-only. Nothing here signs or submits: a build is
 * checked by the RPC simulating it for a real holder of the input asset, which
 * is as far as one can go on mainnet without spending someone's money.
 *
 * Soroswap's live test sits with the sponsor's proxy, which is the only thing
 * that can reach it.
 */

const MAINNET_RPC = PUBLIC_MAINNET_RPC_URLS[0] ?? "";
const USDC_MAINNET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_TESTNET = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Large public holders, from stellar.expert's holder lists on 2026-10-19. Used
 * only as the simulated source of a swap; their balances decide nothing here
 * beyond the simulation having something to spend.
 */
const USDC_HOLDER = "GC5LF63GRVIT5ZXXCXLPI3RX2YXKJQFZVBSAO6AUELN3YIMSWPD6Z6FH";
const USDT0_HOLDER = "GAQZU7Y7GB3E4XOA3ZXEZDOTIEIWQRYOAIVJ6STY2YTUQAGZL3GYJCXG";

function invariants(quote: {
  amountOut: string;
  amountOutMinimum: string;
  venues: readonly string[];
}) {
  // Invariants, not exact figures: live liquidity decides the number and
  // asserting it would make this test lie the moment the pool moves.
  expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
  expect(BigInt(quote.amountOutMinimum)).toBeLessThanOrEqual(BigInt(quote.amountOut));
  expect(quote.venues.length).toBeGreaterThan(0);
}

describe("Aquarius, live", () => {
  it("is usable on both networks", async () => {
    expect(await new AquariusProvider("testnet").isUsable()).toBe(true);
    expect(await new AquariusProvider("mainnet").isUsable()).toBe(true);
  });

  it("prices Circle's testnet USDC into XLM, which is what the testnet widget converts", async () => {
    const quote = await new AquariusProvider("testnet").quote({
      assetIn: USDC_TESTNET,
      assetOut: "native",
      amountIn: "10000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });
    invariants(quote);
    expect(quote.isClassicPathPayment).toBe(false);
  });

  it("says plainly when there is no route rather than returning a zero", async () => {
    await expect(
      new AquariusProvider("testnet").quote({
        assetIn: USDC_TESTNET,
        // A contract that is no token at all: Aquarius's own router.
        assetOut: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
        amountIn: "10000000",
        maxSlippageBps: 50,
        destinationKind: "account",
      }),
    ).rejects.toThrow();
  });

  it("builds a mainnet swap the RPC simulates for a real USDC holder", async () => {
    const provider = new AquariusProvider("mainnet", undefined, { rpcUrl: MAINNET_RPC });
    const quote = await provider.quote({
      assetIn: USDC_MAINNET,
      assetOut: "native",
      amountIn: "10000000",
      maxSlippageBps: 100,
      destinationKind: "account",
    });
    invariants(quote);
    const account = await new RpcClient({ url: MAINNET_RPC }).loadAccount(USDC_HOLDER);
    const tx = await provider.build({ quote, account });
    expect(tx.source).toBe(USDC_HOLDER);
    expect(tx.operations[0]?.type).toBe("invokeHostFunction");
    expect(tx.signatures).toHaveLength(0);
  });

  it("executes on testnet: XLM into Circle's USDC and back, from a fresh account", async () => {
    // A real round trip, signed by a throwaway Friendbot-funded key, because a
    // simulation proves the call is well formed and only a landed swap proves
    // the router honours it. Testnet only; nothing here touches mainnet.
    const rpc = new RpcClient({ url: PUBLIC_TESTNET_RPC_URL });
    const user = Keypair.random();
    const funded = await fetch(`https://friendbot.stellar.org?addr=${user.publicKey()}`);
    expect(funded.ok).toBe(true);

    const [code, issuer] = USDC_TESTNET.split(":");
    await rpc.submit("trustline", async () => {
      const tx = new TransactionBuilder(await rpc.loadAccount(user.publicKey()), {
        fee: "1000",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.changeTrust({ asset: new Asset(code ?? "", issuer ?? "") }))
        .setTimeout(60)
        .build();
      tx.sign(user);
      return tx;
    });

    const provider = new AquariusProvider("testnet", undefined, { rpcUrl: PUBLIC_TESTNET_RPC_URL });
    const swap = async (assetIn: string, assetOut: string, amountIn: string) => {
      const quote = await provider.quote({
        assetIn,
        assetOut,
        amountIn,
        maxSlippageBps: 100,
        destinationKind: "account",
      });
      const landed = await rpc.submit(`${assetIn} to ${assetOut}`, async () => {
        const tx = await provider.build({
          quote,
          account: await rpc.loadAccount(user.publicKey()),
        });
        tx.sign(user);
        return tx;
      });
      expect(landed.txHash).toMatch(/^[0-9a-f]{64}$/);
      return quote;
    };

    const bought = await swap("native", USDC_TESTNET, "100000000");
    // Spend at most what the floor guaranteed, so the sell side has the balance.
    await swap(USDC_TESTNET, "native", bought.amountOutMinimum);
  });
});

describe("SushiSwap, live", () => {
  it("is usable on mainnet and not on testnet", async () => {
    expect(
      await new SushiSwapProvider({ network: "mainnet", rpcUrl: MAINNET_RPC }).isUsable(),
    ).toBe(true);
    expect(await new SushiSwapProvider({ network: "testnet" }).isUsable()).toBe(false);
  });

  it("prices USDT0 into USDC directly and into XLM through USDC", async () => {
    const provider = new SushiSwapProvider({ network: "mainnet", rpcUrl: MAINNET_RPC });
    const toUsdc = await provider.quote({
      assetIn: STELLAR_USDT0,
      assetOut: USDC_MAINNET,
      amountIn: "100000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });
    invariants(toUsdc);
    // A stable pair: ten USDT0 is close to ten USDC, whatever the pool's depth.
    expect(BigInt(toUsdc.amountOut)).toBeGreaterThan(95_000_000n);

    const toXlm = await provider.quote({
      assetIn: STELLAR_USDT0,
      assetOut: "native",
      amountIn: "100000000",
      maxSlippageBps: 50,
      destinationKind: "account",
    });
    invariants(toXlm);
  });

  it("builds a mainnet swap the RPC simulates for a real USDT0 holder", async () => {
    const provider = new SushiSwapProvider({ network: "mainnet", rpcUrl: MAINNET_RPC });
    const quote = await provider.quote({
      assetIn: STELLAR_USDT0,
      assetOut: USDC_MAINNET,
      amountIn: "10000000",
      maxSlippageBps: 100,
      destinationKind: "account",
    });
    const account = await new RpcClient({ url: MAINNET_RPC }).loadAccount(USDT0_HOLDER);
    const tx = await provider.build({ quote, account });
    expect(tx.source).toBe(USDT0_HOLDER);
    expect(tx.operations[0]?.type).toBe("invokeHostFunction");
    expect(tx.signatures).toHaveLength(0);
  });
});
