/**
 * Re-derive everything the LayerZero adapter depends on, from the chains.
 *
 * This exists because of a specific, measured failure. The project
 * specification recorded three Stellar testnet LayerZero addresses as verified
 * on-chain. On 4 August 2026 LayerZero deployed an entire second Stellar testnet
 * stack and repointed its registry at it. The April contracts are still on the
 * ledger, still answer, and still report endpoint id 40600. Nothing about using
 * the retired ones fails loudly, which is the worst possible property.
 *
 * So nothing here is compared against a written-down address. The package's
 * `config.ts` carries only three kinds of thing, and each is checked differently:
 *
 *   the Stellar endpoint ids, against the endpoint contract's own storage;
 *   the RPC endpoints, by asking each one which chain it is actually serving;
 *   the block times, by measuring them.
 *
 * Everything else is resolved live and cross-examined: the registry's Stellar
 * stack must be internally consistent, every EVM endpoint must agree with the
 * registry about its own id and must carry the Stellar pathway, and every OFT
 * must peer to a Stellar contract that is registered on the endpoint the
 * registry currently names.
 *
 * The option encoder is checked too, against a live deployment rather than
 * against itself: the bytes the adapter would build are compared with the bytes
 * a real OFT has enforced on the Stellar pathway.
 *
 * Run: pnpm --filter @mavna/adapter-layerzero build
 *      node scripts/verify-layerzero.mjs [--network=mainnet|testnet]
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { decodeFunctionResult, encodeFunctionData } from "viem";

const packageRequire = createRequire(new URL("../packages/stellar/package.json", import.meta.url));
const {
  Contract,
  rpc: sorobanRpc,
  scValToNative,
  StrKey,
  xdr,
} = await import(packageRequire.resolve("@stellar/stellar-sdk"));

/**
 * Read from the built package rather than from its source.
 *
 * Node can strip types from a lone file but does not rewrite the `.js`
 * specifiers this codebase imports its own modules with, so the source graph
 * will not load standalone. Checking the build is the better half of the
 * accident anyway: it is what an integrator actually installs.
 */
const built = new URL("../packages/adapters/layerzero/dist/index.mjs", import.meta.url);
if (!existsSync(built)) {
  console.error(
    "The layerzero package has not been built. Run:\n" +
      "  pnpm --filter @mavna/adapter-layerzero build",
  );
  process.exit(1);
}
const {
  EVM_SOURCES,
  executorLzReceiveOption,
  LAYERZERO_METADATA_URL,
  LAYERZERO_OFT_REGISTRY_URL,
  ROUTED_SYMBOLS,
  STELLAR_SIDE,
} = await import(built.href);

/** Stellar's own RPC, which is not something LayerZero publishes. */
const STELLAR_RPC = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

const only = process.argv.find((a) => a.startsWith("--network="))?.slice("--network=".length);
const networks = only === undefined ? ["testnet", "mainnet"] : [only];

const failures = [];
const findings = [];

