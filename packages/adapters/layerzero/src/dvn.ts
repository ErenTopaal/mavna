import { MavnaError } from "@mavna/core";
import { encodeAbiParameters } from "viem";

/**
 * Who actually verifies a message, and whether anybody chose them.
 *
 * This is the part of LayerZero that decides what the trust model IS. A message
 * is delivered when the application's required DVNs have each attested to it, so
 * the DVN set is not a tuning parameter, it is the answer to "who could lie to
 * you". Shipping a rail without checking it would mean showing a user a trust
 * model we never read.
 *
 * The specification records the concrete failure: on mainnet the default DVN
 * configuration names a DVN that does not exist, so an application that never
 * set its own cannot be quoted at all. That makes "is this explicitly
 * configured" a question with an answer, and this module asks it.
 *
 * The catch, and the reason two reads are needed: `EndpointV2.getConfig` looks
 * like the answer and is not. It forwards to `SendUln302.getConfig`, which
 * returns `getUlnConfig`, which is the app's config MERGED with the defaults. An
 * application that has set nothing at all comes back looking fully configured.
 * Only `getAppUlnConfig` on the send library returns the raw, unmerged config,
 * and only that can tell the two apart.
 */

/** SendUln302.CONFIG_TYPE_EXECUTOR. Internal in the contract, so it is written here. */
export const CONFIG_TYPE_EXECUTOR = 1;
/** SendUln302.CONFIG_TYPE_ULN. */
export const CONFIG_TYPE_ULN = 2;

/** UlnBase.DEFAULT. A count of zero means "inherit", not "no DVNs". */
const COUNT_MEANS_DEFAULT = 0;
/** UlnBase.NIL_DVN_COUNT. The override that genuinely means "none". */
const COUNT_MEANS_NONE = 255;

export interface UlnConfig {
  readonly confirmations: bigint;
  readonly requiredDVNCount: number;
  readonly optionalDVNCount: number;
  readonly optionalDVNThreshold: number;
  readonly requiredDVNs: readonly string[];
  readonly optionalDVNs: readonly string[];
}

