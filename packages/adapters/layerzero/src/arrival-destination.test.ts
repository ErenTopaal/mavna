import { ARRIVAL_CONTRACT_IDS, type Route } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { LayerZeroAdapter } from "./adapter.js";
import { ARRIVAL_CONTRACTS } from "./config.js";

/**
 * The Arrival Contract only acts on what LayerZero hands it with instructions.
 * A plain transfer to it lands in a contract that has no way to send it on, so
 * every rail refuses it as a destination, before anything is asked of a network.
 */
const ARRIVAL = "CDHHLRLKWNRMRQ2PPT7CNMWG3OF4XOIQ2QTDEBMZ25CJQCLQK7Y5PMPD";
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a plain LayerZero transfer to the Arrival Contract", () => {
  const request = (destination: string) => {
    const from = {
      chainId: "arbitrum-sepolia",
      id: "0x0000000000000000000000000000000000000001",
      symbol: "TOFT",
      decimals: 18,
      curatedBy: undefined,
    };
    return {
      from,
      to: {
        chainId: "stellar-testnet",
        id: "native",
        symbol: "XLM",
        decimals: 7,
        curatedBy: "Stellar",
      },
      sends: { asset: from, baseUnits: "1000" },
      destination,
      maxSlippageBps: 50,
    };
  };

  it("is declined when the adapter converts on arrival through it", async () => {
    const adapter = new LayerZeroAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
      arrival: {
        contract: ARRIVAL,
        venue: { id: "aquarius", quotePath: async () => Promise.reject(new Error("unused")) },
      },
    });
    const result = await adapter.quote(request(ARRIVAL));
    expect(result).toMatchObject({ reason: "destination-unsupported", retryable: false });
    expect("explanation" in result && result.explanation).toMatch(/Arrival Contract/);
  });

  it("is declined for the network's deployed one even with no conversion set up", async () => {
    expect(ARRIVAL_CONTRACTS.testnet?.contract).toBe(ARRIVAL);
    // the same id core holds for every rail
    expect(ARRIVAL_CONTRACT_IDS.testnet).toBe(ARRIVAL);
    const adapter = new LayerZeroAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
    });
    const result = await adapter.quote(request(ARRIVAL));
    expect(result).toMatchObject({ reason: "destination-unsupported" });
  });

  it("is refused again when a plain route naming it is built", async () => {
    const adapter = new LayerZeroAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
    });
    await expect(
      adapter.buildTransactions({ destination: ARRIVAL, compose: undefined } as unknown as Route),
    ).rejects.toThrow(/Arrival Contract/);
  });
});
