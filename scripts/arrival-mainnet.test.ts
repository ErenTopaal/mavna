import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  constructorArguments,
  deployCommands,
  MAINNET_ARRIVAL,
  sacManagerRefusal,
} from "./arrival-mainnet.mjs";

const require = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const { Asset, Networks } =
  require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");

const source = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sac = (asset: InstanceType<typeof Asset>): string => asset.contractId(Networks.PUBLIC);

describe("the mainnet Arrival Contract lists", () => {
  it("name only the asset contracts of the classic assets they mean", () => {
    const usdc = sac(new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"));
    const xlm = sac(Asset.native());
    const usdt0 = sac(
      new Asset("USDT0", "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q"),
    );
    expect(MAINNET_ARRIVAL.ofts.map(([, token]) => token)).toEqual([usdt0]);
    expect(MAINNET_ARRIVAL.wanted.map(([asset]) => asset)).toEqual([usdc, xlm]);
    // aquarius's router has no usdt0 pool but usdc, so xlm is reached through usdc
    expect(MAINNET_ARRIVAL.pathTokens).toEqual([usdc]);
  });

  it("agree with the addresses the rest of the code uses on mainnet", () => {
    expect(source("packages/swap/src/aquarius.ts")).toContain(
      `mainnet: "${MAINNET_ARRIVAL.router}"`,
    );
    expect(source("packages/adapters/cctp/src/config.ts")).toContain(
      `usdcContract: "${MAINNET_ARRIVAL.wanted[0]?.[0]}"`,
    );
    expect(source("contracts/arrival/README.md")).toContain(MAINNET_ARRIVAL.ofts[0]?.[0]);
    expect(source("contracts/arrival/README.md")).toContain(MAINNET_ARRIVAL.wasmSha256);
  });

  it("convert at most what a mainnet fork measured to fit the network's budget", () => {
    // contracts/arrival/src/test/fork.rs runs these against mainnet's own pools
    const fork = source("contracts/arrival/src/test/fork.rs");
    const [usdc, xlm] = MAINNET_ARRIVAL.wanted;
    expect(usdc?.[1]).toBe(250_000n * 10_000_000n);
    expect(xlm?.[1]).toBe(50_000n * 10_000_000n);
    expect(fork).toContain("const LARGEST_INTO_XLM: i128 = 50_000 * 10_000_000;");
    expect(fork).toContain("const LARGEST_INTO_USDC: i128 = 250_000 * 10_000_000;");
  });

  it("pin the code the OFT runs", () => {
    const [oft] = MAINNET_ARRIVAL.ofts[0] ?? [];
    expect(MAINNET_ARRIVAL.oftWasm[oft ?? ""]).toBe(
      "c1e1fce3259166b6bc17ff0085319bb7a312cb4d4ab1dded98e60ae32a43a7ca",
    );
  });

  it("meet what the constructor refuses", () => {
    expect(MAINNET_ARRIVAL.ofts.length).toBeGreaterThan(0);
    expect(MAINNET_ARRIVAL.wanted.length).toBeGreaterThan(0);
    for (const [, largest] of MAINNET_ARRIVAL.wanted) expect(largest > 0n).toBe(true);
    const wanted = MAINNET_ARRIVAL.wanted.map(([asset]) => asset);
    expect(new Set(wanted).size).toBe(wanted.length);
    const ofts = MAINNET_ARRIVAL.ofts.map(([oft]) => oft);
    expect(new Set(ofts).size).toBe(ofts.length);
  });
});

describe("the deploy command", () => {
  it("passes the constructor's parameters by name, in its order", () => {
    const lib = source("contracts/arrival/src/lib.rs");
    const signature = /pub fn __constructor\((.*?)\)\s*\{/s.exec(lib)?.[1] ?? "";
    // a parameter's type can hold commas of its own, so names are read as `name:`
    const params = [...signature.matchAll(/(\w+)\s*:/g)]
      .map((m) => m[1])
      .filter((p): p is string => p !== undefined && p !== "env");
    const flags = constructorArguments(MAINNET_ARRIVAL)
      .filter((a) => a.startsWith("--"))
      .map((a) => a.slice(2));
    expect(flags).toEqual(params);
  });

  it("writes each wanted asset with its limit as a string the CLI reads as i128", () => {
    const args = constructorArguments(MAINNET_ARRIVAL);
    const wanted = JSON.parse(args[args.indexOf("--wanted") + 1] ?? "") as unknown;
    expect(wanted).toEqual(
      MAINNET_ARRIVAL.wanted.map(([asset, largest]) => [asset, largest.toString()]),
    );
  });

  it("writes each (oft, token) pair as a two-item array", () => {
    const args = constructorArguments(MAINNET_ARRIVAL);
    const ofts = JSON.parse(args[args.indexOf("--ofts") + 1] ?? "") as unknown;
    expect(ofts).toEqual(MAINNET_ARRIVAL.ofts.map(([oft, token]) => [oft, token]));
  });

  it("uploads then deploys on mainnet through the given node and key", () => {
    const [upload, deploy] = deployCommands({
      wasm: "mavna_arrival.wasm",
      source: "mavna-deployer",
      rpcUrl: "https://rpc.example",
    });
    for (const command of [upload, deploy]) {
      expect(command).toContain("--source-account mavna-deployer");
      expect(command).toContain("--rpc-url https://rpc.example");
      expect(command).toContain(`--network-passphrase '${Networks.PUBLIC}'`);
    }
    expect(upload).toMatch(/^stellar contract upload --wasm mavna_arrival\.wasm /);
    expect(deploy).toMatch(/^stellar contract deploy --wasm mavna_arrival\.wasm /);
    expect(deploy).toContain(` -- ${constructorArguments(MAINNET_ARRIVAL)[0]} `);
  });
});

describe("the asset contract manager's roles", () => {
  it("refuses any member who could claw back, freeze or hand over the token", () => {
    const counts = (over: Record<string, number>) => ({
      MINTER_ROLE: 1,
      CLAWBACK_ROLE: 0,
      BLACKLISTER_ROLE: 0,
      ADMIN_MANAGER_ROLE: 0,
      ...over,
    });
    expect(sacManagerRefusal(counts({}))).toBeUndefined();
    expect(sacManagerRefusal(counts({ CLAWBACK_ROLE: 1 }))).toMatch(/CLAWBACK_ROLE/);
    expect(sacManagerRefusal(counts({ BLACKLISTER_ROLE: 2 }))).toMatch(/BLACKLISTER_ROLE/);
    expect(sacManagerRefusal(counts({ ADMIN_MANAGER_ROLE: 1 }))).toMatch(/ADMIN_MANAGER_ROLE/);
  });
});
