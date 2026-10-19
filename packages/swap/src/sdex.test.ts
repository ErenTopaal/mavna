import { MavnaError } from "@mavna/core";
import { Account, Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, routedFetch } from "./__fixtures__/network.js";
import { SdexProvider } from "./sdex.js";

const HORIZON = "https://horizon-testnet.stellar.org";
const request = {
  assetIn: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  assetOut: "native",
  amountIn: "10000000",
  maxSlippageBps: 50,
  destinationKind: "account" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sdex", () => {
  it("quotes Horizon's best path and builds it as a strict-send path payment", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${HORIZON}/paths/strict-send`]: () =>
          json({ _embedded: { records: [{ destination_amount: "5.2000000", path: [] }] } }),
      }).fetch,
    );
    const provider = new SdexProvider("testnet");
    const quote = await provider.quote(request);
    expect(quote).toMatchObject({ amountOut: "52000000", amountOutMinimum: "51740000" });

    const owner = Keypair.random().publicKey();
    const tx = await provider.build({ quote, account: new Account(owner, "3") });
    const op = tx.operations[0];
    expect(op?.type).toBe("pathPaymentStrictSend");
    if (op?.type === "pathPaymentStrictSend") {
      expect(op.destination).toBe(owner);
      expect(op.destMin).toBe("5.1740000");
    }
  });

  it("refuses a Horizon answer that is not an amount", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        [`${HORIZON}/paths/strict-send`]: () =>
          json({ _embedded: { records: [{ destination_amount: "1e9", path: [] }] } }),
      }).fetch,
    );
    const error = await new SdexProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(false);
  });

  it("treats Horizon being unreachable as retryable", async () => {
    vi.stubGlobal("fetch", routedFetch({}).fetch);
    const error = await new SdexProvider("testnet").quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MavnaError);
    expect((error as MavnaError).retryable).toBe(true);
  });
});
