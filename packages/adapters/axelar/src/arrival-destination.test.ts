import type { Route } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { AxelarAdapter } from "./adapter.js";

/**
 * The Arrival Contract only acts on what LayerZero hands it with instructions.
 * A plain transfer to it lands in a contract that has no way to send it on, so
 * every rail refuses it as a destination, before anything is asked of a network.
 */
const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";
const nowhere = () => new RpcClient({ url: "https://rpc.invalid" });

describe("a plain Axelar transfer to the Arrival Contract", () => {
  const adapter = () =>
    new AxelarAdapter({
      network: "testnet",
      rpc: nowhere(),
      baseReserveStroops: 5_000_000,
      arrivalContract: ARRIVAL,
    });
  const from = {
    chainId: "base-sepolia",
    id: "0xa813265d59c9bc06e439e61fa133b5f23134b2ce",
    symbol: "USDC",
    decimals: 6,
    curatedBy: undefined,
  };
  const to = {
    chainId: "stellar-testnet",
    id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    symbol: "USDC",
    decimals: 7,
    curatedBy: undefined,
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
    const plain = new AxelarAdapter({
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
