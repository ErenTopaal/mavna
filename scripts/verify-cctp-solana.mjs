/**
 * Check what `solana.ts` hardcodes against what Solana actually says.
 *
 * The Solana burn cannot be derived at runtime the way the EVM addresses are:
 * an Anchor instruction is a discriminator plus a positional account list, and
 * both live in the program's IDL rather than in any queryable mapping. So they
 * are written down once, and this re-derives them from the chain and fails if
 * they have moved.
 *
 * Four things are checked, on devnet and on mainnet:
 *   1. Both programs exist and are executable.
 *   2. The IDL's discriminator for `deposit_for_burn_with_hook` matches ours.
 *   3. The IDL's account order matches ours, name for name.
 *   4. The USDC mint we name is the one CCTP's own token minter calls local,
 *      and it reports six decimals.
 *
 * Run: node scripts/verify-cctp-solana.mjs
 */
import { inflateSync } from "node:zlib";
import { address, createAddressWithSeed, getProgramDerivedAddress } from "@solana/addresses";

const PROGRAMS = {
  messageTransmitterV2: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  tokenMessengerMinterV2: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
};

/** What `packages/adapters/cctp/src/solana.ts` claims. Kept in step by this script. */
const CLAIMED_DISCRIMINATOR = [111, 245, 62, 131, 204, 108, 223, 155];
const CLAIMED_ACCOUNT_ORDER = [
  "owner",
  "event_rent_payer",
  "sender_authority_pda",
  "burn_token_account",
  "denylist_account",
  "message_transmitter",
  "token_messenger",
  "remote_token_messenger",
  "token_minter",
  "local_token",
  "burn_token_mint",
  "message_sent_event_data",
  "message_transmitter_program",
  "token_messenger_minter_program",
  "token_program",
  "system_program",
  "event_authority",
  "program",
];
const CLAIMED_USDC = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const RPC = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

const failures = [];
const note = (ok, message) => {
  console.log(`  ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 160));
  return body.result;
}

/** Anchor publishes the IDL at a seeded account derived from the program itself. */
async function idlAddress(programId) {
  const [base] = await getProgramDerivedAddress({ programAddress: address(programId), seeds: [] });
  return createAddressWithSeed({
    baseAddress: base,
    seed: "anchor:idl",
    programAddress: address(programId),
  });
}

async function readIdl(url, programId) {
  const account = await rpc(url, "getAccountInfo", [
    await idlAddress(programId),
    { encoding: "base64" },
  ]);
  const raw = Buffer.from(account.value.data[0], "base64");
  // 8 bytes discriminator, 32 bytes authority, 4 bytes length, then deflate.
  const length = raw.readUInt32LE(40);
  return JSON.parse(inflateSync(raw.subarray(44, 44 + length)).toString("utf8"));
}

/** base58, for the memcmp filter that finds CCTP's LocalToken records. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const LOCAL_TOKEN_DISCRIMINATOR = Buffer.from([159, 131, 58, 170, 193, 84, 128, 182]);
const ADDRESS_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

for (const [network, url] of Object.entries(RPC)) {
  console.log(`\n== ${network}`);

  for (const [name, id] of Object.entries(PROGRAMS)) {
    const info = await rpc(url, "getAccountInfo", [id, { encoding: "base64" }]);
    note(Boolean(info?.value?.executable), `${name} is deployed and executable`);
  }

  const idl = await readIdl(url, PROGRAMS.tokenMessengerMinterV2);
  const instruction = idl.instructions.find((i) => i.name === "deposit_for_burn_with_hook");
  note(instruction !== undefined, "the IDL still has deposit_for_burn_with_hook");

  if (instruction !== undefined) {
    note(
      JSON.stringify(instruction.discriminator) === JSON.stringify(CLAIMED_DISCRIMINATOR),
      `discriminator matches (${instruction.discriminator})`,
    );
    const order = instruction.accounts.map((a) => a.name);
    note(
      JSON.stringify(order) === JSON.stringify(CLAIMED_ACCOUNT_ORDER),
      `account order matches, all ${order.length} of them`,
    );
    if (JSON.stringify(order) !== JSON.stringify(CLAIMED_ACCOUNT_ORDER)) {
      console.log("      chain says:", JSON.stringify(order));
    }
  }

  // The mint, taken from CCTP's own record rather than from a human.
  const locals = await rpc(url, "getProgramAccounts", [
    PROGRAMS.tokenMessengerMinterV2,
    {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0, bytes: base58(LOCAL_TOKEN_DISCRIMINATOR) } }],
    },
  ]);
  note(locals.length === 1, `exactly one local token is registered (found ${locals.length})`);

  if (locals.length === 1) {
    const data = Buffer.from(locals[0].account.data[0], "base64");
    // 8 discriminator, then custody (32), then mint (32).
    const mint = base58(data.subarray(40, 72));
    note(ADDRESS_ALPHABET.test(mint), "the mint decodes to a valid address");
    note(mint === CLAIMED_USDC[network], `USDC mint matches: ${mint}`);

    const parsed = await rpc(url, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    note(parsed?.value?.data?.parsed?.info?.decimals === 6, "the mint reports six decimals");
  }

  // The fixed PDAs, derived exactly as the adapter derives them.
  const utf8 = (t) => new TextEncoder().encode(t);
  const tmm = address(PROGRAMS.tokenMessengerMinterV2);
  const mt = address(PROGRAMS.messageTransmitterV2);
  const derived = {
    message_transmitter: await getProgramDerivedAddress({
      programAddress: mt,
      seeds: [utf8("message_transmitter")],
    }),
    token_messenger: await getProgramDerivedAddress({
      programAddress: tmm,
      seeds: [utf8("token_messenger")],
    }),
    token_minter: await getProgramDerivedAddress({
      programAddress: tmm,
      seeds: [utf8("token_minter")],
    }),
    // Keyed by the destination domain as decimal text. Stellar is 27, and this
    // account existing is proof Stellar is a registered remote.
    remote_token_messenger_stellar: await getProgramDerivedAddress({
      programAddress: tmm,
      seeds: [utf8("remote_token_messenger"), utf8("27")],
    }),
  };

  for (const [name, [derivedAddress]] of Object.entries(derived)) {
    const info = await rpc(url, "getAccountInfo", [derivedAddress, { encoding: "base64" }]);
    note(info?.value !== null && info?.value !== undefined, `${name} exists at ${derivedAddress}`);
  }
}

console.log(
  failures.length === 0
    ? "\n  Solana constants agree with both networks"
    : `\n  ${failures.length} check(s) failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
