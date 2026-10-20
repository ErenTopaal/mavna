/**
 * Pin Axelar's deployment configuration to one commit and check its addresses
 * against the chains before the adapter trusts them.
 *
 * The adapter reads Axelar's published configuration for chain names, nodes and
 * contract addresses. Read from the main branch, one bad commit to that repo
 * (or a compromised CDN) would hand the adapter both the contract a user
 * approves and the node that vouches for it. So the adapter reads the file at
 * the commit pinned here, and only accepts the token service and gas service
 * addresses written into pinned.ts by this script, after each was confirmed on
 * its own chain:
 *
 *   1. the node answers eth_chainId with the chain id the config gives,
 *   2. there is code at the token service address,
 *   3. the token service's own gasService() is the gas service the config names,
 *   4. there is code at that gas service,
 *   5. on Stellar, the token service contract instance exists on the ledger.
 *
 * When the config's node cannot be reached from where this runs, the public
 * nodes the community chain registry lists for the same chain id are tried, so
 * an unreachable host is not mistaken for a missing deployment. A chain that
 * cannot be confirmed is left out of pinned.ts, and the adapter does not offer it.
 *
 * Run from the repository root:
 *   node scripts/verify-axelar-deployments.mjs                 (latest commit on main)
 *   node scripts/verify-axelar-deployments.mjs --commit=<sha>
 * Read-only. Nothing is signed or sent.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/adapters/axelar/package.json", import.meta.url));
const { Address, rpc, xdr } = require("@stellar/stellar-sdk");

const REPO = "axelarnetwork/axelar-contract-deployments";
const STELLAR_RPC = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};
const GAS_SERVICE_SELECTOR = "0x6a22d8cc"; // gasService()
const TIMEOUT = 15_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commitArg = process.argv.find((a) => a.startsWith("--commit="))?.slice("--commit=".length);
const commit = commitArg ?? (await latestCommit());
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit hash: ${commit}`);
console.log(`  pinning ${REPO} at ${commit}`);

async function latestCommit() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for main`);
  return (await response.json()).sha;
}

async function config(network) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/axelar-chains-config/info/${network}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return (await response.json()).chains;
}

/**
 * One JSON-RPC call, retried when the node is busy rather than recorded as an
 * answer. A rate limit is not evidence about a contract.
 */
async function call(url, method, params) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (response.status === 429 || response.status === 403 || response.status >= 500) {
        last = new Error(`HTTP ${response.status}`);
        await wait(600 * 2 ** attempt);
        continue;
      }
      const body = await response.json();
      if (body.error) {
        const message = String(body.error.message ?? method);
        if (/limit|quota|rate|too many|busy/i.test(message)) {
          last = new Error(message);
          await wait(600 * 2 ** attempt);
          continue;
        }
        throw new Error(message);
      }
      return body.result;
    } catch (error) {
      last = error;
      if (attempt < 3) await wait(400 * 2 ** attempt);
    }
  }
  throw last;
}

/**
 * Public alternates for a chain id, from the community registry, for when the
 * config's own node cannot be reached from where this runs. Only plain https
 * URLs: anything templated needs a key this script does not have.
 */
const registry = await fetch("https://chainid.network/chains.json", {
  signal: AbortSignal.timeout(30_000),
})
  .then((r) => r.json())
  .then((all) => new Map(all.map((c) => [c.chainId, c])));

function alternates(chainId) {
  return (registry.get(chainId)?.rpc ?? []).filter(
    (url) => url.startsWith("https://") && !url.includes("${"),
  );
}

/**
 * The first node that answers as this chain. An unreachable node says nothing
 * about the chain and the next one is tried. The config's own node answering as
 * another chain is a fact about the config, so it fails the chain; an alternate
 * doing so is only a bad registry entry and is skipped.
 */
async function nodeFor(chain, tried) {
  const candidates = [...new Set([chain.rpc, ...alternates(chain.chainId)].filter(Boolean))];
  for (const url of candidates) {
    let answer;
    try {
      answer = Number(BigInt(await call(url, "eth_chainId", [])));
    } catch (error) {
      tried.push(`${url}: ${String(error?.message ?? error).slice(0, 80)}`);
      continue;
    }
    if (answer === chain.chainId) {
      tried.push(`${url}: chain id ${answer}`);
      return url;
    }
    tried.push(`${url}: answers chain id ${answer}`);
    if (url === chain.rpc) {
      throw new Error(`config node answers chain id ${answer}, config says ${chain.chainId}`);
    }
  }
  throw new Error(`no node reachable for chain id ${chain.chainId}`);
}