/** The send library reads that separate a chosen configuration from an inherited one. */
export const SEND_ULN_ABI = [
  {
    type: "function",
    name: "getUlnConfig",
    stateMutability: "view",
    inputs: [
      { name: "_oapp", type: "address" },
      { name: "_remoteEid", type: "uint32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "confirmations", type: "uint64" },
          { name: "requiredDVNCount", type: "uint8" },
          { name: "optionalDVNCount", type: "uint8" },
          { name: "optionalDVNThreshold", type: "uint8" },
          { name: "requiredDVNs", type: "address[]" },
          { name: "optionalDVNs", type: "address[]" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getAppUlnConfig",
    stateMutability: "view",
    inputs: [
      { name: "_oapp", type: "address" },
      { name: "_remoteEid", type: "uint32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "confirmations", type: "uint64" },
          { name: "requiredDVNCount", type: "uint8" },
          { name: "optionalDVNCount", type: "uint8" },
          { name: "optionalDVNThreshold", type: "uint8" },
          { name: "requiredDVNs", type: "address[]" },
          { name: "optionalDVNs", type: "address[]" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getExecutorConfig",
    stateMutability: "view",
    inputs: [
      { name: "_oapp", type: "address" },
      { name: "_remoteEid", type: "uint32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "maxMessageSize", type: "uint32" },
          { name: "executor", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "major", type: "uint64" },
      { name: "minor", type: "uint8" },
      { name: "endpointVersion", type: "uint8" },
    ],
  },
] as const;

/** Whether an application chose its own verifiers, or is inheriting whatever is default. */
export function isExplicitlyConfigured(app: UlnConfig): boolean {
  return (
    app.requiredDVNCount !== COUNT_MEANS_DEFAULT || app.optionalDVNCount !== COUNT_MEANS_DEFAULT
  );
}

/**
 * How many independent parties must attest before a message is delivered.
 *
 * Required DVNs must all sign. Optional DVNs need only reach their threshold, so
 * the honest floor is the required count plus that threshold, not the total.
 */
export function verifierThreshold(effective: UlnConfig): number {
  return effective.requiredDVNCount + effective.optionalDVNThreshold;
}

/**
 * Stop rather than send through a verifier set nobody chose.
 *
 * Two separate failures are caught here and they are not the same thing. An
 * effective set with no verifiers in it cannot deliver at all. An effective set
 * that exists only because it was inherited is worse in a quieter way: it can
 * change under the application without the application doing anything, and on
 * mainnet the inherited value is currently a DVN that is not deployed.
 */
export function assertDvnStackIsSound(inputs: {
  readonly effective: UlnConfig;
  readonly app: UlnConfig;
  readonly oft: string;
  readonly eid: number;
}): void {
  const { effective, app, oft, eid } = inputs;

  if (verifierThreshold(effective) === 0 || effective.requiredDVNCount === COUNT_MEANS_NONE) {
    throw new MavnaError(
      `The OFT at ${oft} has no verifier that must attest to messages bound for endpoint ` +
        `${eid}. Nothing would confirm the transfer on the far side.`,
      { retryable: false },
    );
  }

  if (!isExplicitlyConfigured(app)) {
    throw new MavnaError(
      `The OFT at ${oft} has set no DVN configuration of its own for endpoint ${eid} and is ` +
        "inheriting the network default. That default is not a fixed set: LayerZero can change " +
        "who verifies this token's transfers without the token's owner acting, and on Stellar " +
        "mainnet the default currently names a DVN that is not deployed at all, which turns " +
        "into a failure at send time rather than a refusal here. Refusing to route money " +
        "through a verifier set nobody chose.",
      { retryable: false },
    );
  }
}

/** The trust model, said in terms a user can weigh without knowing the words. */
export function describeDvnStack(effective: UlnConfig): string {
  const required = effective.requiredDVNCount;
  const optional = effective.optionalDVNThreshold;
  const confirmations = effective.confirmations.toString();

  const who =
    optional === 0
      ? `${required} named verifier${required === 1 ? "" : "s"} must agree`
      : `${required} named verifier${required === 1 ? "" : "s"} and ${optional} more from a ` +
        `pool of ${effective.optionalDVNCount} must agree`;

  return `${who}, after ${confirmations} source-chain confirmation${confirmations === "1" ? "" : "s"}.`;
}

/**
 * The call that sets a verifier set explicitly, for a caller who owns the OFT.
 *
 * Included because the alternative to inheriting a default is being able to
 * replace it, and a package that can only refuse leaves its user stuck. The
 * ordering and count rules are the contract's, not ours: `UlnBase._setConfig`
 * rejects an unsorted or duplicated list outright, and rejects any count that
 * disagrees with the length of the array beside it.
 */
export function buildUlnSetConfig(inputs: {
  readonly eid: number;
  readonly confirmations: bigint;
  readonly requiredDVNs: readonly `0x${string}`[];
  readonly optionalDVNs?: readonly `0x${string}`[];
  readonly optionalThreshold?: number;
}): { readonly eid: number; readonly configType: number; readonly config: `0x${string}` } {
  const optionalDVNs = inputs.optionalDVNs ?? [];
  const optionalThreshold = inputs.optionalThreshold ?? 0;

  if (inputs.requiredDVNs.length === 0 && optionalThreshold === 0) {
    throw new MavnaError(
      "A configuration with no required DVNs and no optional threshold verifies nothing.",
      { retryable: false },
    );
  }
  assertSortedAndUnique(inputs.requiredDVNs, "required");
  assertSortedAndUnique(optionalDVNs, "optional");
  if (optionalThreshold > optionalDVNs.length) {
    throw new MavnaError(
      `An optional threshold of ${optionalThreshold} cannot be met by ${optionalDVNs.length} ` +
        "optional DVNs.",
      { retryable: false },
    );
  }

  return {
    eid: inputs.eid,
    configType: CONFIG_TYPE_ULN,
    config: encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "confirmations", type: "uint64" },
            { name: "requiredDVNCount", type: "uint8" },
            { name: "optionalDVNCount", type: "uint8" },
            { name: "optionalDVNThreshold", type: "uint8" },
            { name: "requiredDVNs", type: "address[]" },
            { name: "optionalDVNs", type: "address[]" },
          ],
        },
      ],
      [
        {
          confirmations: inputs.confirmations,
          requiredDVNCount: inputs.requiredDVNs.length,
          optionalDVNCount: optionalDVNs.length,
          optionalDVNThreshold: optionalThreshold,
          requiredDVNs: [...inputs.requiredDVNs],
          optionalDVNs: [...optionalDVNs],
        },
      ],
    ),
  };
}

/**
 * The contract sorts nothing for you and reverts on the first pair out of order,
 * so this catches it where the message can explain itself.
 */
function assertSortedAndUnique(dvns: readonly string[], which: string): void {
  let last = "";
  for (const dvn of dvns) {
    const normalised = dvn.toLowerCase();
    if (normalised <= last) {
      throw new MavnaError(
        `The ${which} DVN list must be sorted ascending with no duplicates; ${dvn} is not.`,
        { retryable: false },
      );
    }
    last = normalised;
  }
}
