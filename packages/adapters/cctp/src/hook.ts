import { MavnaError } from "@mavna/core";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The encoding that destroys funds if it is wrong.
 *
 * When USDC crosses into Stellar, it is minted to Circle's forwarder contract and
 * the real recipient travels inside the message as hook data. Circle warns, twice
 * and in red, that getting the surrounding fields wrong makes funds "permanently
 * stuck and cannot be recovered".
 *
 * Every function here validates BEFORE it constructs. The assertion is the
 * primary artifact and the builder is secondary. A thrown error is always better
 * than a plausible-looking transaction that is wrong.
 *
 * Layout, confirmed four independent ways: Circle's documentation table, their
 * published TypeScript encoder, the Rust doc comment in the forwarder contract,
 * and their reference implementation.
 *
 *   bytes  0-23  magic, all zero for Stellar (see below)
 *   bytes 24-27  hook version, u32 big-endian, always 0
 *   bytes 28-31  recipient length in bytes, u32 big-endian
 *   bytes 32..   the recipient's Stellar address as UTF-8 TEXT of the strkey
 *
 * The recipient is the strkey STRING encoded as UTF-8, not the decoded 32 bytes.
 * That is unusual and is the mistake most likely to be made by someone porting
 * EVM habits across.
 */

const MAGIC_BYTES = 24;
const VERSION_OFFSET = 24;
const LENGTH_OFFSET = 28;
const RECIPIENT_OFFSET = 32;
const HOOK_VERSION = 0;

/**
 * Why the magic bytes are zero.
 *
 * Those 24 bytes are a marker that opts into Circle's own off-chain forwarding
 * service, which broadcasts the destination mint on your behalf. That service
 * does NOT support Stellar, and structurally cannot: it refuses to forward when
 * `destinationCaller` is set, and Stellar requires it set. So zeroing them is not
 * a stylistic choice, it is the only correct value, and we perform and pay for
 * the final delivery ourselves.
 */
export const MAGIC_IS_ZEROED_BECAUSE_CIRCLE_DOES_NOT_FORWARD_TO_STELLAR = true;

/** Address forms Circle's forwarder will deliver to. */
export type ForwardRecipientKind = "account" | "contract" | "muxed";

export function classifyForwardRecipient(strkey: string): ForwardRecipientKind {
  if (StrKey.isValidEd25519PublicKey(strkey)) return "account";
  if (StrKey.isValidContract(strkey)) return "contract";
  if (StrKey.isValidMed25519PublicKey(strkey)) return "muxed";
  throw new MavnaError(
    "The recipient is not a Stellar address Circle's forwarder can deliver to. " +
      "It must be an account, a contract, or a muxed address.",
    { retryable: false },
  );
}

/**
 * Build the hook data carrying the final recipient.
 *
 * Validates the recipient before writing a single byte, because a malformed
 * address that reaches the chain is unrecoverable and an exception is free.
 */
export function buildForwarderHookData(recipientStrkey: string): Uint8Array {
  // Throws on anything that is not a deliverable Stellar address.
  classifyForwardRecipient(recipientStrkey);

  const recipient = new TextEncoder().encode(recipientStrkey);
  if (recipient.length === 0 || recipient.length > 128) {
    throw new MavnaError(`Recipient strkey has an implausible length: ${recipient.length}`, {
      retryable: false,
    });
  }

  const out = new Uint8Array(RECIPIENT_OFFSET + recipient.length);
  const view = new DataView(out.buffer);

  // Bytes 0-23 stay zero. See the constant above for why that is correct here.
  view.setUint32(VERSION_OFFSET, HOOK_VERSION, false);
  view.setUint32(LENGTH_OFFSET, recipient.length, false);
  out.set(recipient, RECIPIENT_OFFSET);

  return out;
}

/**
 * Read hook data back. Used to verify what we built and to inspect a message
 * someone else produced before acting on it.
 */
export function parseForwarderHookData(hookData: Uint8Array): {
  readonly version: number;
  readonly recipient: string;
} {
  if (hookData.length < RECIPIENT_OFFSET) {
    throw new MavnaError(
      `Hook data is too short: ${hookData.length} bytes, need at least ${RECIPIENT_OFFSET}.`,
      { retryable: false },
    );
  }

  const view = new DataView(hookData.buffer, hookData.byteOffset, hookData.byteLength);
  const version = view.getUint32(VERSION_OFFSET, false);
  if (version !== HOOK_VERSION) {
    throw new MavnaError(`Unsupported hook version ${version}; only ${HOOK_VERSION} exists.`, {
      retryable: false,
    });
  }

  const length = view.getUint32(LENGTH_OFFSET, false);
  if (hookData.length < RECIPIENT_OFFSET + length) {
    throw new MavnaError(
      `Hook data claims a ${length}-byte recipient but only ${hookData.length - RECIPIENT_OFFSET} follow.`,
      { retryable: false },
    );
  }

  const recipient = new TextDecoder().decode(
    hookData.subarray(RECIPIENT_OFFSET, RECIPIENT_OFFSET + length),
  );
  // Round-trips through validation, so a corrupt payload is rejected on read too.
  classifyForwardRecipient(recipient);

  return { version, recipient };
}

/**
 * Decode a Stellar CONTRACT address to the 32 bytes the EVM side expects.
 *
 * Both `mintRecipient` and `destinationCaller` on the burn must be the forwarder
 * contract. Circle: "If `mintRecipient` is set to a user account or muxed address,
 * USDC is not sent to the forwarder... funds become permanently stuck and cannot
 * be recovered." So this deliberately refuses anything that is not a contract.
 */
export function contractAddressToBytes32(contractStrkey: string): Uint8Array {
  if (!StrKey.isValidContract(contractStrkey)) {
    throw new MavnaError(
      `Refusing to encode ${contractStrkey} as a mint recipient: it is not a contract address. ` +
        "Both mintRecipient and destinationCaller must be Circle's forwarder contract, " +
        "and any other value strands the funds permanently.",
      { retryable: false },
    );
  }
  return StrKey.decodeContract(contractStrkey);
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `0x${out}`;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new MavnaError("Not valid hex.", { retryable: false });
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const HOOK_LAYOUT: {
  readonly MAGIC_BYTES: number;
  readonly VERSION_OFFSET: number;
  readonly LENGTH_OFFSET: number;
  readonly RECIPIENT_OFFSET: number;
  readonly HOOK_VERSION: number;
} = {
  MAGIC_BYTES: MAGIC_BYTES,
  VERSION_OFFSET: VERSION_OFFSET,
  LENGTH_OFFSET: LENGTH_OFFSET,
  RECIPIENT_OFFSET: RECIPIENT_OFFSET,
  HOOK_VERSION: HOOK_VERSION,
};
