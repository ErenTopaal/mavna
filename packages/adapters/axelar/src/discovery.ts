import { MavnaError, type NetworkId } from "@mavna/core";
import { requestJson } from "./http.js";

/**
 * Finding out where Axelar actually is, at runtime.
 *
 * NOTHING about Axelar's deployment may be a constant in this codebase. That is
 * not caution, it is a measured fact: the addresses in the project specification
 * were dead when checked, because Axelar registers Stellar under a VERSIONED
 * chain identifier that changes when they redeploy. Today it is
 * `stellar-2026-q1-2`. Five historical Stellar identifiers are registered and
 * none are retired, so a stale name routes into a graveyard rather than erroring.
 *
 * Every failure mode here is silent, which is what makes it dangerous:
 *   - a wrong chain name returns a confident `false` from the trust check
 *   - a wrong chain name returns a fee estimate of ZERO from the estimator
 * Underpaying then strands the transfer. So discovery fails CLOSED.
 */

const CHAINS_API: Readonly<Record<NetworkId, string>> = {
  testnet: "https://testnet.api.axelarscan.io/api/getChains",
  mainnet: "https://api.axelarscan.io/api/getChains",
};

export interface AxelarStellarChain {
  /** The versioned identifier, e.g. "stellar-2026-q1-2". Never hardcode this. */
  readonly id: string;
  readonly gateway: string;
}

interface ChainRow {
  readonly id?: string;
  readonly chain_type?: string;
  readonly gateway?: { address?: string };
  /** Set on chains Axelar has retired. They stay listed, so this must be read. */
  readonly deprecated?: boolean;
}

/**
 * Resolve the active Stellar chain, expecting EXACTLY one.
 *
 * Zero or two is a hard error rather than a guess. Two means a rotation is in
 * progress, and picking one during a rotation is how funds go to the old
 * deployment.
 */
export async function discoverStellarChain(network: NetworkId): Promise<AxelarStellarChain> {
  return stellarChainIn(await fetchRegistry(network));
}

function stellarChainIn(rows: readonly ChainRow[]): AxelarStellarChain {
  const stellar = rows.filter(
    (row) => row.chain_type === "vm" && typeof row.id === "string" && row.id.startsWith("stellar"),
  );

  if (stellar.length !== 1) {
    throw new MavnaError(
      `Expected exactly one Stellar chain in Axelar's registry, found ${stellar.length}. ` +
        "Zero means it is gone; more than one means a redeployment is in progress. " +
        "Refusing to guess which is current.",
      { retryable: true },
    );
  }

  const row = stellar[0];
  const gateway = row?.gateway?.address;
  if (row?.id === undefined || gateway === undefined) {
    throw new MavnaError("Axelar's registry gave a Stellar entry with no gateway address.", {
      retryable: false,
    });
  }

  return { id: row.id, gateway };
}

/**
 * Which chains Axelar is actually running right now.
 *
 * The registry marks retired chains `deprecated` rather than removing them, and
 * on testnet nine of them are. Listing a retired chain as somewhere a user can
 * send from offers a route into a deployment nobody is relaying for, which is the
 * same class of mistake as a stale Stellar name and just as quiet.
 *
 * The families are Axelar's own: EVM chains are `evm` on some entries and `vm` on
 * others, and hyperliquid, the one testnet chain that reaches Stellar today, is
 * `vm`. So family is not a usable filter here and the caller decides what it can
 * build for, from the deployment configuration where the distinction is honest.
 */
export async function discoverLiveChains(network: NetworkId): Promise<readonly string[]> {
  return liveChainsIn(await fetchRegistry(network));
}

function liveChainsIn(rows: readonly ChainRow[]): readonly string[] {
  return rows
    .filter((row) => typeof row.id === "string" && row.deprecated !== true)
    .map((row) => row.id as string);
}

async function fetchRegistry(network: NetworkId): Promise<readonly ChainRow[]> {
  const reply = await requestJson("Axelar's chain registry", CHAINS_API[network]);
  if (!reply.ok) {
    throw new MavnaError(`Could not reach Axelar's chain registry (HTTP ${reply.status}).`, {
      retryable: reply.status >= 500,
    });
  }
  if (!Array.isArray(reply.body)) {
    throw new MavnaError("Axelar's chain registry returned an unexpected shape.", {
      retryable: false,
    });
  }
  return reply.body as ChainRow[];
}

/**
 * The registry, read once per adapter rather than once per question.
 *
 * A quote asks for the Stellar chain twice, for routing and again for the
 * Stellar-side reader, a build does the same, and the live list is another read
 * of the same document. Each read is the whole registry. Held per adapter rather than per process, so a fresh adapter is a
 * way to pick up a rotation without restarting anything.
 */
export class ChainRegistry {
  private readonly network: NetworkId;
  private rows: Promise<readonly ChainRow[]> | undefined;

  constructor(network: NetworkId) {
    this.network = network;
  }

  async stellarChain(): Promise<AxelarStellarChain> {
    const rows = this.load();
    try {
      return stellarChainIn(await rows);
    } catch (cause) {
      // A registry with no Stellar chain, or two during a rotation, is a reading
      // that should be taken again, not kept until the adapter is replaced.
      this.forget(rows);
      throw cause;
    }
  }

  async liveChains(): Promise<readonly string[]> {
    return liveChainsIn(await this.load());
  }

  private load(): Promise<readonly ChainRow[]> {
    if (this.rows !== undefined) return this.rows;
    const pending = fetchRegistry(this.network);
    this.rows = pending;
    // A failed read must not be cached, or one bad minute disables the rail for
    // as long as this adapter lives.
    pending.catch(() => this.forget(pending));
    return pending;
  }

  private forget(rows: Promise<readonly ChainRow[]>): void {
    if (this.rows === rows) this.rows = undefined;
  }
}

/**
 * Confirm the live contract agrees with the registry.
 *
 * A disagreement means the configuration is mid-rotation, and the only safe
 * response is to stop. This is cheap and catches the exact failure that made the
 * specification's addresses dead.
 */
export function assertChainAgrees(
  discovered: AxelarStellarChain,
  reportedByContract: string,
): void {
  if (discovered.id !== reportedByContract) {
    throw new MavnaError(
      `Axelar's registry says the Stellar chain is "${discovered.id}" but the live ` +
        `contract calls itself "${reportedByContract}". A redeployment is in progress; ` +
        "sending now risks routing into a retired deployment.",
      { retryable: true },
    );
  }
}

/**
 * A fee estimate of zero means the chain name was not recognised, NOT that the
 * transfer is free.
 *
 * Axelar's estimator answers an unknown chain with `0` and HTTP 200. Paying zero
 * gas strands the message on the far side with no automatic recovery, so this
 * assertion is the difference between a stalled transfer and a working one.
 */
export function assertFeeIsPlausible(totalFee: string | number, chainId: string): void {
  const fee = BigInt(typeof totalFee === "number" ? Math.trunc(totalFee) : totalFee || "0");
  if (fee <= 0n) {
    throw new MavnaError(
      `Axelar quoted a zero fee for "${chainId}", which means it does not recognise ` +
        "that chain rather than that the transfer is free. Refusing to send, because " +
        "underpaying gas strands the message with no automatic recovery.",
      { retryable: false },
    );
  }
}
