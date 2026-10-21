import type { Route } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * The Arrival Contract only acts on what LayerZero hands it with instructions.
 * A plain transfer to it lands in a contract that has no way to send it on, so
 * every rail refuses it as a destination, before anything is asked of a network.
 */
const ARRIVAL = "CDHHLRLKWNRMRQ2PPT7CNMWG3OF4XOIQ2QTDEBMZ25CJQCLQK7Y5PMPD";
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a plain CCTP transfer to the Arrival Contract", () => {
  const adapter = () =>
    new CctpAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
      arrivalContract: ARRIVAL,
    });
  const from = {
    chainId: "ethereum-sepolia",
    id: sourceUsdcFor("testnet", "ethereum-sepolia")?.address ?? "",
    symbol: "USDC",
    decimals: 6,
    curatedBy: "Circle",
  };
  const to = {
    chainId: "stellar-testnet",
    id: `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`,
    symbol: "USDC",
    decimals: 7,
    curatedBy: "Circle",
  };

  it("is declined with the reason", async () => {
    const result = await adapter().quote({
      from,
      to,
      sends: { asset: from, baseUnits: "25000000" },
      destination: ARRIVAL,
      maxSlippageBps: 50,
    });
    expect(result).toMatchObject({ reason: "destination-unsupported", retryable: false });
    expect("explanation" in result && result.explanation).toMatch(/Arrival Contract/);
  });

  it("is declined by default, with no Arrival Contract passed in", async () => {
    const plain = new CctpAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
    });
    const result = await plain.quote({
      from,
      to,
      sends: { asset: from, baseUnits: "25000000" },
      destination: ARRIVAL,
      maxSlippageBps: 50,
    });
    expect(result).toMatchObject({ reason: "destination-unsupported", retryable: false });
    await expect(
      plain.buildTransactions({ destination: ARRIVAL } as unknown as Route),
    ).rejects.toThrow(/Arrival Contract/);
  });

  it("is refused again when a route naming it is built", async () => {
    await expect(
      adapter().buildTransactions({ destination: ARRIVAL } as unknown as Route),
    ).rejects.toThrow(/Arrival Contract/);
  });
});
