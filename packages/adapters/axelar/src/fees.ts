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
      `Axelar declined to price ${sourceChain} to ${destinationChain}: ${String(body.message ?? "no reason given")}`,
      { retryable: false },
    );
  }

  const totalFee = String(body.totalFee ?? "0");
  // A zero means the chain name was not recognised, not that it is free.
  assertFeeIsPlausible(totalFee, sourceChain);

  return {
    totalFee,
    baseFee: String(body.baseFee ?? "0"),
    executionFee: String(body.executionFee ?? "0"),
  };
}
