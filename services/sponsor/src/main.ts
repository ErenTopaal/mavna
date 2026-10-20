import { buildDelivery } from "@mavna/adapter-cctp";
import { createNetworkConfig, RpcClient } from "@mavna/stellar";
import { curatedAssetsFor } from "./assets.js";
import { CapLedger } from "./caps.js";
import { readSponsorConfig, SponsorConfigError } from "./config.js";
import { env } from "./env.js";
import { createSponsorServer } from "./server.js";
import { createSoroswapProxy } from "./soroswap.js";
import { DocumentCapStore, FileDocumentStore, MemoryDocumentStore } from "./state.js";

/**
 * The runnable sponsor, configured from the environment.
 *
 * Everything here is deliberately boring: read configuration, refuse to start
 * on a mistake, load what was written down, listen. The judgement lives in
 * `server.ts`; this file exists so `node dist/main.mjs` is the whole deployment
 * story, matching the requirement that an integrator can run all of it
 * themselves.
 */

let config: ReturnType<typeof readSponsorConfig>;
try {
  config = readSponsorConfig(process.env);
} catch (cause) {
  if (!(cause instanceof SponsorConfigError)) throw cause;
  console.error(cause.message);
  process.exit(2);
}

for (const warning of config.warnings) console.error(`[sponsor] ${warning}`);

if (config.stateDir === undefined) {
  // Said at every start, because running this way loses the caps, held
  // settlements and channel keys on a restart.
  console.error(
    "[sponsor] MAVNA_STATE_DIR is not set: caps, held settlements and channel keys live in " +
      "memory only and are lost on restart.",
  );
}
const state =
  config.stateDir === undefined
    ? new MemoryDocumentStore()
    : new FileDocumentStore(config.stateDir);

const network = createNetworkConfig({ id: config.networkId, rpcUrl: config.rpcUrl });

// Optional. Without a key there is no Soroswap proxy, and browsers converting
// through this sponsor use the next venue instead.
const soroswapApiKey = env("SOROSWAP_API_KEY");
const soroswap =
  soroswapApiKey === undefined
    ? undefined
    : createSoroswapProxy({ apiKey: soroswapApiKey, network: config.networkId });

/**
 * Finishing conversions on arrival, when configured. The executor key is its
 * own secret: it signs only lz_compose authorizations and holds only its
 * minimum balance, so a token named in a message never reaches sponsor funds.
 */
function arrival(): { arrivalContract?: string; arrivalExecutorSecret?: string } {
  const contract = env("MAVNA_ARRIVAL_CONTRACT");
  if (contract === undefined) return {};
  const executor = env("MAVNA_ARRIVAL_EXECUTOR_SECRET");
  // in self mode the sponsor finishes nothing and needs no executor
  if (executor === undefined && config.reserveFunding === "self")
    return { arrivalContract: contract };
  if (executor === undefined) {
    console.error(
      "MAVNA_ARRIVAL_CONTRACT is set but MAVNA_ARRIVAL_EXECUTOR_SECRET is not. Finishing " +
        "conversions needs its own executor key, separate from the sponsor key.",
    );
    process.exit(2);
  }
  return { arrivalContract: contract, arrivalExecutorSecret: executor };
}

const server = createSponsorServer({
  rpc: new RpcClient({ url: network.rpcUrl }),
  network,
  networkId: config.networkId,
  sponsorSecret: config.sponsorSecret,
  curatedAssets: curatedAssetsFor(config.networkId),
  buildDelivery,
  irisUrl: config.irisUrl,
  allowedOrigins: config.allowedOrigins,
  caps: new CapLedger(new DocumentCapStore(state), config.caps),
  state,
  reserveFunding: config.reserveFunding,
  minDeliveryBaseUnits: config.minDeliveryBaseUnits,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
  provisionalSettlements: config.provisionalSettlements,
  channelFloor: config.channelFloor,
  settlementsPerClient: config.settlementsPerClient,
  deliveryBudgetStroops: config.deliveryBudgetStroops,
  ...(config.settleSweepSeconds === undefined
    ? {}
    : { settleSweepSeconds: config.settleSweepSeconds }),
  ...(soroswap === undefined ? {} : { soroswap }),
  ...arrival(),
});

try {
  await server.ready();
} catch {
  // the reason is already on stderr, from the server itself
  process.exit(2);
}

server.listen(config.port, () => {
  // The one line an operator needs at start-up, on stderr with the rest of the
  // process's own reporting; stdout stays clean for anything piped through it.
  console.error(
    `[sponsor] listening on :${config.port}, network ${config.networkId}, ` +
      `rpc ${config.rpcUrl}, reserves funded by ${config.reserveFunding}`,
  );
  server.startSweep();
});
