import { MavnaError, type NetworkId } from "@mavna/core";
import { assertFeeIsPlausible } from "./discovery.js";

/**
 * What Axelar charges to carry a message.
 *
 * The fee is flat and component-based, not a percentage, which makes this rail
 * comparatively cheaper at size and means the ranking engine must model it as an
 * absolute rather than assuming percentages across all rails.
 */

const GMP_API: Readonly<Record<NetworkId, string>> = {
  testnet: "https://testnet.api.gmp.axelarscan.io",
  mainnet: "https://api.gmp.axelarscan.io",
};

export interface GasEstimate {
  readonly totalFee: string;
  readonly baseFee: string;
  readonly executionFee: string;
}

/**
 * Estimate the gas to pay upfront.
 *
 * Two traps, both of which fail silently and both of which are handled here:
 *
 * 1. Without `showDetailedFees`, the response is a BARE NUMERIC STRING rather
 *    than JSON, so parsing it as an object yields nothing useful.
 * 2. Errors come back as HTTP 200 with `{"error": true}` in the body, so
 *    branching on the status code alone treats failures as successes.
 */
export async function estimateGasFee(
  network: NetworkId,
  sourceChain: string,
  destinationChain: string,
  gasLimit = "200000",
): Promise<GasEstimate> {
  const response = await fetch(`${GMP_API[network]}/estimateGasFee`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain,
      destinationChain,
      sourceTokenSymbol: "XLM",
      gasLimit,
      showDetailedFees: true,
    }),
  });

  if (!response.ok) {
    throw new MavnaError(`Axelar's fee estimator returned HTTP ${response.status}.`, {
      retryable: response.status >= 500,
    });
  }

  const body = (await response.json()) as Record<string, unknown>;

  // Branch on the body, never the status: this API answers failures with a 200.
  if (body.error === true) {
    throw new MavnaError(
      `Axelar declined to price ${sourceChain} to ${destinationChain}: ${describe(body.message)}`,
      { retryable: false },
    );
  }

  const totalFee = readFeeField(body.totalFee, "totalFee");
  // A zero means the chain name was not recognised, not that it is free.
  assertFeeIsPlausible(totalFee, sourceChain);

  return {
    totalFee,
    baseFee: readFeeField(body.baseFee, "baseFee"),
    executionFee: readFeeField(body.executionFee, "executionFee"),
  };
}

/**
 * What an interchain TOKEN transfer costs, which is not the same number.
 *
 * `estimateGasFee` prices one message. An interchain transfer is two, because it
 * routes through the hub, and the endpoint below knows that: asked for
 * base-sepolia to Stellar it answers with a breakdown of both legs, where the
 * generic estimator answers with less. Measured on the same pair at the same
 * moment, 1001610 against 842003.
 *
 * Underpaying is the failure this whole rail has to avoid, so the transfer is
 * priced with the endpoint built for it. Axelar's own explorer does the same for
 * exactly this case: its add-gas control switches to this endpoint when a message
 * is bound for the hub.
 *
 * Same trap as its sibling, and worse: the response is a BARE NUMBER with no
 * JSON object around it at all, so anything reading a field off it gets nothing.
 */
export async function estimateItsFee(
  network: NetworkId,
  sourceChain: string,
  destinationChain: string,
  gasLimit = "200000",
  gasMultiplier = 1.1,
): Promise<string> {
  const response = await fetch(`${GMP_API[network]}/estimateITSFee`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain,
      destinationChain,
      sourceTokenSymbol: "XLM",
      gasLimit,
      gasMultiplier,
    }),
  });

  if (!response.ok) {
    throw new MavnaError(`Axelar's transfer fee estimator returned HTTP ${response.status}.`, {
      retryable: response.status >= 500,
    });
  }

  const body: unknown = await response.json();

  // An object here means an error, because a success is a bare number.
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    throw new MavnaError(
      `Axelar declined to price a transfer from ${sourceChain} to ${destinationChain}: ` +
        describe(record.message ?? record.error),
      { retryable: false },
    );
  }

  const fee = readFeeField(body, "totalFee");
  // Zero means the chain name was not recognised, not that delivery is free.
  assertFeeIsPlausible(fee, destinationChain);
  return fee;
}

/**
 * Read a fee field without letting a wrong shape through as a number.
 *
 * `String(value)` on an object produces "[object Object]", which then reaches
 * `BigInt()` and throws a SyntaxError naming nothing at all. Since a fee that
 * misreads as zero is exactly what strands a transfer, an unexpected shape has
 * to stop here, loudly, rather than downstream as a parse error.
 *
 * A missing field really does mean zero, and zero is caught by the plausibility
 * check rather than treated as free.
 */
function readFeeField(value: unknown, field: string): string {
  if (value === undefined || value === null) return "0";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new MavnaError(
    `Axelar's fee estimator returned a "${field}" that is neither a string nor a number: ` +
      `${describe(value)}. Refusing to guess a fee from it.`,
    { retryable: false },
  );
}

/** Renders an arbitrary JSON value readably, so error messages say something. */
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "no reason given";
  try {
    // JSON.stringify returns undefined for functions and symbols; falling back to
    // String() there would reintroduce the "[object Object]" this exists to stop.
    return JSON.stringify(value) ?? "a value with no readable form";
  } catch {
    return "a value that could not be read";
  }
}
