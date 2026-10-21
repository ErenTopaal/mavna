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
 *   3. each OFT runs the code pinned here, credits the listed token (through its
 *      MintBurn manager's underlying asset contract, or its own Token when it
 *      locks and unlocks) and names the listed endpoint,
 *   4. nobody can claw back or freeze the credited token while arrivals wait:
 *      its asset contract's admin is that manager, the manager's clawback,
 *      blacklister and admin-manager roles have no members, and the issuer
 *      account can no longer sign,
 *   5. the endpoint's own storage says it is LayerZero's Stellar endpoint 30600,
 *   6. the Aquarius router exists, and who can upgrade or pause it is printed,
 *   7. the router's own pools convert the arriving token into every wanted asset
 *      through listed tokens only, the way the SDK will quote it.
 *
 * With --contract=C..., the same lists are checked against a deployed instance:
 * its wasm and the configuration it was constructed with.
 *
 * With --payer=G..., the upload is simulated from that funded account and its
 * resource fee printed, so the deployer knows what to hold.
 *
 * Run (read-only, nothing is signed or sent):
 *   pnpm --filter @mavna/swap build
 *   node scripts/arrival-mainnet.mjs --wasm=<built wasm> [--source=<key name>] [--payer=G...] [--contract=C...]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

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
  wasmSha256: "d8cc3923a6605ada3ad761f2f0545a15dc7b0715bbd4ce8a93caef6267acf9a6",
  endpoint: "CCQLLRE5JBAWYCW3KTWOIWLMFDUOKROQVZNSALQMGOSXNW3ERUOWTZGK",
  router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  /** (OFT, the token it credits) */
  ofts: [
    [
      "CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6",
      "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
    ],
  ],
  /**
   * The code each OFT runs, read from mainnet on 2026-10-21. USDT0's is an
   * Everdawn Labs build (`everdawn-oft`, soroban-sdk 25.1.1) whose source is not
   * public, so a change to it fails the check rather than passing unseen.
   */
  oftWasm: {
    CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6:
      "c1e1fce3259166b6bc17ff0085319bb7a312cb4d4ab1dded98e60ae32a43a7ca",
  },
  /**
   * Circle's USDC, then native XLM, each with the most USDT0 (seven decimals)
   * the contract converts into it in one arrival. A conversion the network's
   * budget cannot hold aborts where nothing can catch it, so these are set from
   * a mainnet fork (contracts/arrival/src/test/fork.rs, ledger 65065926): into
   * XLM, 50,000 used 83M of the 400M instructions, and 140M with a position at
   * every tick spacing the swap crossed; into USDC, 250,000 used 27M either way.
   */
  wanted: [
    ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", 250_000n * 10_000_000n],
    ["CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", 50_000n * 10_000_000n],
  ],
  /** Circle's USDC, which XLM is reached through */
  pathTokens: ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],
};

const ENDPOINT_EID = 30600;
const DEFAULT_RPC = "https://soroban-rpc.mainnet.stellar.gateway.fm";
const DEFAULT_HORIZON = "https://horizon.stellar.org";

/**
 * The SAC manager's roles that can take tokens from, or freeze, an account that
 * holds them (LayerZero's sac-manager: clawback, set_authorized), or hand the
 * asset contract to a new admin who could (set_admin). The Arrival Contract
 * holds every waiting arrival in one balance, so a member of any of these could
 * take or freeze other users' funds; none may have members at deployment.
 */
const TAKING_ROLES = ["CLAWBACK_ROLE", "BLACKLISTER_ROLE", "ADMIN_MANAGER_ROLE"];
const ALL_ROLES = ["MINTER_ROLE", ...TAKING_ROLES, "UPGRADER_ROLE"];

/** Why the manager's roles fail the check, or undefined when none can take funds. */
export function sacManagerRefusal(memberCounts) {
  const held = TAKING_ROLES.filter((role) => (memberCounts[role] ?? 0) > 0);
  return held.length === 0
    ? undefined
    : `${held.map((r) => `${r} has ${memberCounts[r]} member(s)`).join(", ")}`;
}

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
    JSON.stringify(lists.wanted.map(([asset, largest]) => [asset, largest.toString()])),
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

/** A read-only call, simulated from a throwaway source that never signs. */
async function call(server, contract, method, args = []) {
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const answer = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(answer)) {
    throw new Error(`${contract} ${method}: ${answer.error.split("\n")[0]}`);
  }
  return scValToNative(answer.result.retval);
}

const shown = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// the sdk's executable serialises as "stellar_asset" or { wasm: <hex> }
const executableOf = (found) =>
  found === undefined ? undefined : JSON.parse(JSON.stringify(found.executable));
const isAssetContract = (found) => executableOf(found) === "stellar_asset";
const wasmOf = (found) => executableOf(found)?.wasm;

/**
 * Who can take or freeze the credited token while arrivals wait in the
 * contract's one balance: the asset contract's admin, that manager's roles, and
 * the classic issuer, which can claw back directly if it can still sign.
 */
