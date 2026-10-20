import { describe, expect, it } from "vitest";
import type { EngineConfig } from "./engine";
import { engineKeyOf } from "./engine-key";

const base: EngineConfig = {
  network: "testnet",
  rpcUrl: "https://rpc.example",
  sponsorUrl: "https://sponsor.example",
  disabledSources: undefined,
  ranking: "best-received",
  integratorFee: undefined,
  historyKey: "mavna.transfers.v1.testnet",
};
const signer = () => ({
  connect: async () => "G",
  sign: async (x: string) => x,
  disconnect: async () => {},
});

describe("engineKeyOf", () => {
  it("changes with every config field the engine is built from", () => {
    const key = engineKeyOf(base);
    expect(engineKeyOf({ ...base, rails: ["Circle"] })).not.toBe(key);
    expect(engineKeyOf({ ...base, chains: { deny: ["base-sepolia"] } })).not.toBe(key);
    expect(engineKeyOf({ ...base, historyKey: "acme:mavna.transfers.v1.testnet" })).not.toBe(key);
    expect(engineKeyOf({ ...base, stellar: signer() })).not.toBe(key);
  });

  it("stays the same for the same config, and the same signer", () => {
    const own = signer();
    expect(engineKeyOf({ ...base })).toBe(engineKeyOf(base));
    expect(engineKeyOf({ ...base, stellar: own })).toBe(engineKeyOf({ ...base, stellar: own }));
    expect(engineKeyOf({ ...base, stellar: own })).not.toBe(
      engineKeyOf({ ...base, stellar: signer() }),
    );
  });
});
