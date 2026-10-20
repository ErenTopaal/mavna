import { MavnaError, type NetworkId } from "@mavna/core";
import { assertFeeIsPlausible } from "./discovery.js";
import { requestJson } from "./http.js";

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
 *
 * The answer is in the smallest unit of `sourceTokenSymbol`, whatever that is:
 * wei for "ETH", stroops for "XLM". Axelar converts at its own USD prices and
 * does not check that the token belongs to the source chain, so asking for the
 * wrong one returns a number that is right in the wrong currency. The caller
 * passes the sending chain's native symbol, because that is what pays.
 */
export async function estimateGasFee(
  network: NetworkId,
  sourceChain: string,
  destinationChain: string,
  sourceTokenSymbol: string,
  gasLimit = "200000",
): Promise<GasEstimate> {
  const reply = await requestJson("Axelar's fee estimator", `${GMP_API[network]}/estimateGasFee`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain,
      destinationChain,
      sourceTokenSymbol,
      gasLimit,
      showDetailedFees: true,
    }),
  });

  if (!reply.ok) {
    throw new MavnaError(`Axelar's fee estimator returned HTTP ${reply.status}.`, {
      retryable: reply.status >= 500 || reply.status === 429,
    });
  }

  const body = reply.body as Record<string, unknown>;

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
 * What to pay for a token transfer, priced by both estimators.
 *
 * They are each unreliable in a different direction, which is why both are
 * called rather than one being picked:
 *
 * `estimateGasFee` prices ONE message. A token transfer is two, because it routes
 * through the hub, so its number is too low to pay. But it validates the chain
 * name: an unrecognised destination comes back as zero.
 *
 * `estimateITSFee` prices both legs and is the number Axelar's own explorer uses
 * for exactly this case. But it does NOT validate the destination. Asked about
 * "stellar" on testnet, or "made-up-chain", it returns the same non-zero default
 * rather than zero, so the mandatory greater-than-zero assertion never fires on
 * it and a wrong name sails straight through.
 *
 * So the name is checked with the one that fails closed, and the payment comes
 * from the one that knows the real shape of the journey. Measured together on
 * base-sepolia to Stellar on 2026-10-19, in wei of ETH: 5661583247892 against
 * 10543325497105, and 0 against 8543325497105 for a name that does not exist.
 *
 * Both are in the smallest unit of `sourceTokenSymbol`, and the result is paid as
 * the native value of a transaction on the sending chain, so the symbol has to be
 * that chain's own token. Priced in XLM the same route came back as 1085720 and
 * 1387448, which are stroops; sent as wei they pay a few billionths of a dollar.
 */
export async function priceTransfer(
  network: NetworkId,
  sourceChain: string,
  destinationChain: string,
  sourceTokenSymbol: string,
): Promise<string> {
  // Runs first and on its own. Its zero is the only thing either endpoint offers
  // that catches a stale or misspelled chain name.
  const single = await estimateGasFee(network, sourceChain, destinationChain, sourceTokenSymbol);
  const both = await estimateItsFee(network, sourceChain, destinationChain, sourceTokenSymbol);

  // The larger of the two. Overpaying is returned by the gas service after
  // delivery; underpaying strands the transfer with no automatic recovery, so
  // the two are not symmetric and the choice is not close.
  const highest = BigInt(both) > BigInt(single.totalFee) ? both : single.totalFee;
  assertFeeIsPlausible(highest, destinationChain);
  return highest;
}

/**
 * The two-leg price on its own.
 *
 * Exported because it is a real reading of a real endpoint, but `priceTransfer`
 * is what should be paid: this number alone has no chain-name check behind it.
 *
 * Same trap as its sibling, and worse: the response is a BARE NUMBER with no
 * JSON object around it at all, so anything reading a field off it gets nothing.
 *
 * Denominated the same way as its sibling: the smallest unit of `sourceTokenSymbol`.
 */
export async function estimateItsFee(
  network: NetworkId,
  sourceChain: string,
  destinationChain: string,
  sourceTokenSymbol: string,
  gasLimit = "200000",
  gasMultiplier = 1.1,
): Promise<string> {
  const reply = await requestJson(
    "Axelar's transfer fee estimator",
    `${GMP_API[network]}/estimateITSFee`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChain,
        destinationChain,
        sourceTokenSymbol,
        gasLimit,
        gasMultiplier,
      }),
    },
  );

  if (!reply.ok) {
    throw new MavnaError(`Axelar's transfer fee estimator returned HTTP ${reply.status}.`, {
      retryable: reply.status >= 500 || reply.status === 429,
    });
  }

  const body = reply.body;

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
