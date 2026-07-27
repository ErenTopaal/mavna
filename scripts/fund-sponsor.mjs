/**
 * Create and fund the testnet account that pays for deliveries.
 *
 * The sponsor is an operational secret, so it is generated here rather than
 * written down anywhere: this appends it to `.env`, which is gitignored, and is
 * the only place it exists. On mainnet this script has no equivalent, because
 * mainnet funding is a treasury operation rather than a faucet call.
 *
 * Idempotent. Running it twice leaves the first account alone rather than
 * orphaning a funded one.
 *
 * Run: node scripts/fund-sponsor.mjs
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Resolved through the package that depends on it, not through this file.
 *
 * Node resolves an import from the importing FILE's location, and the Stellar
 * SDK is a dependency of `packages/stellar` rather than of the repository root.
 * A bare import here therefore fails no matter which directory the script is run
 * from, which is a confusing way to learn about module resolution. Asking the
 * package that owns the dependency avoids adding it to the root just for a
 * script.
 */
const require = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const { Keypair } = require("@stellar/stellar-sdk");

// Resolved from this file rather than from the working directory, because it is
// run from inside a package and `.env` lives at the root.
const ENV_PATH = new URL("../.env", import.meta.url).pathname;

const env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
if (/^SPONSOR_SECRET_KEY=S\w+/m.test(env)) {
  console.log("SPONSOR_SECRET_KEY is already set; leaving it alone.");
  process.exit(0);
}

const keypair = Keypair.random();
const response = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`, {
  signal: AbortSignal.timeout(30_000),
});
// 400 means Friendbot has already funded this address, which is a success here.
if (!response.ok && response.status !== 400) {
  console.error(`Friendbot refused: ${response.status}`);
  process.exit(1);
}

appendFileSync(
  ENV_PATH,
  `\n# Testnet delivery payer, funded by Friendbot. Development only, gitignored.\n` +
    `SPONSOR_SECRET_KEY=${keypair.secret()}\n`,
);

// The public key only. Printing the secret would put it in a shell history.
console.log(`funded sponsor: ${keypair.publicKey()}`);
