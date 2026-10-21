/**
 * The mainnet Arrival Contract: the lists it is to be built with, a read-only
 * check of every one of them against mainnet, and the commands that deploy it.
 *
 * What the constructor is given decides what the contract will ever trust, and
 * nothing can change it afterwards, so each entry is read from the ledger before
 * anyone signs:
 *
 *   1. the wasm to deploy hashes to the one the README records for the source,
 *   2. every token listed (each OFT's credited token, every wanted asset, every
 *      path token) is a Stellar asset contract, whose code is the network's own,
 *   3. each OFT's own storage names the credited token and the endpoint listed,
 *   4. the endpoint's own storage says it is LayerZero's Stellar endpoint 30600,
 *   5. the Aquarius router exists, and who can upgrade or pause it is printed,
 *   6. the router's own pools convert the arriving token into every wanted asset
 *      through listed tokens only, the way the SDK will quote it.
 *
 * With --contract=C..., the same lists are checked against a deployed instance:
 * its wasm and the configuration it was constructed with.
 *
 * Run (read-only, nothing is signed or sent):
 *   pnpm --filter @mavna/swap build
 *   node scripts/arrival-mainnet.mjs --wasm=<built wasm> [--source=<key name>] [--contract=C...]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const { Address, Networks, rpc, scValToNative, xdr } = require("@stellar/stellar-sdk");

/**
 * Read from mainnet on 2026-10-21. The OFT and its token are USDT0's: every EVM
 * USDT0 OFT LayerZero lists peers to this OFT, and its `Token` key is the asset
 * contract of USDT0:GATIS...HN6Q. The router is the one every Aquarius pool
 * trusts. Aquarius's own quoting routes USDT0 through Yield USDT
 * (CCOVLDJC...B6F6G), a custom token contract, which the contract must never
 * call, so it is not listed; the router's USDT0/USDC pool reaches USDC directly
 * and XLM through USDC.
 */
export const MAINNET_ARRIVAL = {
  wasmSha256: "468af775ca15d3c8acdffeccaeee9053c73f580831acff590f1d5d15e7f0db7b",
  endpoint: "CCQLLRE5JBAWYCW3KTWOIWLMFDUOKROQVZNSALQMGOSXNW3ERUOWTZGK",
  router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  /** (OFT, the token it credits) */
  ofts: [
    [
      "CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6",
      "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
    ],
  ],
  /** Circle's USDC, then native XLM */
  wanted: [
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  ],
  /** Circle's USDC, which XLM is reached through */
  pathTokens: ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],
};

const ENDPOINT_EID = 30600;
const DEFAULT_RPC = "https://soroban-rpc.mainnet.stellar.gateway.fm";

/** The constructor's arguments as the stellar CLI takes them after `--`. */
export function constructorArguments(lists) {
  return [
    "--endpoint",
    lists.endpoint,
    "--router",
    lists.router,
    "--ofts",
    JSON.stringify(lists.ofts.map(([oft, token]) => [oft, token])),
    "--wanted",
    JSON.stringify(lists.wanted),
    "--path_tokens",
    JSON.stringify(lists.pathTokens),
  ];
}

const quoted = (value) => (/^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value}'`);

/** The upload, then the deploy that constructs it. Both are signed by `source`. */
export function deployCommands({ wasm, source, rpcUrl }) {
  const network = `--source-account ${source} --rpc-url ${rpcUrl} --network-passphrase ${quoted(Networks.PUBLIC)}`;
  return [
    `stellar contract upload --wasm ${wasm} ${network}`,
    `stellar contract deploy --wasm ${wasm} ${network} -- ${constructorArguments(MAINNET_ARRIVAL).map(quoted).join(" ")}`,
  ];
}

