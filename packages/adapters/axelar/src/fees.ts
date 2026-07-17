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
