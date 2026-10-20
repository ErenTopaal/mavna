/**
 * Check what `starknet.ts` hardcodes against what Starknet actually says.
 *
 * Starknet has no deterministic address shared across chains and no on-chain
 * registry to derive one from, so the two contract addresses are written down.
 * Everything that CAN be checked is:
 *
 *   1. Each address resolves to a deployed class, on its own network and not the
 *      other. That is how testnet and mainnet were told apart in the first place,
 *      rather than by trusting the order of a table.
 *   2. Our selector for `deposit_for_burn_with_hook`, computed as keccak with the
 *      top bits cleared, appears in the class's own external entry points.
 *   3. The ABI still declares the argument list we encode, in that order.
 *   4. USDC is what the contract's own `get_local_token` returns, and Stellar is
 *      a registered remote.
 *
 * Run: node scripts/verify-cctp-starknet.mjs
 */
import { keccak256, toBytes } from "viem";

const NETWORKS = {
  testnet: {
    rpc: ["https://starknet-sepolia-rpc.publicnode.com", "https://starknet-sepolia.drpc.org"],
    tokenMessengerMinterV2: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
    messageTransmitterV2: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
    usdc: "0x512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
    // The seed for deriving USDC, exactly as the EVM sweep does it.
    seedDomain: 0,
    seedToken: 0x1c7d4b196cb0c7b01d743fbc6116a902379c7238n,
  },
  mainnet: {
    // lava has been discontinued and drpc does not serve starknet_getClassHashAt
    rpc: ["https://starknet-rpc.publicnode.com", "https://starknet.api.onfinality.io/public"],
    tokenMessengerMinterV2: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
    messageTransmitterV2: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
    usdc: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    seedDomain: 0,
    seedToken: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n,
  },
};

const EXPECTED_ARGUMENTS = [
  "amount",
  "destination_domain",
  "mint_recipient",
  "burn_token",
  "destination_caller",
  "max_fee",
  "min_finality_threshold",
  "hook_data",
];

const STELLAR_DOMAIN = 27;
const MASK = (1n << 250n) - 1n;
const selector = (name) => `0x${(BigInt(keccak256(toBytes(name))) & MASK).toString(16)}`;

const failures = [];
const note = (ok, message) => {
  console.log(`  ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(message);
};

/**
 * Whether a contract exists, or a thrown error when no endpoint could say.
 *
 * Only Starknet's own "Contract not found" (error 20) is a no. A rate limit or
 * an endpoint that does not serve the method says nothing about the contract,
 * and reading it as absent once printed a deployed transmitter as missing and
 * would pass the cross-network check for the wrong reason.
 */
async function deployedAt(config, address) {
  try {
    await rpc(url(config), "starknet_getClassHashAt", {
      block_id: "latest",
      contract_address: address,
    });
    return true;
  } catch (error) {
    if (/Contract not found/i.test(String(error))) return false;
    throw new Error(`could not check ${address}: ${String(error?.message ?? error)}`);
  }
}

/**
 * Ask, trying each endpoint before believing a failure.
 *
 * One provider answered `starknet_getClassAt` and then claimed `starknet_call`
 * did not exist, on the same host in the same run. A single flaky endpoint must
 * not be reported as a chain that has no deployment.
 */
async function rpc(urls, method, params) {
  let last;
  for (const url of [urls].flat()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = await response.json();
        if (body.error) {
          const message = JSON.stringify(body.error);
          // A contract that is genuinely absent is an answer, not an outage, so it
          // is returned rather than retried against the next endpoint.
          if (/Contract not found|entrypoint does not exist/i.test(message)) {
            throw new Error(message.slice(0, 160));
          }
          last = new Error(message.slice(0, 160));
          // slowed down is not refused: wait and ask the same endpoint again
          if (/too many|rate limit|-32029/i.test(message)) {
            await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
            continue;
          }
          break;
        }
        return body.result;
      } catch (error) {
        if (/Contract not found|entrypoint does not exist/i.test(String(error))) throw error;
        last = error;
        break;
      }
    }
  }
  throw last ?? new Error("no endpoint answered");
}

const call = (url, contract, name, calldata) =>
  rpc(url, "starknet_call", {
    request: { contract_address: contract, entry_point_selector: selector(name), calldata },
    block_id: "latest",
  });

for (const [network, config] of Object.entries(NETWORKS)) {
  console.log(`\n== ${network}`);

  for (const name of ["tokenMessengerMinterV2", "messageTransmitterV2"]) {
    note(await deployedAt(config, config[name]), `${name} is deployed on ${network}`);
  }

  // The same address must NOT resolve on the other network, or we have simply
  // written the same contract down twice.
  const other = network === "testnet" ? NETWORKS.mainnet : NETWORKS.testnet;
  const bleeds = await deployedAt(config, other.tokenMessengerMinterV2);
  note(!bleeds, `the other network's messenger is absent here, so the two are distinct`);

  const cls = await rpc(url(config), "starknet_getClassAt", {
    block_id: "latest",
    contract_address: config.tokenMessengerMinterV2,
  });

  const externals = new Set(
    cls.entry_points_by_type.EXTERNAL.map((e) => BigInt(e.selector).toString(16)),
  );
  const ours = BigInt(selector("deposit_for_burn_with_hook")).toString(16);
  note(externals.has(ours), `our selector is one of the class's external entry points`);

  const abi = typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi;
  const functions = abi.flatMap((item) =>
    item.type === "interface" ? (item.items ?? []) : item.type === "function" ? [item] : [],
  );
  const burn = functions.find((f) => f.name === "deposit_for_burn_with_hook");
  note(burn !== undefined, "the ABI still declares deposit_for_burn_with_hook");
  if (burn !== undefined) {
    const args = burn.inputs.map((i) => i.name);
    note(
      JSON.stringify(args) === JSON.stringify(EXPECTED_ARGUMENTS),
      `the argument list matches, in order (${args.length} of them)`,
    );
    if (JSON.stringify(args) !== JSON.stringify(EXPECTED_ARGUMENTS)) {
      console.log("      chain says:", JSON.stringify(args));
    }
  }

  const low = config.seedToken & ((1n << 128n) - 1n);
  const high = config.seedToken >> 128n;
  const local = await call(url(config), config.tokenMessengerMinterV2, "get_local_token", [
    `0x${config.seedDomain.toString(16)}`,
    `0x${low.toString(16)}`,
    `0x${high.toString(16)}`,
  ]);
  note(
    BigInt(local[0]) === BigInt(config.usdc),
    `USDC matches what get_local_token returns: ${local[0]}`,
  );

  const remote = await call(url(config), config.tokenMessengerMinterV2, "remote_token_messenger", [
    `0x${STELLAR_DOMAIN.toString(16)}`,
  ]);
  note(
    remote.some((word) => BigInt(word) !== 0n),
    "Stellar is a registered remote token messenger",
  );
}

function url(config) {
  return config.rpc;
}

console.log(
  failures.length === 0
    ? "\n  Starknet constants agree with both networks"
    : `\n  ${failures.length} check(s) failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
