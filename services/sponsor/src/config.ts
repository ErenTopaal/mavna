import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import { StrKey } from "@stellar/stellar-sdk";
import { type CapConfig, DEFAULT_CAPS } from "./caps.js";

/**
 * Who pays the reserve an arriving account needs.
 *
 * `sponsor` is the designed flow: the sponsor fronts it and is repaid from the
 * arrival. `self` is a temporary switch for running without a funded sponsor
 * key: an existing account opens its own trustline from its own XLM, and an
 * address that does not exist yet cannot be served, because nothing can fund
 * an account from inside it.
 */
export type ReserveFunding = "sponsor" | "self";

export interface SponsorConfig {
  readonly networkId: "testnet" | "mainnet";
  readonly sponsorSecret: string;
  readonly rpcUrl: string;
  readonly irisUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly settleSweepSeconds: number | undefined;
  readonly reserveFunding: ReserveFunding;
  readonly caps: CapConfig;
  /** In USDC base units at Circle's six decimals. */
  readonly minDeliveryBaseUnits: bigint;
  /** Requests per address per minute; zero turns the limit off. */
  readonly rateLimitPerMinute: number;
  readonly trustProxy: boolean;
  /** Channels the sponsor funds for itself, each on first need. */
  readonly channelPoolSize: number;
  /** Settlements one client address may have waiting on a preparation; zero for no limit. */
  readonly settlementsPerClient: number;
  /** Delivery fees the sponsor may pay in one UTC day, in stroops. */
  readonly deliveryBudgetStroops: bigint;
  readonly stateDir: string | undefined;
  /**
   * Running for real: on mainnet, or on any network with MAVNA_PRODUCTION=true.
   * A production sponsor never keeps its state in memory only.
   */
  readonly production: boolean;
  readonly port: number;
}

/**
 * Four settlements in flight at once by default. A channel is funded only when
 * every one before it is busy, 2 XLM of the sponsor's each, so an idle sponsor
 * spends no more than one.
 */
export const DEFAULT_CHANNEL_POOL_SIZE = 4;

/** A configuration mistake, worded for the operator who made it. */
export class SponsorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorConfigError";
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Read and check every setting at once, so a typo stops the process at start
 * with its own message rather than surfacing later as a refusal nobody can
 * explain. Empty values count as unset: docker compose forwards `${NAME:-}` as
 * an empty string when the operator sets nothing.
 */
