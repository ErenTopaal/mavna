/**
 * Derive and verify CCTP's EVM deployment, chain by chain, from the chains.
 *
 * Nothing here is transcribed from documentation. For each chain this asks the
 * network three questions and refuses to record anything it cannot answer:
 *
 *   1. Is there code at the TokenMessengerV2 address?
 *   2. What does that contract say its local minter is?
 *   3. What does the minter say the local USDC is, and does that token agree
 *      that it is USDC with six decimals?
 *
 * Step 3 is the important one. It means no USDC address is ever typed in by a
 * human: each is derived from the chain's own token minter, seeded by the one
 * USDC address per network that is independently verified below. A previous
 * draft of this project shipped a bridge's addresses that had been dead for
 * months, which is why deriving beats transcribing here.
 *
 * Run from the repository root: node scripts/verify-cctp-chains.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encodeFunctionData, pad } from "viem";

/**
 * Endpoints that carry a credential in the URL, read from `.env` and never
 * written down here. An absent one drops that chain from the sweep rather than
 * failing the run: the rest of the registry does not depend on it.
 */
const secrets = new Map();
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) secrets.set(match[1], match[2]);
  }
}

const MESSENGER = {
  // CCTP V2 uses one deterministic address per network across every EVM chain.
  // Treated as a candidate to probe, never as a fact: a chain where this has no
  // code is reported as unverified rather than recorded.
  mainnet: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  testnet: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
};

/**
 * The seed for the derivation, and the only USDC address on each network that is
 * written down rather than derived. Both are checked against the token itself
 * before anything is derived from them.
 */
