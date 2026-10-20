import { MavnaError } from "@mavna/core";
import { classifyAddress } from "@mavna/stellar";

/**
 * Just enough ABI coding to ask an EVM chain a question.
 *
 * This adapter never encodes the transaction a user signs: that payload names the
 * function and its arguments and the caller's wallet does the encoding, same as
 * the CCTP adapter. What it does need is to READ from the token service before
 * quoting, and reading means encoding a call and decoding a word or two.
 *
 * That is a small enough job to do here rather than pulling a whole EVM library
 * into a package that otherwise has none. Every selector below was computed from
 * its signature and then confirmed present in the bytecode actually deployed at
 * the token service address; `abi.live.test.ts` re-runs that confirmation against
 * the live chains, so a wrong four bytes cannot sit here unnoticed.
 */

/** The four-byte selectors this adapter calls, each with the signature it came from. */
export const SELECTORS = {
  /** registeredTokenAddress(bytes32) */
  registeredTokenAddress: "0xb90d6afd",
  /** deployedTokenManager(bytes32) */
  deployedTokenManager: "0x7e10eb15",
  /** getImplementationTypeAndTokenAddress() */
  getImplementationTypeAndTokenAddress: "0xd4ae3c42",
  /** interchainTokenId() */
  interchainTokenId: "0x129d8188",
  /** gasService(), the token service's own record of its gas service */
  gasService: "0x6a22d8cc",
  /** isTrustedChain(string), present from token service 2.2.0 onwards */
  isTrustedChain: "0xcaca8dbe",
  /** trustedAddress(string), how 2.1.x answers the same question */
  trustedAddress: "0x477aedc7",
  /** allowance(address,address) */
  allowance: "0xdd62ed3e",
  /** decimals() */
  decimals: "0x313ce567",
  /** symbol() */
  symbol: "0x95d89b41",
} as const;

const WORD = 64;

/** A 32-byte word of hex, no `0x`. */
function word(hex: string): string {
  const bare = hex.replace(/^0x/, "").toLowerCase();
  if (bare.length > WORD) {
    throw new MavnaError(`Value does not fit in one ABI word: 0x${bare}`, { retryable: false });
  }
  return bare.padStart(WORD, "0");
}

export function encodeBytes32(value: string): string {
  const bare = value.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new MavnaError(`Not a 32-byte value: ${value}`, { retryable: false });
  }
  return bare;
}

export function encodeAddress(value: string): string {
  const bare = value.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(bare)) {
    throw new MavnaError(`Not an EVM address: ${value}`, { retryable: false });
  }
  return word(bare);
}

/**
 * A string argument, in the two pieces the ABI splits it into.
 *
 * Dynamic types are stored as an offset in the head and the data in the tail. All
 * of this adapter's calls take at most one dynamic argument, so the offset is
 * always the size of the head.
 */
function encodeStringTail(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const padded = Math.ceil(bytes.length / 32) * 32;
  return word(bytes.length.toString(16)) + bytesToHex(bytes).padEnd(padded * 2, "0");
}

/** Calldata for a call whose arguments are all one word each. */
export function encodeCall(selector: string, words: readonly string[] = []): string {
  return selector + words.join("");
}

/** Calldata for a call taking a single string. */
export function encodeStringCall(selector: string, value: string): string {
  return selector + word("20") + encodeStringTail(value);
}

function body(data: string): string {
  const bare = data.replace(/^0x/, "").toLowerCase();
  if (bare.length % WORD !== 0) {
    throw new MavnaError(`An EVM read answered with a partial word: 0x${bare}`, {
      retryable: false,
    });
  }
  return bare;
}

function wordAt(data: string, index: number): string {
  const bare = body(data);
  const start = index * WORD;
  if (bare.length < start + WORD) {
    throw new MavnaError(
      `An EVM read answered with ${bare.length / WORD} words where at least ${index + 1} ` +
        "were needed. Refusing to read past the end of a response.",
      { retryable: false },
    );
  }
  return bare.slice(start, start + WORD);
}

/** Decoded lower-case, because these are compared rather than displayed. */
export function decodeAddress(data: string, index = 0): string {
  return `0x${wordAt(data, index).slice(24)}`;
}

export function decodeBool(data: string): boolean {
  return BigInt(`0x${wordAt(data, 0)}`) !== 0n;
}

export function decodeUint(data: string, index = 0): bigint {
  return BigInt(`0x${wordAt(data, index)}`);
}

export function decodeBytes32(data: string): string {
  return `0x${wordAt(data, 0)}`;
}

/**
 * Read a returned string.
 *
 * The offset is honoured rather than assumed to be 32. It always is for a single
 * return value, but reading a length from the wrong place yields a plausible
 * number and then a garbage string, which is worse than an error.
 */
export function decodeString(data: string): string {
  const bare = body(data);
  const offset = Number(BigInt(`0x${wordAt(bare, 0)}`));
  if (offset % 32 !== 0) {
    throw new MavnaError("An EVM read returned a string at an unaligned offset.", {
      retryable: false,
    });
  }
  const at = offset / 32;
  const length = Number(BigInt(`0x${wordAt(bare, at)}`));
  const start = (at + 1) * WORD;
  const hex = bare.slice(start, start + length * 2);
  if (hex.length < length * 2) {
    throw new MavnaError("An EVM read returned a string shorter than its own length.", {
      retryable: false,
    });
  }
  return new TextDecoder().decode(hexToBytes(hex));
}

/**
 * A Stellar address as the token service wants to see it.
 *
 * Axelar's own encoder is `hexlify(Buffer.from(address, 'ascii'))` and their
 * documentation says it in words: "For Stellar, addresses must be converted to
 * ASCII byte arrays to be properly recognized by the ITS contract." Not base32
 * decoded, not padded, not length prefixed. The strkey alphabet is ASCII, so
 * UTF-8 and ASCII agree here, but encoding through ASCII explicitly makes that a
 * fact rather than an assumption.
 *
 * The kind is checked, not just the alphabet. Axelar validate the destination as
 * an account or a contract and reject everything else, and every other strkey is
 * spelled from the same letters: a muxed address passes a pattern match happily
 * and would be encoded and sent to a service that will not accept it.
 */
export function encodeStellarDestination(address: string): string {
  let kind: string;
  try {
    kind = classifyAddress(address).kind;
  } catch {
    throw new MavnaError(
      "Refusing to encode that as a Stellar destination: it is not a Stellar address.",
      { retryable: false },
    );
  }

  if (kind !== "account" && kind !== "contract") {
    throw new MavnaError(
      `Refusing to encode a Stellar ${kind} address as a destination. This route ` +
        "delivers to an account or a contract, and Axelar's own encoder accepts " +
        "nothing else.",
      { retryable: false },
    );
  }

  // a valid strkey is base32 letters and digits only, so each character is one ascii byte
  let hex = "";
  for (let i = 0; i < address.length; i++)
    hex += address.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${hex}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bare = hex.replace(/^0x/, "");
  if (bare.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bare)) {
    throw new MavnaError("Not valid hex.", { retryable: false });
  }
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
  return out;
}