/** A claim this package makes. If it is wrong, the package is wrong. */
const note = (ok, message) => {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${message}`);
  if (!ok) failures.push(message);
};

/**
 * Something true about somebody else's deployment.
 *
 * Kept out of the failure count on purpose. A token whose owner has not peered
 * it to Stellar, or has not chosen its verifiers, is a fact about that token,
 * not drift in this package: the adapter already declines those routes at quote
 * time with a reason. Counting them as failures would make this script red
 * forever, and a check that is always red is a check everyone learns to ignore.
 */
const finding = (where, message) => {
  console.log(`  \u00b7 ${message}`);
  findings.push(`${where}: ${message}`);
};

const detail = (message) => console.log(`      ${message}`);

/**
 * Renders an arbitrary value readably, so a failure says something.
 *
 * `String(value)` on an object produces "[object Object]", which names nothing.
 * This project already paid for that once, in the Axelar fee reader, where an
 * unexpected shape reached `BigInt()` and threw a SyntaxError mentioning neither
 * the field nor the value. A verification script that reports a problem and
 * hides what it was is worse than no script.
 */
function describe(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "nothing at all";
  if (typeof value === "bigint") return value.toString();
  try {
    const json = JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
    return json ?? "a value with no readable form";
  } catch {
    return "a value that could not be read";
  }
}

/** An error's own words, without letting a thrown non-Error come out as nothing. */
function reason(error) {
  return error instanceof Error && typeof error.message === "string"
    ? error.message
    : describe(error);
}

/**
 * An address a contract returned, lowercased, or a hard stop.
 *
 * Shape matters more here than anywhere else in this script. The endpoint check
 * below decides whether a token speaks through the contract we believe it does,
 * and two unreadable values both stringify to "[object Object]" and therefore
 * compare EQUAL. That is a security check passing precisely when it should not.
 */
function readAddress(value, what) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  throw new Error(`${what} is not an address: ${describe(value)}`);
}

/** Bytes a contract returned. Length is not checked; being hex at all is. */
function readHex(value, what) {
  if (typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value)) return value;
  throw new Error(`${what} is not a hex string: ${describe(value)}`);
}

/** A count or a small integer a contract returned, as a number. */
function readCount(value, what) {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric === "number" && Number.isInteger(numeric) && numeric >= 0) return numeric;
  throw new Error(`${what} is not a whole number: ${describe(value)}`);
}

const TIMEOUT = 15_000;

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function evmRpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(describe(body.error.message ?? body.error).slice(0, 120));
  return body.result;
}

/**
 * The first configured endpoint that is genuinely serving the chain we mean.
 *
 * Not paranoia: LayerZero's own registry files an OP Sepolia endpoint under
 * Ethereum Sepolia, and because every LayerZero contract sits at the same
 * address on both chains, reading through it returns a confident wrong answer
 * rather than an error.
 */
async function pickNodes(source) {
  const good = [];
  const wrong = [];
  for (const url of source.rpc) {
    let seen;
    try {
      seen = Number(await evmRpc(url, "eth_chainId", []));
    } catch (error) {
      wrong.push(`${url} unreachable (${reason(error).slice(0, 60)})`);
      continue;
    }
    if (seen !== source.evmChainId) {
      wrong.push(`${url} serves chain ${seen}, not ${source.evmChainId}`);
      continue;
    }
    good.push(url);
  }
  return { good, wrong };
}

/**
 * The chain's real block time, or undefined if no node would say.
 *
 * Several spans are tried because a pruned node answers a request for a block a
 * few hundred back with a null rather than an error, and a short span still
 * measures a block time perfectly well.
 */
async function measureBlockMs(urls) {
  for (const url of urls) {
    for (const span of [200, 64, 16]) {
      try {
        const head = Number(await evmRpc(url, "eth_blockNumber", []));
        const [older, newer] = await Promise.all([
          evmRpc(url, "eth_getBlockByNumber", [`0x${(head - span).toString(16)}`, false]),
          evmRpc(url, "eth_getBlockByNumber", [`0x${head.toString(16)}`, false]),
        ]);
        if (older?.timestamp === undefined || newer?.timestamp === undefined) continue;
        return ((Number(newer.timestamp) - Number(older.timestamp)) * 1000) / span;
      } catch {
        // Try a shorter span, then the next node.
      }
    }
  }
  return undefined;
}

const ABI = [
  {
    name: "eid",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    name: "isSupportedEid",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getSendLibrary",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint32" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "peers",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "token",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "approvalRequired",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    name: "sharedDecimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "endpoint",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "enforcedOptions",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint32" }, { type: "uint16" }],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
];

const ULN_COMPONENTS = [
  { name: "confirmations", type: "uint64" },
  { name: "requiredDVNCount", type: "uint8" },
  { name: "optionalDVNCount", type: "uint8" },
  { name: "optionalDVNThreshold", type: "uint8" },
  { name: "requiredDVNs", type: "address[]" },
  { name: "optionalDVNs", type: "address[]" },
];

const ULN_ABI = [
  {
    name: "getUlnConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint32" }],
    outputs: [{ components: ULN_COMPONENTS, type: "tuple" }],
  },
  {
    name: "getAppUlnConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint32" }],
    outputs: [{ components: ULN_COMPONENTS, type: "tuple" }],
  },
];

async function callContract(url, abi, to, functionName, args = []) {
  const data = await evmRpc(url, "eth_call", [
    { to, data: encodeFunctionData({ abi, functionName, args }) },
    "latest",
  ]);
  return decodeFunctionResult({ abi, functionName, data });
}

/** A Soroban contract's instance storage, as a plain map. Undefined if it is not there. */
async function stellarInstance(server, address) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(address).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries[0];
  if (entry === undefined) return undefined;

  const values = new Map();
  for (const item of entry.val.contractData().val().instance().storage() ?? []) {
    const name = scValToNative(item.key());
    if (Array.isArray(name) && typeof name[0] === "string") {
      values.set(name[0], scValToNative(item.val()));
    }
  }
  return values;
}

/**
 * LayerZero keys the same chain differently in its two payloads, and the
 * difference is not cosmetic. `/metadata/deployments` calls Arbitrum Sepolia
 * `arbsep-testnet` and Stellar mainnet `stellar-mainnet`; the root `/metadata`
 * calls them `arbitrum-sepolia` and `stellar`. Worse, in `/deployments` the keys
 * `arbitrum-testnet`, `base-testnet` and `optimism-testnet` are the DEPRECATED
 * Goerli chains rather than the Sepolia ones, so a lookup under a
 * reasonable-looking name silently returns a dead network.
 *
 * The package uses `/deployments` for Stellar and the OFT registry for tokens,
 * and the OFT registry is keyed the root payload's way. So both are fetched and
 * each is used only where its vocabulary applies.
 */
const LAYERZERO_ROOT_METADATA_URL = "https://metadata.layerzero-api.com/v1/metadata";

console.log("Fetching LayerZero's registries");
const [deployments, rootMetadata, oftRegistry] = await Promise.all([
  getJson(LAYERZERO_METADATA_URL),
  getJson(LAYERZERO_ROOT_METADATA_URL),
  getJson(LAYERZERO_OFT_REGISTRY_URL),
]);

for (const network of networks) {
  const side = STELLAR_SIDE[network];
  console.log(`\n== ${network}`);

  // ---- Stellar, from LayerZero's registry and then from the ledger itself ----

  const chain = deployments[side.chainKey];
  note(chain !== undefined, `LayerZero still lists "${side.chainKey}"`);
  if (chain === undefined) continue;

  const v2 = (chain.deployments ?? []).filter((d) => d.version === 2);
  note(v2.length === 1, `exactly one V2 Stellar deployment is registered (found ${v2.length})`);
  if (v2.length !== 1) continue;

  const registered = v2[0];
  const stellarEndpoint = registered.endpointV2?.address;
  const stellarUln = registered.sendUln302?.address;
  const stellarExecutor = registered.executor?.address;

  note(
    Number(registered.eid) === side.eid,
    `the registry agrees Stellar is endpoint ${side.eid} (says ${registered.eid})`,
  );
  detail(`endpoint ${stellarEndpoint}`);

  const server = new sorobanRpc.Server(STELLAR_RPC[network]);
  const endpointStorage = await stellarInstance(server, stellarEndpoint);
  note(endpointStorage !== undefined, "the registered Stellar endpoint exists on the ledger");

  if (endpointStorage !== undefined) {
    // The endpoint's own record of its id, which is the only source that cannot
    // be repointed by editing a registry.
    note(
      Number(endpointStorage.get("Eid")) === side.eid,
      `the endpoint contract itself reports endpoint id ${side.eid} ` +
        `(says ${endpointStorage.get("Eid")})`,
    );
    note(
      Number(endpointStorage.get("RegisteredLibrariesCount") ?? 0) > 0,
      "the endpoint has at least one message library registered",
    );
  }

  for (const [label, address] of [
    ["send library", stellarUln],
    ["executor", stellarExecutor],
  ]) {
    const storage = await stellarInstance(server, address);
    if (storage === undefined) {
      note(false, `the registered Stellar ${label} exists on the ledger`);
      continue;
    }
    // Each worker names the endpoint it belongs to. A worker pointing somewhere
    // else means the registry is mixing two deployments together.
    note(
      storage.get("Endpoint") === stellarEndpoint,
      `the Stellar ${label} names the registered endpoint`,
    );
    if (storage.get("Endpoint") !== stellarEndpoint) {
      detail(`it names ${storage.get("Endpoint")} instead`);
    }
  }

  // ---- Each source chain, asked directly ----

  const nodes = new Map();
  for (const [chainId, source] of Object.entries(EVM_SOURCES[network])) {
    console.log(`\n  -- ${chainId}`);

    const { good, wrong } = await pickNodes(source);
    const url = good[0];
    note(url !== undefined, `a configured node is genuinely serving chain ${source.evmChainId}`);
    for (const problem of wrong) detail(problem);
    if (url === undefined) continue;
    nodes.set(chainId, url);

    // Measured, not trusted. The delivery estimate is confirmations multiplied
    // by this, so a figure that has drifted quietly misprices the wait.
    const measured = await measureBlockMs(good);
    if (measured === undefined) {
      // Not being able to look is different from having looked and found a
      // problem, and reporting them the same way is how a red run stops meaning
      // anything.
      finding(chainId, "no node would serve a historical block, so the block time is unchecked");
    } else {
      const ratio = measured / source.averageBlockMs;
      note(
        ratio > 0.4 && ratio < 2.5,
        `block time is within range of the recorded ${source.averageBlockMs} ms ` +
          `(measured ${Math.round(measured)} ms)`,
      );
    }

    const registryChain = rootMetadata[source.layerZeroKey];
    const evmDeployment = (registryChain?.deployments ?? []).find(
      (d) => d.version === 2 && d.endpointV2?.address?.startsWith("0x"),
    );
    note(
      evmDeployment !== undefined,
      `LayerZero lists a V2 endpoint under "${source.layerZeroKey}"`,
    );
    if (evmDeployment === undefined) continue;

    const endpoint = evmDeployment.endpointV2.address;
    let reportedEid;
    try {
      reportedEid = Number(await callContract(url, ABI, endpoint, "eid"));
    } catch (error) {
      note(false, `the endpoint at ${endpoint} answers (${reason(error).slice(0, 70)})`);
      continue;
    }
    note(
      reportedEid === Number(evmDeployment.eid),
      `the endpoint contract agrees it is endpoint ${evmDeployment.eid}`,
    );

    // Whether the protocol beneath the token carries this pathway at all. A
    // chain listed here that answers false is a chain nothing can be sent from.
    const supported = await callContract(url, ABI, endpoint, "isSupportedEid", [side.eid]);
    note(supported === true, `it carries the Stellar pathway (endpoint ${side.eid})`);
  }

  // ---- Each routed token, all the way through to Stellar ----

  const symbols = ROUTED_SYMBOLS[network];
  if (symbols.length === 0) {
    console.log(
      `\n  -- no routed symbols on ${network}: LayerZero publishes no OFT registry for any\n` +
        "     testnet, so there is nothing to resolve. This is recorded, not a failure.",
    );
    continue;
  }

  for (const symbol of symbols) {
    const entries = (oftRegistry[symbol] ?? []).filter((e) => e.name === symbol);
    note(entries.length > 0, `LayerZero's OFT registry still carries ${symbol}`);

    for (const [chainId, source] of Object.entries(EVM_SOURCES[network])) {
      const url = nodes.get(chainId);
      if (url === undefined) continue;

      const address = entries
        .map((e) => e.deployments?.[source.layerZeroKey]?.address)
        .find((a) => a !== undefined);
      if (address === undefined) continue;

      console.log(`\n  -- ${symbol} on ${chainId}`);
      detail(address);

      try {
        await inspectToken({
          url,
          source,
          chainId,
          symbol,
          address,
          server,
          stellarEndpoint,
          side,
        });
      } catch (error) {
        // A shape we did not expect means this contract is not what we think it
        // is, which is a failure worth recording rather than one worth crashing
        // the rest of the sweep over.
        note(false, `${symbol} on ${chainId} could be read: ${reason(error)}`);
      }
    }
  }
}