async function checkManager(server, horizonUrl, manager, token) {
  const admin = await call(server, token, "admin").catch(() => undefined);
  check(admin === manager, "the token's asset contract admin is that manager", admin);
  const owner = await call(server, manager, "owner").catch(() => undefined);
  console.log(`    the manager's owner, who can grant its roles at any time: ${shown(owner)}`);
  const existing = await call(server, manager, "get_existing_roles").catch(() => []);
  console.log(`    its roles in use: ${shown(existing)}`);
  const counts = {};
  for (const role of new Set([...ALL_ROLES, ...existing])) {
    counts[role] = Number(
      await call(server, manager, "get_role_member_count", [
        nativeToScVal(role, { type: "symbol" }),
      ]),
    );
    const members = [];
    for (let i = 0; i < counts[role]; i++) {
      members.push(
        await call(server, manager, "get_role_member", [
          nativeToScVal(role, { type: "symbol" }),
          nativeToScVal(i, { type: "u32" }),
        ]),
      );
    }
    console.log(`    ${role}: ${counts[role]} ${shown(members)}`);
  }
  const refusal = sacManagerRefusal(counts);
  check(refusal === undefined, "nobody holds a role that can claw back or freeze it", refusal);

  const name = (await instance(server, token))?.storage.get("METADATA")?.name ?? "";
  const issuer = String(name).split(":")[1];
  const response = await fetch(`${horizonUrl}/accounts/${issuer}`);
  const account = response.ok ? await response.json() : undefined;
  console.log(
    `    issuer ${issuer} flags: ${shown(account?.flags)}, signers: ${shown(
      account?.signers?.map((x) => [x.key, x.weight]),
    )}`,
  );
  check(
    account !== undefined && account.signers.every((signer) => signer.weight === 0),
    "the issuer account can no longer sign, so it cannot claw back around the manager",
  );
}

/** The upload's resource fee, simulated from a funded account. */
async function uploadFee(server, payer, wasm) {
  const source = await server.getAccount(payer);
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(60)
    .build();
  const answer = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(answer)) throw new Error(answer.error.split("\n")[0]);
  return BigInt(answer.minResourceFee);
}

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
  const horizonUrl = args.get("horizon") || DEFAULT_HORIZON;
  const server = new rpc.Server(rpcUrl);
  const lists = MAINNET_ARRIVAL;

  const network = await server.getNetwork();
  check(network.passphrase === Networks.PUBLIC, `${rpcUrl} serves mainnet`, network.passphrase);

  console.log("\n== the wasm");
  const sha = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
  check(sha === lists.wasmSha256, "it is the source's recorded build", sha);

  console.log("\n== every listed token is a Stellar asset contract");
  const tokens = [
    ...new Set([
      ...lists.ofts.map(([, t]) => t),
      ...lists.wanted.map(([asset]) => asset),
      ...lists.pathTokens,
    ]),
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
    check(wasmOf(found) === lists.oftWasm[oft], "it runs the pinned code", wasmOf(found));
    check(
      found?.storage.get("Endpoint") === lists.endpoint,
      "its Endpoint is the listed endpoint",
      found?.storage.get("Endpoint"),
    );
    console.log(`    its Owner, who can reconfigure or upgrade it: ${found?.storage.get("Owner")}`);
    // what lz_receive credits: a MintBurn OFT mints through its manager's asset
    // contract, a LockUnlock one pays out its own Token
    const kind = await call(server, oft, "oft_type").catch((e) => ["unreadable", e.message]);
    console.log(`    oft_type: ${shown(kind)}`);
    if (Array.isArray(kind) && kind[0] === "MintBurn") {
      const manager = kind[1];
      const credited = await call(server, manager, "underlying_sac").catch(() => undefined);
      check(credited === token, "its MintBurn manager mints the credited token", credited);
      await checkManager(server, horizonUrl, manager, token);
    } else if (Array.isArray(kind) && kind[0] === "LockUnlock") {
      check(
        found?.storage.get("Token") === token,
        "its Token is the credited token",
        found?.storage.get("Token"),
      );
    } else {
      check(false, "its OFT type is MintBurn or LockUnlock", shown(kind));
    }
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
  const { COMPOSE_MAX_ESTIMATE_INSTRUCTIONS } = await import(
    "../packages/adapters/layerzero/dist/index.mjs"
  );
  for (const [, arriving] of lists.ofts) {
    for (const [wanted, largest] of lists.wanted) {
      // 100 of a seven-decimal token, then the most the contract converts, which
      // the SDK must still be able to quote within its share of the budget
      for (const amountIn of ["1000000000", largest.toString()]) {
        try {
          const quote = await aquarius.quotePath({
            assetIn: arriving,
            assetOut: wanted,
            amountIn,
            maxSlippageBps: 20,
            via: lists.pathTokens,
            maxEstimateInstructions: COMPOSE_MAX_ESTIMATE_INSTRUCTIONS,
          });
          check(
            true,
            `${arriving} into ${wanted}`,
            `${quote.path.length} hop(s), ${quote.amountOut} out for ${amountIn} in, estimates ${quote.estimateInstructions} of ${COMPOSE_MAX_ESTIMATE_INSTRUCTIONS} instructions`,
          );
        } catch (cause) {
          check(
            false,
            `${arriving} into ${wanted}, ${amountIn} in`,
            cause instanceof Error ? cause.message : String(cause),
          );
        }
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
    check(shown(config?.wanted) === shown(lists.wanted), "wanted", shown(config?.wanted));
    check(
      JSON.stringify(config?.path_tokens) === JSON.stringify(lists.pathTokens),
      "path_tokens",
      JSON.stringify(config?.path_tokens),
    );
  }

  const payer = args.get("payer");
  if (payer !== undefined && payer !== "") {
    const fee = await uploadFee(server, payer, readFileSync(wasmPath));
    console.log(
      `\n== the upload's resource fee, simulated now from ${payer}: ${Number(fee) / 1e7} XLM`,
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