async function inspectEvm(chain) {
  const its = chain.contracts?.InterchainTokenService?.address;
  const gas = chain.contracts?.AxelarGasService?.address;
  if (its === undefined) return { skip: "no token service in the config" };
  if (gas === undefined) throw new Error("no gas service in the config");

  const tried = [];
  let node;
  try {
    node = await nodeFor(chain, tried);
  } catch (error) {
    throw new Error(`${error.message} [tried ${tried.join("; ")}]`);
  }

  const code = await call(node, "eth_getCode", [its, "latest"]);
  if (typeof code !== "string" || code.length <= 2) {
    throw new Error(`no code at ${its} (read through ${node})`);
  }
  const word = await call(node, "eth_call", [{ to: its, data: GAS_SERVICE_SELECTOR }, "latest"]);
  const onChainGas = `0x${String(word).slice(-40)}`;
  if (onChainGas.toLowerCase() !== gas.toLowerCase()) {
    throw new Error(`token service names gas service ${onChainGas}, config says ${gas}`);
  }
  const gasCode = await call(node, "eth_getCode", [gas, "latest"]);
  if (typeof gasCode !== "string" || gasCode.length <= 2) throw new Error(`no code at ${gas}`);

  return { pinned: { interchainTokenService: its, gasService: gas }, via: node };
}

async function inspectStellar(network, chain) {
  const its = chain.contracts?.InterchainTokenService?.address;
  if (its === undefined) throw new Error("no token service in the config");
  const server = new rpc.Server(STELLAR_RPC[network]);
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(its).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const { entries } = await server.getLedgerEntries(key);
  if (entries.length === 0) throw new Error(`no contract instance at ${its}`);
  return { pinned: { interchainTokenService: its, gasService: undefined } };
}

const pinned = { testnet: {}, mainnet: {} };
const failures = [];

for (const network of ["testnet", "mainnet"]) {
  const chains = await config(network);
  const rows = Object.entries(chains).filter(
    ([, c]) => c.chainType === "evm" || c.chainType === "stellar",
  );
  const settled = await Promise.allSettled(
    rows.map(([id, chain]) =>
      chain.chainType === "stellar" ? inspectStellar(network, chain) : inspectEvm(chain),
    ),
  );
  settled.forEach((outcome, index) => {
    const [id] = rows[index];
    if (outcome.status === "rejected") {
      failures.push({ network, id, reason: String(outcome.reason?.message ?? outcome.reason) });
      console.log(`  ✗ ${network}/${id}: ${outcome.reason?.message ?? outcome.reason}`);
    } else if (outcome.value.skip !== undefined) {
      console.log(`  - ${network}/${id}: ${outcome.value.skip}`);
    } else {
      pinned[network][id] = outcome.value.pinned;
      const via = outcome.value.via === undefined ? "" : ` via ${outcome.value.via}`;
      console.log(`  ✓ ${network}/${id} ${outcome.value.pinned.interchainTokenService}${via}`);
    }
  });
}

const today = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const rows = (network) =>
  Object.keys(pinned[network])
    .sort()
    .map((id) => {
      const p = pinned[network][id];
      return (
        `    ${JSON.stringify(id)}: {\n` +
        `      interchainTokenService: ${JSON.stringify(p.interchainTokenService)},\n` +
        `      gasService: ${p.gasService === undefined ? "undefined" : JSON.stringify(p.gasService)},\n` +
        "    },"
      );
    })
    .join("\n");

writeFileSync(
  "packages/adapters/axelar/src/pinned.ts",
  `import type { NetworkId } from "@mavna/core";

/**
 * The Axelar deployment this adapter trusts.
 *
 * GENERATED by \`node scripts/verify-axelar-deployments.mjs\` on ${today}. Do not edit
 * by hand: the next run overwrites it.
 *
 * The configuration is read at this commit rather than from the main branch, and
 * a chain's token service and gas service are accepted only when they match the
 * addresses below, each of which was confirmed on its own chain: the node's chain
 * id, code at both addresses, and the token service naming this gas service
 * itself. A chain missing here is not offered.
 */
export const DEPLOYMENTS_COMMIT = ${JSON.stringify(commit)};

export interface PinnedChain {
  readonly interchainTokenService: string;
  /** Undefined on Stellar, where nothing is paid to a gas service. */
  readonly gasService: string | undefined;
}

export const PINNED_DEPLOYMENTS: Readonly<
  Record<NetworkId, Readonly<Record<string, PinnedChain>>>
> = {
  testnet: {
${rows("testnet")}
  },
  mainnet: {
${rows("mainnet")}
  },
};
`,
);

console.log(
  `\n  pinned ${Object.keys(pinned.testnet).length} testnet and ` +
    `${Object.keys(pinned.mainnet).length} mainnet chains; ${failures.length} unconfirmed`,
);