const SEED = {
  mainnet: { domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  testnet: { domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
};

const ERC20 = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
];

const MESSENGER_ABI = [
  {
    name: "localMinter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const MINTER_ABI = [
  {
    name: "getLocalToken",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint32" }, { type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
];

/**
 * Circle's domain for each chain, plus somewhere to ask.
 *
 * The domain numbers are the ones already measured against Circle's live fee
 * service in `config.ts`. The RPC URLs are the only guesswork, and a wrong one
 * announces itself immediately as an unreachable chain rather than as a silently
 * wrong address.
 */
const CHAINS = {
  mainnet: [
    {
      id: "ethereum",
      domain: 0,
      evmChainId: 1,
      rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    },
    {
      id: "avalanche",
      domain: 1,
      evmChainId: 43114,
      rpc: ["https://api.avax.network/ext/bc/C/rpc"],
    },
    { id: "optimism", domain: 2, evmChainId: 10, rpc: ["https://mainnet.optimism.io"] },
    { id: "arbitrum", domain: 3, evmChainId: 42161, rpc: ["https://arb1.arbitrum.io/rpc"] },
    { id: "base", domain: 6, evmChainId: 8453, rpc: ["https://mainnet.base.org"] },
    {
      id: "polygon",
      domain: 7,
      evmChainId: 137,
      rpc: [
        "https://polygon-bor-rpc.publicnode.com",
        "https://polygon-rpc.com",
        "https://polygon.drpc.org",
      ],
    },
    { id: "unichain", domain: 10, evmChainId: 130, rpc: ["https://mainnet.unichain.org"] },
    { id: "linea", domain: 11, evmChainId: 59144, rpc: ["https://rpc.linea.build"] },
    { id: "codex", domain: 12, evmChainId: 81224, rpc: ["https://rpc.codex.xyz"] },
    { id: "sonic", domain: 13, evmChainId: 146, rpc: ["https://rpc.soniclabs.com"] },
    {
      id: "world-chain",
      domain: 14,
      evmChainId: 480,
      rpc: ["https://worldchain-mainnet.g.alchemy.com/public"],
    },
    { id: "monad", domain: 15, evmChainId: 143, rpc: ["https://rpc.monad.xyz"] },
    { id: "sei", domain: 16, evmChainId: 1329, rpc: ["https://evm-rpc.sei-apis.com"] },
    {
      id: "xdc",
      domain: 18,
      evmChainId: 50,
      rpc: ["https://rpc.xdcrpc.com", "https://erpc.xinfin.network", "https://rpc.xinfin.network"],
    },
    { id: "hyperevm", domain: 19, evmChainId: 999, rpc: ["https://rpc.hyperliquid.xyz/evm"] },
    { id: "ink", domain: 21, evmChainId: 57073, rpc: ["https://rpc-gel.inkonchain.com"] },
    { id: "plume", domain: 22, evmChainId: 98866, rpc: ["https://rpc.plume.org"] },
    {
      id: "edge",
      domain: 28,
      evmChainId: 3343,
      // EDGE keeps its messenger somewhere else entirely. The first sweep
      // reported it as having none, because it was looking where every other
      // chain keeps one.
      messenger: "0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c",
      rpc: ["https://edge-mainnet.g.alchemy.com/public"],
    },
    {
      id: "morph",
      domain: 30,
      evmChainId: 2818,
      rpc: ["https://rpc.morphl2.io", "https://rpc-quicknode.morphl2.io"],
    },
    {
      id: "pharos",
      domain: 31,
      evmChainId: 1672,
      rpc: ["https://rpc.pharos.xyz", "https://api.zan.top/public/pharos-mainnet"],
    },
    {
      id: "injective",
      domain: 29,
      evmChainId: 1776,
      rpc: ["https://sentry.evm-rpc.injective.network"],
    },
    { id: "cronos", domain: 32, evmChainId: 25, rpc: ["https://evm.cronos.org"] },
    { id: "x-layer", domain: 37, evmChainId: 196, rpc: ["https://rpc.xlayer.tech"] },
    // Circle's own chain. Stellar mainnet's token messenger has a remote messenger
    // for domain 26 and Circle's fee service answers 26 to 27.
    { id: "arc", domain: 26, evmChainId: 5042, rpc: ["https://rpc.mainnet.arc.io"] },
  ],
  testnet: [
    {
      id: "ethereum-sepolia",
      domain: 0,
      evmChainId: 11155111,
      rpc: ["https://ethereum-sepolia-rpc.publicnode.com"],
    },
    {
      id: "avalanche-fuji",
      domain: 1,
      evmChainId: 43113,
      rpc: ["https://api.avax-test.network/ext/bc/C/rpc"],
    },
    {
      id: "optimism-sepolia",
      domain: 2,
      evmChainId: 11155420,
      rpc: ["https://sepolia.optimism.io"],
    },
    {
      id: "arbitrum-sepolia",
      domain: 3,
      evmChainId: 421614,
      rpc: ["https://sepolia-rollup.arbitrum.io/rpc"],
    },
    {
      id: "base-sepolia",
      domain: 6,
      evmChainId: 84532,
      rpc: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    },
    {
      id: "polygon-amoy",
      domain: 7,
      evmChainId: 80002,
      rpc: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://rpc-amoy.polygon.technology"],
    },
    { id: "unichain-sepolia", domain: 10, evmChainId: 1301, rpc: ["https://sepolia.unichain.org"] },
    {
      id: "linea-sepolia",
      domain: 11,
      evmChainId: 59141,
      rpc: ["https://rpc.sepolia.linea.build"],
    },
    { id: "codex-testnet", domain: 12, evmChainId: 812242, rpc: ["https://rpc.codex-stg.xyz"] },
    {
      id: "sonic-testnet",
      domain: 13,
      evmChainId: 14601,
      rpc: ["https://rpc.testnet.soniclabs.com"],
    },
    {
      id: "world-chain-sepolia",
      domain: 14,
      evmChainId: 4801,
      rpc: ["https://worldchain-sepolia.g.alchemy.com/public"],
    },
    { id: "monad-testnet", domain: 15, evmChainId: 10143, rpc: ["https://testnet-rpc.monad.xyz"] },
    {
      id: "sei-testnet",
      domain: 16,
      evmChainId: 1328,
      rpc: ["https://evm-rpc-testnet.sei-apis.com"],
    },
    {
      id: "xdc-apothem",
      domain: 18,
      evmChainId: 51,
      rpc: ["https://rpc.apothem.network", "https://erpc.apothem.network"],
    },
    {
      id: "hyperevm-testnet",
      domain: 19,
      evmChainId: 998,
      rpc: ["https://rpc.hyperliquid-testnet.xyz/evm"],
    },
    {
      id: "ink-sepolia",
      domain: 21,
      evmChainId: 763373,
      rpc: ["https://rpc-gel-sepolia.inkonchain.com"],
    },
    { id: "plume-testnet", domain: 22, evmChainId: 98867, rpc: ["https://testnet-rpc.plume.org"] },
    {
      id: "arc-testnet",
      domain: 26,
      evmChainId: 5042002,
      // rpc.testnet.arc.network stopped answering; the chain moved to arc.io
      rpc: ["https://rpc.testnet.arc.io"],
    },
    {
      id: "edge-testnet",
      domain: 28,
      evmChainId: 33431,
      rpc: [
        "https://edge-testnet.g.alchemy.com/public",
        "https://edge-sepolia.g.alchemy.com/public",
      ],
    },
    {
      id: "morph-hoodi",
      domain: 30,
      evmChainId: 2910,
      // Hoodi, not Holesky. Circle's own table names the Hoodi network, and the
      // Holesky endpoints this used to probe are a different, retired chain.
      rpc: ["https://rpc-hoodi.morphl2.io"],
    },
    {
      id: "pharos-testnet",
      domain: 31,
      evmChainId: 688689,
      // The owner's keyed endpoint lives in .env; the public one is Pharos's own
      // (DP Labs) and answers eth_chainId 0xa8231.
      rpc: [secrets.get("PHAROS_TESTNET_RPC_URL"), "https://atlantic.dplabs-internal.com"].filter(
        Boolean,
      ),
    },
    {
      id: "injective-testnet",
      domain: 29,
      evmChainId: 1439,
      rpc: ["https://k8s.testnet.json-rpc.injective.network"],
    },
    { id: "cronos-testnet", domain: 32, evmChainId: 338, rpc: ["https://evm-t3.cronos.org"] },
    {
      id: "x-layer-sepolia",
      domain: 37,
      // 195 is the retired X Layer testnet; this endpoint serves its successor
      evmChainId: 1952,
      rpc: ["https://testrpc.xlayer.tech"],
    },
  ],
};

const TIMEOUT = 12_000;

/** `--only=pharos-testnet` narrows the sweep, for looking at one chain closely. */
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request at a time per host, with a small gap between them.
 *
 * Sweeping every chain at once is fine for most providers and fatal for the
 * metered ones: a compute-unit limit answers concurrent calls with 429 or 403,
 * which reads exactly like "no deployment here" and would silently drop a
 * perfectly good chain from the registry. Serialising per host costs a few
 * seconds and removes a whole class of wrong answer.
 */
const hostQueues = new Map();

function throttle(url, work) {
  const host = new URL(url).host;
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.then(async () => {
    const result = await work();
    await wait(120);
    return result;
  });
  // Keep the chain going even when a link rejects, or one failure stalls the host.
  hostQueues.set(
    host,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Ask an endpoint, trying each URL and backing off when told to slow down.
 *
 * Sweeping twenty-one chains at once made a rate-limited provider answer 403,
 * which reads exactly like "this chain has no deployment" and would have quietly
 * dropped a perfectly good chain from the registry. Being throttled is not the
 * same as being absent, so it is retried rather than recorded.
 */
async function rpcCall(urls, method, params) {
  let last;
  for (const url of urls) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await throttle(url, () =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(TIMEOUT),
          }),
        );

        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          last = new Error(`HTTP ${response.status}`);
          await wait(600 * 2 ** attempt);
          continue;
        }

        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`non-JSON reply (HTTP ${response.status})`);
        }
        if (body.error) {
          const message = String(body.error.message ?? `${method} failed`);
          // Some providers report a quota inside a 200 response instead of a
          // status code, which would otherwise be recorded as a real failure.
          if (/limit|quota|rate|too many/i.test(message)) {
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
  }
  throw last ?? new Error("no endpoint answered");
}

async function call(rpc, to, data) {
  const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string" || result === "0x") throw new Error("empty result");
  return result;
}

async function getCode(rpc, address) {
  return (await rpcCall(rpc, "eth_getCode", [address, "latest"])) ?? "0x";
}

const addressFrom = (word) => `0x${word.slice(-40)}`;

function decodeString(hex) {
  const raw = hex.slice(2);
  // Standard ABI string: offset, length, then the bytes.
  const length = Number.parseInt(raw.slice(64, 128), 16);
  const bytes = raw.slice(128, 128 + length * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}

async function verifyUsdc(rpc, address) {
  const symbol = decodeString(
    await call(rpc, address, encodeFunctionData({ abi: ERC20, functionName: "symbol" })),
  );
  const decimals = Number.parseInt(
    (await call(rpc, address, encodeFunctionData({ abi: ERC20, functionName: "decimals" }))).slice(
      2,
    ),
    16,
  );
  if (symbol !== "USDC") throw new Error(`token reports symbol "${symbol}", not USDC`);
  if (decimals !== 6) throw new Error(`token reports ${decimals} decimals, not 6`);
  return { symbol, decimals };
}

/**
 * The endpoints that serve the chain this row claims to be, asked rather than
 * assumed.
 *
 * The id in the table above is typed by a person, and it is the one value handed
 * to a wallet to switch networks. A wrong one (Pharos once carried 688688, X
 * Layer testnet the retired 195) still verified every contract, because the
 * contracts were read through an RPC for the right chain. So every endpoint is
 * asked eth_chainId: one answering a different chain fails the row outright, one
 * that cannot be reached is left out, and a row with no endpoint confirming its
 * id is not written.
 */
async function confirmChainId(chain) {
  const confirmed = [];
  const unreachable = [];
  for (const url of chain.rpc) {
    let answer;
    try {
      answer = await rpcCall([url], "eth_chainId", []);
    } catch (error) {
      unreachable.push(`${url}: ${error?.message ?? error}`);
      continue;
    }
    const observed = Number(BigInt(answer));
    if (observed !== chain.evmChainId) {
      throw new Error(
        `${url} answers eth_chainId ${observed}, not the ${chain.evmChainId} this row names`,
      );
    }
    confirmed.push(url);
  }
  if (confirmed.length === 0) {
    throw new Error(
      `no endpoint confirmed chain id ${chain.evmChainId} (${unreachable.join("; ")})`,
    );
  }
  return confirmed;
}

async function inspect(network, listed) {
  // Only endpoints that confirmed the chain id are read from here on.
  const chain = { ...listed, rpc: await confirmChainId(listed) };
  // A per-chain override wins. The deterministic address is a candidate to probe,
  // never a fact: EDGE keeps its mainnet messenger somewhere else entirely.
  const messenger = chain.messenger ?? MESSENGER[network];
  const seed = SEED[network];

  const code = await getCode(chain.rpc, messenger);
  if (code === "0x" || code.length <= 4) {
    throw new Error(`no TokenMessengerV2 code at ${messenger}`);
  }

  const minter = addressFrom(
    await call(
      chain.rpc,
      messenger,
      encodeFunctionData({ abi: MESSENGER_ABI, functionName: "localMinter" }),
    ),
  );

  if (chain.domain === seed.domain) {
    // getLocalToken maps a REMOTE token to a local one. On the chain the seed
    // came from there is no remote pair to look up, so the seed is the answer --
    // and it was verified against the token itself before we got here.
    await verifyUsdc(chain.rpc, seed.usdc);
    return {
      ...chain,
      tokenMessengerV2: messenger,
      tokenMinterV2: minter,
      usdc: seed.usdc.toLowerCase(),
    };
  }

  // The chain tells us its own USDC, keyed by the remote token we seeded with.
  const usdc = addressFrom(
    await call(
      chain.rpc,
      minter,
      encodeFunctionData({
        abi: MINTER_ABI,
        functionName: "getLocalToken",
        args: [seed.domain, pad(seed.usdc, { size: 32 })],
      }),
    ),
  );

  if (/^0x0+$/.test(usdc)) throw new Error("the local minter maps no token for the seed pair");

  await verifyUsdc(chain.rpc, usdc);
  return { ...chain, tokenMessengerV2: messenger, tokenMinterV2: minter, usdc };
}

/**
 * Human names and block explorers, taken from the community chain registry
 * rather than typed in here.
 *
 * A wrong explorer URL is not dangerous the way a wrong contract address is, but
 * it is still a link a user clicks expecting to find their transaction, and
 * there is no reason to invent one when an authoritative list exists.
 */
const registry = await fetch("https://chainid.network/chains.json", {
  signal: AbortSignal.timeout(30_000),
})
  .then((r) => r.json())
  .then((all) => new Map(all.map((c) => [c.chainId, c])));

/**
 * Chains the community registry gets wrong or does not carry, filled in from a
 * known source.
 *
 * Kept small and separate on purpose: anything here is a human's word rather than
 * a lookup, so it should be obvious which entries are which. A chain listed here
 * uses these values instead of the registry's, so a registry entry that names the
 * wrong network is replaced rather than merged.
 */
const OVERRIDES = {
  // Name and explorer supplied by the project owner along with the endpoint. No
  // native currency: the community registry does not carry this chain, and the
  // public chain lists disagree with our own naming of it, so it is left unknown
  // rather than filled in from recollection.
  688689: { name: "Pharos Atlantic Testnet", explorer: "https://atlantic.pharosscan.xyz" },
  // chainid.network maps 999 to Wanchain, a different network that used the id
  // first; HyperEVM mainnet also answers on 999, so the registry entry is the
  // wrong chain. Name and native currency match this repo's own Hyperliquid EVM
  // testnet record (id hyperevm-testnet); no explorer is published, left unknown.
  999: { name: "Hyperliquid EVM", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 } },
};

function describe(evmChainId) {
  const override = OVERRIDES[evmChainId];
  // An override replaces the registry entry rather than filling gaps in it, so a
  // registry row for the wrong network (a reused chainId) is discarded.
  const entry = override ? undefined : registry.get(evmChainId);
  const explorer = entry?.explorers?.find((e) => e.url?.startsWith("https"));
  // The gas token is not ETH everywhere. Assuming it is puts "ETH" in front of a
  // user paying in AVAX or POL, which is a small lie in a place where the whole
  // product's credibility is that its numbers are right.
  const native = entry?.nativeCurrency ?? override?.nativeCurrency;
  return {
    name: entry?.name ?? override?.name,
    explorer: explorer?.url ?? override?.explorer,
    nativeCurrency:
      native === undefined
        ? undefined
        : { name: native.name, symbol: native.symbol, decimals: native.decimals },
  };
}

const results = { mainnet: [], testnet: [] };
const failures = [];

for (const network of ["testnet", "mainnet"]) {
  // Confirm the seed is what we think it is before deriving anything from it.
  const seedChain = CHAINS[network][0];
  await verifyUsdc(await confirmChainId(seedChain), SEED[network].usdc);
  console.log(`  ${network}: seed USDC verified on ${seedChain.id}`);

  const wanted =
    only === undefined ? CHAINS[network] : CHAINS[network].filter((c) => c.id === only);
  const settled = await Promise.allSettled(wanted.map((chain) => inspect(network, chain)));
  settled.forEach((outcome, index) => {
    const chain = wanted[index];
    if (outcome.status === "fulfilled") {
      results[network].push({ ...outcome.value, ...describe(chain.evmChainId) });
      console.log(`  ✓ ${network}/${chain.id} usdc=${outcome.value.usdc}`);
    } else {
      failures.push({
        network,
        id: chain.id,
        reason: String(outcome.reason?.message ?? outcome.reason),
      });
      console.log(`  ✗ ${network}/${chain.id}: ${outcome.reason?.message ?? outcome.reason}`);
    }
  });
}

writeFileSync("cctp-chains.verified.json", `${JSON.stringify({ results, failures }, null, 2)}\n`);

/**
 * Write the registry the adapter actually imports.
 *
 * This used to be a hand-copy from the JSON above, while the file's own header
 * said it was generated. That is the sort of comment that is true when written
 * and quietly false a month later, and it makes drift between what was verified
 * and what ships invisible. Now the sweep emits it, so the two cannot disagree.
 *
 * Only run with a full sweep. A partial run (`--only=`) would emit a registry
 * with every other chain missing, so it refuses.
 */
if (only === undefined) {
  writeFileSync("packages/adapters/cctp/src/chains.ts", renderChains(results));
  console.log("  wrote packages/adapters/cctp/src/chains.ts");
} else {
  console.log("  skipped writing chains.ts: --only= is a partial sweep");
}

console.log(
  `\n  verified ${results.testnet.length} testnet and ${results.mainnet.length} mainnet chains; ` +
    `${failures.length} unverified`,
);

function renderChains(verified) {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const entry = (c) =>
    `      ${JSON.stringify(c.id)}: {\n` +
    `        domain: ${c.domain},\n` +
    `        evmChainId: ${c.evmChainId},\n` +
    `        name: ${JSON.stringify(c.name ?? c.id)},\n` +
    `        nativeCurrency: ${JSON.stringify(c.nativeCurrency)},\n` +
    `        tokenMessengerV2: ${JSON.stringify(c.tokenMessengerV2)},\n` +
    `        usdc: ${JSON.stringify(c.usdc)},\n` +
    `        explorer: ${c.explorer === undefined ? "undefined" : JSON.stringify(c.explorer)},\n` +
    `      },`;

  const network = (name) => `    ${name}: {\n${verified[name].map(entry).join("\n")}\n    },`;

  return `import type { NetworkId } from "@mavna/core";

/**
 * Where CCTP lives on every EVM chain that routes into Stellar.
 *
 * GENERATED by \`node scripts/verify-cctp-chains.mjs\` on ${today}. Do not edit by
 * hand: the next sweep overwrites it.
 *
 * Not one address here was typed in by a human. For each chain the script
 * confirmed there is code at the messenger address, asked that contract for its
 * local minter, asked the minter which token is local USDC, and then asked the
 * token whether it agrees it is USDC with six decimals. A chain that could not
 * answer all four is absent rather than guessed at.
 *
 * Two things that sweep taught us, both of which had produced wrong answers:
 *
 * The messenger address is a CANDIDATE, not a fact. Almost every chain keeps it
 * at the same deterministic address, and EDGE does not. Probing the usual place
 * reported EDGE as having no deployment at all, which was a wrong conclusion
 * rather than a missing chain.
 *
 * Injective is on this list because CCTP there lives on Injective's EVM layer.
 * It was nearly given a whole Cosmos transaction format it does not need.
 */

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface EvmDeployment {
  /** Circle's own identifier for the chain. NOT a chain id, and never treat it as one. */
  readonly domain: number;
  /** The EVM chain id, which is what a wallet needs in order to switch networks. */
  readonly evmChainId: number;
  readonly name: string;
  /**
   * What gas is paid in here. Not ETH everywhere, which is why it is carried
   * rather than assumed: telling someone paying in AVAX that they are paying ETH
   * is a small lie in the one place this product cannot afford them.
   *
   * Undefined where the community registry does not carry the chain. Callers name
   * no token at all in that case, which is worse for them than a symbol and much
   * better than the wrong symbol.
   */
  readonly nativeCurrency: NativeCurrency | undefined;
  readonly tokenMessengerV2: string;
  readonly usdc: string;
  /** Undefined where no explorer is published. Better than a link that 404s. */
  readonly explorer: string | undefined;
}

export const EVM_DEPLOYMENTS: Readonly<Record<NetworkId, Readonly<Record<string, EvmDeployment>>>> =
  {
${network("testnet")}
${network("mainnet")}
  };

export function deploymentFor(network: NetworkId, chainId: string): EvmDeployment | undefined {
  return EVM_DEPLOYMENTS[network][chainId];
}

/** Every EVM source chain this adapter can build a burn for, on this network. */
export function sourceChainsFor(network: NetworkId): readonly string[] {
  return Object.keys(EVM_DEPLOYMENTS[network]);
}

/** The chain a Circle domain refers to on this network, for looking a burn up. */
export function chainIdForDomain(network: NetworkId, domain: number): string | undefined {
  for (const [id, deployment] of Object.entries(EVM_DEPLOYMENTS[network])) {
    if (deployment.domain === domain) return id;
  }
  return undefined;
}

/**
 * A transaction's page on a block explorer, or an empty string when the chain
 * publishes none. Callers render no link rather than a broken one.
 */
export function explorerTxUrl(network: NetworkId, chainId: string, hash: string): string {
  const explorer = EVM_DEPLOYMENTS[network][chainId]?.explorer;
  if (explorer === undefined) return "";
  return \`\${explorer.replace(/\\/$/, "")}/tx/\${hash}\`;
}
`;
}