export function readSponsorConfig(source: Environment): SponsorConfig {
  const get = (name: string): string | undefined => {
    const value = source[name];
    return value === undefined || value === "" ? undefined : value;
  };

  const network = get("MAVNA_NETWORK") ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new SponsorConfigError(`MAVNA_NETWORK must be testnet or mainnet; got "${network}".`);
  }

  const sponsorSecret = get("SPONSOR_SECRET_KEY");
  if (sponsorSecret === undefined) {
    throw new SponsorConfigError(
      "SPONSOR_SECRET_KEY is not set. The sponsor cannot pay without it.",
    );
  }
  if (!StrKey.isValidEd25519SecretSeed(sponsorSecret)) {
    // The value itself is never repeated: it is meant to be a secret.
    throw new SponsorConfigError("SPONSOR_SECRET_KEY is not a Stellar secret key.");
  }

  // Mainnet's default is a public node by the owner's decision; an operator
  // points this at their own provider when they have one.
  const publicRpc = network === "mainnet" ? PUBLIC_MAINNET_RPC_URLS[0] : PUBLIC_TESTNET_RPC_URL;
  const rpcUrl = get("STELLAR_RPC_URL") ?? publicRpc;
  if (rpcUrl === undefined) {
    throw new SponsorConfigError(`STELLAR_RPC_URL is not set and ${network} has no public node.`);
  }

  const funding = get("MAVNA_RESERVE_FUNDING") ?? "sponsor";
  if (funding !== "sponsor" && funding !== "self") {
    throw new SponsorConfigError(
      `MAVNA_RESERVE_FUNDING must be sponsor or self; got "${funding}".`,
    );
  }

  const trust = get("MAVNA_TRUST_PROXY") ?? "false";
  if (trust !== "true" && trust !== "false") {
    throw new SponsorConfigError(`MAVNA_TRUST_PROXY must be true or false; got "${trust}".`);
  }

  const whole = (name: string, fallback: number): number => {
    const text = get(name);
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
      throw new SponsorConfigError(`${name} must be a whole number; got "${text}".`);
    }
    return value;
  };

  const sweep = get("MAVNA_SETTLE_SWEEP_SECONDS");
  const channelPoolSize = whole("MAVNA_CHANNEL_POOL_SIZE", DEFAULT_CHANNEL_POOL_SIZE);
  if (channelPoolSize < 1) {
    throw new SponsorConfigError("MAVNA_CHANNEL_POOL_SIZE must be at least 1; got 0.");
  }

  const productionFlag = get("MAVNA_PRODUCTION") ?? "false";
  if (productionFlag !== "true" && productionFlag !== "false") {
    throw new SponsorConfigError(
      `MAVNA_PRODUCTION must be true or false; got "${productionFlag}".`,
    );
  }
  const production = network === "mainnet" || productionFlag === "true";
  const stateDir = get("MAVNA_STATE_DIR");
  if (production && stateDir === undefined) {
    // held settlements, channel keys and the day's caps would be lost on any restart
    throw new SponsorConfigError(
      "MAVNA_STATE_DIR must be set in production (mainnet, or MAVNA_PRODUCTION=true): " +
        "without it, held settlements, channel keys and the daily caps live in memory and " +
        "are lost on restart.",
    );
  }

  return {
    networkId: network,
    sponsorSecret,
    rpcUrl,
    irisUrl:
      get("MAVNA_IRIS_URL") ??
      (network === "mainnet"
        ? "https://iris-api.circle.com"
        : "https://iris-api-sandbox.circle.com"),
    allowedOrigins: (get("MAVNA_ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:4319")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    settleSweepSeconds: sweep === undefined ? undefined : whole("MAVNA_SETTLE_SWEEP_SECONDS", 0),
    reserveFunding: funding,
    caps: {
      strandingCapPerDay: whole("MAVNA_CAP_STRANDING_PER_DAY", DEFAULT_CAPS.strandingCapPerDay),
      volumeCapPerDay: {
        "expensive-gas": whole(
          "MAVNA_CAP_VOLUME_EXPENSIVE_PER_DAY",
          DEFAULT_CAPS.volumeCapPerDay["expensive-gas"],
        ),
        "cheap-gas": whole(
          "MAVNA_CAP_VOLUME_CHEAP_PER_DAY",
          DEFAULT_CAPS.volumeCapPerDay["cheap-gas"],
        ),
      },
    },
    minDeliveryBaseUnits: usdcBaseUnits(
      "MAVNA_MIN_DELIVERY_USDC",
      get("MAVNA_MIN_DELIVERY_USDC") ?? "1",
    ),
    rateLimitPerMinute: whole("MAVNA_RATE_LIMIT_PER_MINUTE", 120),
    trustProxy: trust === "true",
    channelPoolSize,
    settlementsPerClient: whole("MAVNA_SETTLEMENTS_PER_CLIENT", 2),
    deliveryBudgetStroops: xlmStroops(
      "MAVNA_DELIVERY_BUDGET_XLM",
      get("MAVNA_DELIVERY_BUDGET_XLM") ?? "25",
    ),
    stateDir,
    production,
    port: whole("PORT", 8787),
  };
}

/** A decimal XLM amount to stroops, at Stellar's seven decimals. */
function xlmStroops(name: string, text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text);
  if (match === null) {
    throw new SponsorConfigError(
      `${name} must be an XLM amount with at most seven decimals; got "${text}".`,
    );
  }
  return BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

/** A decimal USDC amount to base units, at the six decimals CCTP messages carry. */
function usdcBaseUnits(name: string, text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) {
    throw new SponsorConfigError(
      `${name} must be a USDC amount with at most six decimals; got "${text}".`,
    );
  }
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
