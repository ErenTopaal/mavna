import { isRejection } from "@mavna/core";
import { describe, expect, it, vi } from "vitest";
import { createEngine, type EngineConfig } from "./engine";

// the browser wallet kit cannot load under Node, and no wallet is touched here
vi.mock("./stellar-wallet.js", () => ({ createStellarWallet: () => ({}) }));

/**
 * The widget hands the Arrival Contract it converts through to every rail, so
 * none of them offers a plain transfer into it, where the funds would be stuck.
 */
const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";
const config: EngineConfig = {
  network: "testnet",
  rpcUrl: "https://rpc.invalid",
  sponsorUrl: "https://sponsor.invalid",
  disabledSources: undefined,
  ranking: "best-received",
  integratorFee: undefined,
  historyKey: "mavna.transfers.v1.testnet",
  arrivalContract: ARRIVAL,
};

describe("every rail the widget runs", () => {
  it("refuses the Arrival Contract as a plain destination", async () => {
    const engine = createEngine(config);
    expect(engine.adapters.map((a) => a.id)).toEqual([
      "cctp",
      "axelar",
      "layerzero",
      "near-intents",
    ]);
    for (const adapter of engine.adapters) {
      const from = {
        chainId: "base-sepolia",
        id: "0x1",
        symbol: "USDC",
        decimals: 6,
        curatedBy: undefined,
      };
      const result = await adapter.quote({
        from,
        to: {
          chainId: "stellar-testnet",
          id: "native",
          symbol: "XLM",
          decimals: 7,
          curatedBy: "Stellar",
        },
        sends: { asset: from, baseUnits: "1000000" },
        destination: ARRIVAL,
        maxSlippageBps: 50,
      });
      expect(isRejection(result), adapter.id).toBe(true);
      expect(result, adapter.id).toMatchObject({ reason: "destination-unsupported" });
    }
  });
});