let failed = false;
function check(ok, what, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail === "" ? "" : `: ${detail}`}`);
  if (!ok) failed = true;
}

async function instance(server, id) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const answer = await server.getLedgerEntries(key);
  const entry = answer.entries[0];
  if (entry === undefined) return undefined;
  const found = entry.val.contractData.val.instance;
  const storage = new Map();
  for (const item of found.storage ?? []) {
    const name = scValToNative(item.key);
    storage.set(Array.isArray(name) ? name.join(":") : String(name), scValToNative(item.val));
  }
  return { executable: found.executable, storage };
}

// the sdk's executable serialises as "stellar_asset" or { wasm: <hex> }
const executableOf = (found) =>
  found === undefined ? undefined : JSON.parse(JSON.stringify(found.executable));
const isAssetContract = (found) => executableOf(found) === "stellar_asset";
const wasmOf = (found) => executableOf(found)?.wasm;

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.join("=")];
    }),
  );
  const wasmPath = args.get("wasm");
  if (wasmPath === undefined || wasmPath === "") {
    console.error("usage: node scripts/arrival-mainnet.mjs --wasm=<built wasm> [--contract=C...]");
    process.exit(2);
  }
  const rpcUrl = args.get("rpc") || DEFAULT_RPC;
  const server = new rpc.Server(rpcUrl);
  const lists = MAINNET_ARRIVAL;

  const network = await server.getNetwork();
  check(network.passphrase === Networks.PUBLIC, `${rpcUrl} serves mainnet`, network.passphrase);

  console.log("\n== the wasm");
  const sha = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
  check(sha === lists.wasmSha256, "it is the source's recorded build", sha);

  console.log("\n== every listed token is a Stellar asset contract");
  const tokens = [
    ...new Set([...lists.ofts.map(([, t]) => t), ...lists.wanted, ...lists.pathTokens]),
  ];
  for (const token of tokens) {
    const found = await instance(server, token);
    const name = found?.storage.get("METADATA")?.name;
    check(isAssetContract(found), token, name ?? "not an asset contract");
  }

  console.log("\n== the OFTs and the endpoint");
  for (const [oft, token] of lists.ofts) {
    const found = await instance(server, oft);
    check(found !== undefined, `OFT ${oft} exists`);
    check(
      found?.storage.get("Token") === token,
      "its Token is the credited token",
      found?.storage.get("Token"),
    );
    check(
      found?.storage.get("Endpoint") === lists.endpoint,
      "its Endpoint is the listed endpoint",
      found?.storage.get("Endpoint"),
    );
    console.log(`    its Owner, who can reconfigure or upgrade it: ${found?.storage.get("Owner")}`);
  }
  const endpoint = await instance(server, lists.endpoint);
  check(
    Number(endpoint?.storage.get("Eid")) === ENDPOINT_EID,
    `endpoint reports ${ENDPOINT_EID}`,
    String(endpoint?.storage.get("Eid")),
  );

  console.log("\n== the Aquarius router");
  const router = await instance(server, lists.router);
  check(router !== undefined, `router ${lists.router} exists`, wasmOf(router));
  for (const role of [
    "Admin",
    "EmergencyAdmin",
    "OperationsAdmin",
    "PauseAdmin",
    "EmPauseAdmins",
    "SystemFeeAdmin",
    "Operator",
    "FutureWASM",
    "UpgradeDeadline",
  ]) {
    console.log(
      `    ${role}: ${JSON.stringify(router?.storage.get(role), (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))}`,
    );
  }
  check(
    router?.storage.get("FutureWASM") === undefined ||
      Buffer.from(router.storage.get("FutureWASM")).toString("hex") === wasmOf(router),
    "no router upgrade is staged",
  );

  console.log("\n== conversions the router can run through listed tokens");
  const { AquariusProvider } = await import("../packages/swap/dist/index.mjs");
  const aquarius = new AquariusProvider("mainnet", undefined, { rpcUrl, timeoutMs: 30_000 });
  for (const [, arriving] of lists.ofts) {
    for (const wanted of lists.wanted) {
      try {
        const quote = await aquarius.quotePath({
          assetIn: arriving,
          assetOut: wanted,
          // 100 of a seven-decimal token
          amountIn: "1000000000",
          maxSlippageBps: 20,
          via: lists.pathTokens,
        });
        check(
          true,
          `${arriving} into ${wanted}`,
          `${quote.path.length} hop(s), ${quote.amountOut} out for 1000000000 in`,
        );
      } catch (cause) {
        check(
          false,
          `${arriving} into ${wanted}`,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }
  }

  const contract = args.get("contract");
  if (contract !== undefined && contract !== "") {
    console.log(`\n== the deployed contract ${contract}`);
    const found = await instance(server, contract);
    check(wasmOf(found) === lists.wasmSha256, "it runs the recorded wasm", wasmOf(found));
    const config = found?.storage.get("Config");
    check(config?.endpoint === lists.endpoint, "endpoint", config?.endpoint);
    check(config?.router === lists.router, "router", config?.router);
    check(
      JSON.stringify(config?.ofts) === JSON.stringify(lists.ofts),
      "ofts",
      JSON.stringify(config?.ofts),
    );
    check(
      JSON.stringify(config?.wanted) === JSON.stringify(lists.wanted),
      "wanted",
      JSON.stringify(config?.wanted),
    );
    check(
      JSON.stringify(config?.path_tokens) === JSON.stringify(lists.pathTokens),
      "path_tokens",
      JSON.stringify(config?.path_tokens),
    );
  }

  console.log("\n== to deploy, signed by the deployer key");
  for (const command of deployCommands({
    wasm: wasmPath,
    source: args.get("source") || "<deployer key name>",
    rpcUrl,
  })) {
    console.log(`  ${command}`);
  }
  if (failed) {
    console.error("\nAt least one check failed. Do not deploy with these lists.");
    process.exit(1);
  }
  console.log("\nEvery check passed.");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
