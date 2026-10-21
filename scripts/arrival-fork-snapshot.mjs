/**
 * Writes contracts/arrival/testdata/mainnet-fork.txt: every mainnet ledger entry
 * the Arrival Contract's conversions read through Aquarius, so the contract's
 * budget tests run the real router and pools, as wasm, against mainnet's state.
 *
 * The entries are the footprints of simulated swaps (USDT0 into USDC, and into
 * XLM through USDC) of `--amount` USDT0, plus a position deposit into each pool,
 * plus the accounts the tests pay from. A swap larger than `--amount` would
 * touch ticks this file does not hold, so tests must stay below it. The default,
 * 900,000 USDT0, is about the largest swap into XLM the network will still
 * simulate within its budget today.
 *
 * Read-only: nothing is signed or sent.
 *   node scripts/arrival-fork-snapshot.mjs [--amount=<USDT0 base units>] [--rpc=<url>]
 *
 * Each line after the header is `<LedgerKey> <LedgerEntry> <live until ledger>`,
 * base64 XDR.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";
const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
/** The pools the SDK picks for USDT0 into USDC, and USDC into XLM. */
const USDT0_USDC = "CCJHUCHZ2DC6MP7LMGQJYSENNTGIFWU4J4TCGFYYDLAC5LTD4YMF6HSQ";
const USDC_XLM = "CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV";
/** Large holders whose balances the simulations spend from. */
const USDT0_HOLDER = "GAQZU7Y7GB3E4XOA3ZXEZDOTIEIWQRYOAIVJ6STY2YTUQAGZL3GYJCXG";
const USDC_XLM_HOLDER = "GBAIA5U6E3FSRUW55AXACIVGX2QR5JYAS74OWLED3S22EGXVYEHPLGPA";
const ISSUERS = [
  "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const rpcUrl = args.get("rpc") || "https://soroban-rpc.mainnet.stellar.gateway.fm";
const amount = BigInt(args.get("amount") || "9000000000000");
const out =
  args.get("out") ||
  fileURLToPath(new URL("../contracts/arrival/testdata/mainnet-fork.txt", import.meta.url));
const server = new rpc.Server(rpcUrl);

async function call(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function simulate(contract, method, callArgs) {
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(contract).call(method, ...callArgs))
    .setTimeout(30)
    .build();
  const answer = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(answer)) {
    throw new Error(`${contract} ${method}: ${answer.error.split("\n")[0]}`);
  }
  return answer;
}

const vec = (tokens) => xdr.ScVal.scvVec(tokens.map((t) => new Address(t).toScVal()));
const u128 = (n) => nativeToScVal(BigInt(n), { type: "u128" });
const i32 = (n) => nativeToScVal(n, { type: "i32" });
const byAddress = (a, b) => {
  const x = new Address(a).toScAddress().toXdr();
  const y = new Address(b).toScAddress().toXdr();
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

async function hop(from, to, pool) {
  const tokens = [from, to].sort(byAddress);
  const answer = await simulate(ROUTER, "get_pools", [vec(tokens)]);
  for (const entry of answer.result.retval.map) {
    if (Address.fromScVal(entry.val).toString() === pool) {
      return xdr.ScVal.scvVec([vec(tokens), entry.key, new Address(to).toScVal()]);
    }
  }
  throw new Error(`the router does not list ${pool} for ${from} and ${to}`);
}

const keys = new Set();
function footprint(label, answer) {
  const { readOnly, readWrite } = answer.transactionData.build().resources.footprint;
  for (const key of [...readOnly, ...readWrite]) keys.add(key.toXdr("base64"));
  console.log(`${label}: ${readOnly.length + readWrite.length} entries`);
}
function accountKey(g) {
  const raw = StrKey.decodeEd25519PublicKey(g);
  return Buffer.concat([Buffer.alloc(8), raw]).toString("base64");
}

const toUsdc = await hop(USDT0, USDC, USDT0_USDC);
const toXlm = await hop(USDC, XLM, USDC_XLM);
const holder = new Address(USDT0_HOLDER).toScVal();
footprint(
  "USDT0 into XLM",
  await simulate(ROUTER, "swap_chained", [
    holder,
    xdr.ScVal.scvVec([toUsdc, toXlm]),
    new Address(USDT0).toScVal(),
    u128(amount),
    u128(1),
  ]),
);
footprint(
  "USDT0 into USDC",
  await simulate(ROUTER, "swap_chained", [
    holder,
    xdr.ScVal.scvVec([toUsdc]),
    new Address(USDT0).toScVal(),
    u128(amount),
    u128(1),
  ]),
);
// a position on the side of each pool a conversion crosses: below the price in
// USDT0/USDC (selling USDT0 lowers it), above it in XLM/USDC (buying XLM raises it)
const lp = new Address(USDC_XLM_HOLDER).toScVal();
const tick = async (pool) => Number(scValToNative((await simulate(pool, "get_slot0", [])).result.retval).tick);
const below = Math.floor((await tick(USDT0_USDC)) / 20) * 20 - 20;
const above = Math.ceil((await tick(USDC_XLM)) / 20) * 20 + 20;
footprint(
  "a USDC position in USDT0/USDC",
  await simulate(USDT0_USDC, "deposit_position", [
    lp,
    i32(below - 20),
    i32(below),
    xdr.ScVal.scvVec([u128(0), u128(10_000_000)]),
    u128(0),
  ]),
);
footprint(
  "an XLM position in XLM/USDC",
  await simulate(USDC_XLM, "deposit_position", [
    lp,
    i32(above),
    i32(above + 20),
    xdr.ScVal.scvVec([u128(10_000_000), u128(0)]),
    u128(0),
  ]),
);
for (const g of [...ISSUERS, USDT0_HOLDER, USDC_XLM_HOLDER]) keys.add(accountKey(g));

const all = [...keys];
const lines = [];
let ledger = 0;
for (let i = 0; i < all.length; i += 100) {
  const answer = await call("getLedgerEntries", { keys: all.slice(i, i + 100) });
  ledger = answer.latestLedger;
  for (const e of answer.entries ?? []) {
    // a LedgerEntry is its last-modified ledger, its data, and an empty extension
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(e.lastModifiedLedgerSeq ?? 0);
    const entry = Buffer.concat([seq, Buffer.from(e.xdr, "base64"), Buffer.alloc(4)]);
    lines.push(`${e.key} ${entry.toString("base64")} ${e.liveUntilLedgerSeq ?? ""}`.trimEnd());
  }
}
const closed = (await call("getLedgers", { startLedger: ledger, pagination: { limit: 1 } }))
  .ledgers[0];
const network = await call("getVersionInfo", {});
writeFileSync(
  out,
  `ledger ${ledger} closed ${closed.ledgerCloseTime} protocol ${network.protocolVersion} amount ${amount}\n${lines.join("\n")}\n`,
);
console.log(`${lines.length} of ${all.length} entries at ledger ${ledger} written to ${out}`);