/**
 * One token, from its EVM contract all the way through to its Stellar peer.
 *
 * Split out so a contract that answers with an unexpected shape stops this token
 * rather than the whole run, and so every value that came off a chain passes
 * through a reader before it reaches a comparison or a sentence.
 */
async function inspectToken(context) {
  const { url, source, chainId, symbol, address, server, stellarEndpoint, side } = context;

  const peer = readHex(await callContract(url, ABI, address, "peers", [side.eid]), "the peer");
  if (/^0x0{64}$/.test(peer)) {
    finding(
      `${symbol} on ${chainId}`,
      "not peered to Stellar, so nothing can be sent from here yet",
    );
    return;
  }
  note(true, "it is peered to Stellar");

  const [rawToken, approvalRequired, rawShared, rawOftEndpoint, rawEnforced] = await Promise.all([
    callContract(url, ABI, address, "token"),
    callContract(url, ABI, address, "approvalRequired"),
    callContract(url, ABI, address, "sharedDecimals"),
    callContract(url, ABI, address, "endpoint"),
    callContract(url, ABI, address, "enforcedOptions", [side.eid, 1]),
  ]);

  const token = readAddress(rawToken, "the OFT's token");
  const shared = readCount(rawShared, "the shared decimals");
  const enforced = readHex(rawEnforced, "the enforced options");

  // The OFT's own view of which endpoint it speaks through, against the one
  // the registry lists. A token wired to some other endpoint would be
  // configured and quoted through a contract it does not actually use.
  //
  // Both sides go through `readAddress` first, and that is the point rather
  // than tidiness: stringifying two unreadable values gives "[object
  // Object]" twice, which compares equal and turns this check into one that
  // passes exactly when it should fail.
  note(
    readAddress(rawOftEndpoint, "the OFT's endpoint") ===
      readAddress(endpointFor(source, rootMetadata), "the registry's endpoint"),
    "the OFT speaks through the endpoint LayerZero lists for this chain",
  );

  const tokenDecimals = readCount(
    await callContract(url, ABI, token, "decimals"),
    "the token's decimals",
  );
  detail(
    `token ${token} (${tokenDecimals} decimals), shared ${shared}, ` +
      `approval ${approvalRequired === true ? "required" : "not required"}`,
  );
  note(
    shared <= tokenDecimals,
    "the token has at least as many decimals as the wire format carries",
  );

  // The Stellar side, asked which endpoint it belongs to. This is the check
  // the retired-deployment hazard makes necessary.
  const stellarOft = StrKey.encodeContract(Buffer.from(peer.slice(2), "hex"));
  const oftStorage = await stellarInstance(server, stellarOft);
  note(oftStorage !== undefined, `its Stellar peer ${stellarOft} exists on the ledger`);
  if (oftStorage !== undefined) {
    const peerEndpoint = oftStorage.get("Endpoint");
    note(
      peerEndpoint === stellarEndpoint,
      "its Stellar peer is registered on the endpoint the registry names",
    );
    if (peerEndpoint !== stellarEndpoint) {
      detail(`it is on ${describe(peerEndpoint)}, which is not the advertised endpoint`);
    }
    const diff = readCount(oftStorage.get("DecimalsDiff") ?? 0, "the Stellar decimals gap");
    note(
      shared + diff === 7,
      `shared decimals plus the Stellar side's difference is 7 (${shared} + ${diff})`,
    );
  }

  // The verifier set, and whether anyone chose it. `getConfig` on the
  // endpoint merges in the defaults and so cannot answer this; only the
  // send library's raw view can.
  const sendLib = await callContract(
    url,
    ABI,
    endpointFor(source, rootMetadata),
    "getSendLibrary",
    [address, side.eid],
  );
  const [effective, app] = await Promise.all([
    callContract(url, ULN_ABI, sendLib, "getUlnConfig", [address, side.eid]),
    callContract(url, ULN_ABI, sendLib, "getAppUlnConfig", [address, side.eid]),
  ]);
  const required = readCount(effective.requiredDVNCount, "the required DVN count");
  const threshold = readCount(effective.optionalDVNThreshold, "the optional DVN threshold");
  const confirmations = readCount(effective.confirmations, "the confirmation depth");
  note(
    required + threshold > 0,
    `${required} verifier(s) must attest, after ${confirmations} confirmations`,
  );
  if (
    readCount(app.requiredDVNCount, "the app's required DVN count") === 0 &&
    readCount(app.optionalDVNCount, "the app's optional DVN count") === 0
  ) {
    finding(
      `${symbol} on ${chainId}`,
      "its verifier set is inherited from the network default rather than chosen, so the " +
        "adapter declines this route",
    );
  } else {
    note(true, "the verifier set is explicitly configured rather than inherited");
  }

  // Our encoder against a real one. The enforced bytes were produced by
  // whoever deployed this token, using LayerZero's own tooling, so matching
  // them is an independent check that this package encodes options correctly.
  if (enforced !== "0x" && enforced.startsWith("0x0003010011")) {
    const gas = BigInt(`0x${enforced.slice(14)}`);
    note(
      executorLzReceiveOption(gas) === enforced,
      `our option encoder reproduces the enforced bytes for ${gas} gas`,
    );
  } else {
    detail(`enforced options are ${enforced === "0x" ? "unset" : enforced}`);
  }
}

/** The V2 endpoint LayerZero lists for a chain, which is where config is read from. */
function endpointFor(source, registry) {
  const found = (registry[source.layerZeroKey]?.deployments ?? []).find(
    (d) => d.version === 2 && d.endpointV2?.address?.startsWith("0x"),
  );
  return found?.endpointV2?.address;
}

if (findings.length > 0) {
  console.log(`\n  ${findings.length} route(s) this rail lists but cannot currently use:`);
  for (const item of findings) console.log(`    \u00b7 ${item}`);
  console.log(
    "    These are declined at quote time with a reason. They are listed here so the\n" +
      "    configuration can be pruned deliberately rather than by surprise.",
  );
}

console.log(
  failures.length === 0
    ? "\n  LayerZero's deployment agrees with this package on every network checked"
    : `\n  ${failures.length} check(s) failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
