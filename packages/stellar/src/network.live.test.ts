import { ADAPTER_QUOTE_TIMEOUT_MS } from "@mavna/core";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { PUBLIC_MAINNET_RPC_URLS } from "./network.js";

/**
 * Hits live Stellar mainnet, read only. The first public node is every mainnet
 * default (sponsor, widget, venues), and one quote makes several reads in a row
 * inside the route race's bound, so a node that takes seconds per read declines
 * every route that touches Stellar. On 2026-10-21 the node then first answered
 * in 3.7 to 8.8 s and the CCTP, Axelar and LayerZero quotes all ran out of time.
 */

// circle's cctp forwarder on mainnet: any live contract serves
const A_LIVE_CONTRACT = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";

async function timedRead(server: rpc.Server): Promise<number> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(A_LIVE_CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const started = performance.now();
  const answer = await server.getLedgerEntries(key);
  expect(answer.entries).toHaveLength(1);
  return performance.now() - started;
}

describe("the default mainnet node", () => {
  it("answers a ledger read well inside one route's time", async () => {
    const server = new rpc.Server(PUBLIC_MAINNET_RPC_URLS[0] ?? "");
    const times: number[] = [];
    for (let i = 0; i < 7; i++) times.push(await timedRead(server));
    times.sort((a, b) => a - b);
    const median = times[3] ?? Number.POSITIVE_INFINITY;
    // a quote reads several times in sequence, so one read gets a third of the bound
    expect(median).toBeLessThan(ADAPTER_QUOTE_TIMEOUT_MS / 3);
  }, 120_000);
});
