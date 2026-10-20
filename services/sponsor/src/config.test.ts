import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS } from "./caps.js";
import { readSponsorConfig } from "./config.js";

const SECRET = Keypair.random().secret();
const base = { SPONSOR_SECRET_KEY: SECRET };
const durable = { MAVNA_STATE_DIR: "/var/lib/mavna" };

describe("the sponsor's configuration, read from the environment", () => {
  it("runs on testnet against the public node when nothing else is said", () => {
    const config = readSponsorConfig(base);
    expect(config.networkId).toBe("testnet");
    expect(config.rpcUrl).toBe(PUBLIC_TESTNET_RPC_URL);
    expect(config.reserveFunding).toBe("sponsor");
    expect(config.caps).toEqual(DEFAULT_CAPS);
    expect(config.minDeliveryBaseUnits).toBe(1_000_000n);
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.trustProxy).toBe(false);
    expect(config.stateDir).toBeUndefined();
    expect(config.port).toBe(8787);
    expect(config.provisionalSettlements).toBe(16);
    expect(config.channelFloor).toBe(4);
    expect(config.settlementsPerClient).toBe(2);
    expect(config.deliveryBudgetStroops).toBe(250_000_000n);
  });

  it("reads the daily delivery budget in XLM, to the stroop", () => {
    expect(
      readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: "2.5" }).deliveryBudgetStroops,
    ).toBe(25_000_000n);
    expect(
      readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: "0" }).deliveryBudgetStroops,
    ).toBe(0n);
    for (const bad of ["-1", "1.12345678", "lots"]) {
      expect(() => readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: bad })).toThrow(
        /MAVNA_DELIVERY_BUDGET_XLM/,
      );
    }
  });

  it("reads the unbacked settlements allowed at once and the share one client may hold", () => {
    const config = readSponsorConfig({
      ...base,
      MAVNA_PROVISIONAL_SETTLEMENTS: "10",
      MAVNA_SETTLEMENTS_PER_CLIENT: "0",
    });
    expect(config.provisionalSettlements).toBe(10);
    expect(config.settlementsPerClient).toBe(0);
    expect(() => readSponsorConfig({ ...base, MAVNA_PROVISIONAL_SETTLEMENTS: "0" })).toThrow(
      /MAVNA_PROVISIONAL_SETTLEMENTS/,
    );
  });

  it("reads how many idle channels the sponsor keeps", () => {
    expect(readSponsorConfig({ ...base, MAVNA_CHANNEL_FLOOR: "0" }).channelFloor).toBe(0);
    expect(() => readSponsorConfig({ ...base, MAVNA_CHANNEL_FLOOR: "some" })).toThrow(
      /MAVNA_CHANNEL_FLOOR/,
    );
  });

  it("says the pool size setting is gone rather than silently ignoring it", () => {
    expect(readSponsorConfig({ ...base, MAVNA_CHANNEL_POOL_SIZE: "4" }).warnings).toEqual([
      expect.stringMatching(/MAVNA_CHANNEL_POOL_SIZE is no longer read/),
    ]);
    // empty, as docker compose forwards an unset one, is still fine
    expect(readSponsorConfig({ ...base, MAVNA_CHANNEL_POOL_SIZE: "" }).provisionalSettlements).toBe(
      16,
    );
  });

  it("reads the daily delivery budget in XLM, to the stroop", () => {
    expect(
      readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: "2.5" }).deliveryBudgetStroops,
    ).toBe(25_000_000n);
    expect(
      readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: "0" }).deliveryBudgetStroops,
    ).toBe(0n);
    for (const bad of ["-1", "1.12345678", "lots"]) {
      expect(() => readSponsorConfig({ ...base, MAVNA_DELIVERY_BUDGET_XLM: bad })).toThrow(
        /MAVNA_DELIVERY_BUDGET_XLM/,
      );
    }
  });

  it("runs mainnet against the first public mainnet node by default", () => {
    const config = readSponsorConfig({ ...base, ...durable, MAVNA_NETWORK: "mainnet" });
    expect(config.rpcUrl).toBe(PUBLIC_MAINNET_RPC_URLS[0]);
    expect(config.irisUrl).toBe("https://iris-api.circle.com");
  });

  it("takes the operator's node over the public one", () => {
    const config = readSponsorConfig({
      ...base,
      ...durable,
      MAVNA_NETWORK: "mainnet",
      STELLAR_RPC_URL: "https://rpc.example",
    });
    expect(config.rpcUrl).toBe("https://rpc.example");
  });

  it("reads an empty value as unset, the way docker compose forwards one", () => {
    expect(readSponsorConfig({ ...base, STELLAR_RPC_URL: "" }).rpcUrl).toBe(PUBLIC_TESTNET_RPC_URL);
  });

  it("refuses a network it does not know rather than quietly choosing testnet", () => {
    expect(() => readSponsorConfig({ ...base, MAVNA_NETWORK: "Mainnet" })).toThrow(/MAVNA_NETWORK/);
  });

  it("refuses to start without the secret", () => {
    expect(() => readSponsorConfig({})).toThrow(/SPONSOR_SECRET_KEY/);
  });

  it("refuses a secret that is not a Stellar secret key", () => {
    expect(() => readSponsorConfig({ SPONSOR_SECRET_KEY: "nope" })).toThrow(/SPONSOR_SECRET_KEY/);
  });

  it("reads the reserve funding switch, and refuses anything but its two values", () => {
    expect(readSponsorConfig({ ...base, MAVNA_RESERVE_FUNDING: "self" }).reserveFunding).toBe(
      "self",
    );
    expect(readSponsorConfig({ ...base, MAVNA_RESERVE_FUNDING: "sponsor" }).reserveFunding).toBe(
      "sponsor",
    );
    expect(() => readSponsorConfig({ ...base, MAVNA_RESERVE_FUNDING: "user" })).toThrow(
      /MAVNA_RESERVE_FUNDING/,
    );
  });

  it("reads each daily cap on its own", () => {
    const config = readSponsorConfig({
      ...base,
      MAVNA_CAP_STRANDING_PER_DAY: "10",
      MAVNA_CAP_VOLUME_CHEAP_PER_DAY: "20",
    });
    expect(config.caps).toEqual({
      strandingCapPerDay: 10,
      volumeCapPerDay: {
        "expensive-gas": DEFAULT_CAPS.volumeCapPerDay["expensive-gas"],
        "cheap-gas": 20,
      },
    });
  });

  it("refuses a cap that is not a whole number", () => {
    expect(() => readSponsorConfig({ ...base, MAVNA_CAP_VOLUME_EXPENSIVE_PER_DAY: "1.5" })).toThrow(
      /MAVNA_CAP_VOLUME_EXPENSIVE_PER_DAY/,
    );
  });

  it("reads the minimum delivery in USDC, to Circle's six decimals", () => {
    expect(
      readSponsorConfig({ ...base, MAVNA_MIN_DELIVERY_USDC: "0.25" }).minDeliveryBaseUnits,
    ).toBe(250_000n);
    expect(readSponsorConfig({ ...base, MAVNA_MIN_DELIVERY_USDC: "0" }).minDeliveryBaseUnits).toBe(
      0n,
    );
    expect(() => readSponsorConfig({ ...base, MAVNA_MIN_DELIVERY_USDC: "0.0000001" })).toThrow(
      /MAVNA_MIN_DELIVERY_USDC/,
    );
    expect(() => readSponsorConfig({ ...base, MAVNA_MIN_DELIVERY_USDC: "-1" })).toThrow(
      /MAVNA_MIN_DELIVERY_USDC/,
    );
  });

  it("reads the request limit and whether to believe the proxy", () => {
    const config = readSponsorConfig({
      ...base,
      MAVNA_RATE_LIMIT_PER_MINUTE: "0",
      MAVNA_TRUST_PROXY: "true",
    });
    expect(config.rateLimitPerMinute).toBe(0);
    expect(config.trustProxy).toBe(true);
    expect(() => readSponsorConfig({ ...base, MAVNA_TRUST_PROXY: "yes" })).toThrow(
      /MAVNA_TRUST_PROXY/,
    );
  });

  it("reads the state directory", () => {
    expect(readSponsorConfig({ ...base, MAVNA_STATE_DIR: "/var/lib/mavna" }).stateDir).toBe(
      "/var/lib/mavna",
    );
  });

  it("refuses to run in production with its state in memory", () => {
    // a restart would drop held settlements, channel keys and the day's caps
    expect(() => readSponsorConfig({ ...base, MAVNA_NETWORK: "mainnet" })).toThrow(
      /MAVNA_STATE_DIR/,
    );
    expect(() => readSponsorConfig({ ...base, MAVNA_PRODUCTION: "true" })).toThrow(
      /MAVNA_STATE_DIR/,
    );
    expect(readSponsorConfig({ ...base, ...durable, MAVNA_PRODUCTION: "true" }).production).toBe(
      true,
    );
    // a testnet trial keeps running from memory, as before
    expect(readSponsorConfig(base).production).toBe(false);
  });

  it("refuses a production flag that is not true or false", () => {
    expect(() => readSponsorConfig({ ...base, MAVNA_PRODUCTION: "yes" })).toThrow(
      /MAVNA_PRODUCTION/,
    );
  });

  it("refuses a sweep interval that is not whole seconds", () => {
    expect(readSponsorConfig({ ...base, MAVNA_SETTLE_SWEEP_SECONDS: "0" }).settleSweepSeconds).toBe(
      0,
    );
    expect(() => readSponsorConfig({ ...base, MAVNA_SETTLE_SWEEP_SECONDS: "1m" })).toThrow(
      /MAVNA_SETTLE_SWEEP_SECONDS/,
    );
  });

  it("splits the allowed origins", () => {
    expect(
      readSponsorConfig({ ...base, MAVNA_ALLOWED_ORIGINS: "https://a.example, https://b.example" })
        .allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });
});
