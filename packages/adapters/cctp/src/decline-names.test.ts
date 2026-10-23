import type { Asset, QuoteRequest } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * A chain this rail does not carry is named the way the picker names it,
 * never by the id the code uses for it.
 */

const adapter = new CctpAdapter({
  network: "testnet",
  rpc: new RpcClient({ url: "https://127.0.0.1:9" }),
  baseReserveStroops: 5_000_000,
});

const from: Asset = {
  chainId: "some-chain",
  id: "0x1111111111111111111111111111111111111111",
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};
const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from,
  to: {
    chainId: "stellar-testnet",
    id: `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`,
    symbol: "USDC",
    decimals: 7,
    curatedBy: "Circle",
  },
  sends: { asset: from, baseUnits: "10000000" },
  destination: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
  maxSlippageBps: 50,
  ...over,
});

describe("a source chain Circle does not carry here", () => {
  it("is named by its display name", async () => {
    const result = await adapter.quote(ask({ fromChainName: "Some Chain" }));
    expect(result).toMatchObject({
      reason: "chain-unsupported",
      explanation: "Mavna does not move funds from Some Chain yet.",
    });
  });

  it("is never named by its id when no display name was given", async () => {
    const result = await adapter.quote(ask());
    expect(result).toMatchObject({
      reason: "chain-unsupported",
      explanation: "Mavna does not move funds from that chain yet.",
    });
  });
});
