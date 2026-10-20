import * as z from "zod";

/**
 * Schemas for anything that arrives over the network.
 *
 * Quotes, routes, fee estimates, deposit addresses and status responses all come
 * from remote services and then drive money movement. They are input, not truth.
 * Everything is validated at the network boundary, before any value reaches
 * transaction construction, and a response that fails validation is an error
 * rather than something to work around.
 */

/** Integer base units as a string. Rejects decimals, signs and scientific notation. */
export const baseUnits: z.ZodType<string> = z.string().regex(/^\d+$/, "must be integer base units");

/** A positive integer that fits a ledger amount without going through a number. */
export const positiveBaseUnits: z.ZodType<string> = baseUnits.refine(
  // zod runs refinements even after the regex has failed, and BigInt throws on
  // "1.5", so the format is checked again here rather than assumed.
  (v) => /^\d+$/.test(v) && BigInt(v) > 0n,
  "must be greater than zero",
);

/**
 * An account, muxed account or contract address, checked the way Stellar's own
 * StrKey checks one: its exact length, its version byte, and its CRC16 checksum.
 * A shape-only check let a mistyped address through to a payment.
 */
export const stellarAddress: z.ZodType<string> = z
  .string()
  .refine(isStellarAddress, "not a Stellar account, muxed or contract address");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// version byte and payload length by leading character
const STRKEY_FORMS: Readonly<Record<string, { version: number; payload: number }>> = {
  G: { version: 6 << 3, payload: 32 },
  M: { version: 12 << 3, payload: 40 },
  C: { version: 2 << 3, payload: 32 },
};

function isStellarAddress(text: string): boolean {
  const form = STRKEY_FORMS[text[0] ?? ""];
  if (form === undefined) return false;
  const size = 1 + form.payload + 2;
  if (text.length !== Math.ceil((size * 8) / 5)) return false;
  const bytes = new Uint8Array(size);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) return false;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (at < size) bytes[at++] = (value >> bits) & 0xff;
    }
  }
  // leftover bits must be zero, or two strings would name the same key
  if ((value & ((1 << bits) - 1)) !== 0) return false;
  if (bytes[0] !== form.version) return false;
  const crc = crc16xmodem(bytes.subarray(0, size - 2));
  return bytes[size - 2] === (crc & 0xff) && bytes[size - 1] === crc >> 8;
}

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export const evmAddress: z.ZodType<string> = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "not an EVM address");

export const txHashHex: z.ZodType<string> = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "not a 64-hex transaction hash");

/** Basis points, bounded so a bad response cannot smuggle in unlimited slippage. */
export const basisPoints: z.ZodType<number> = z.number().int().min(0).max(10_000);

/**
 * A deadline that has not already passed. A response carrying an expired deadline
 * is a response we must not act on.
 */
export const futureUnixSeconds: z.ZodType<number> = z
  .number()
  .int()
  .refine((v) => v > Math.floor(Date.now() / 1000), "deadline has already passed");

/**
 * Text that will be rendered.
 *
 * Asset names, error strings and chain names are attacker-influenced content: a
 * remote asset list can call a token anything at all, including something that
 * imitates another token or smuggles in formatting. Control characters are
 * stripped because they are never legitimate in a display name, and the length is
 * bounded so a response cannot push a layout around.
 */
export const displayText: z.ZodType<string, string> = z
  .string()
  .max(200)
  .transform(stripControlCharacters);

/**
 * Remove control characters from text that will be rendered.
 *
 * Written as a filter rather than a regular expression on purpose: a character
 * class of control codes is exactly what linters flag as a probable mistake, and
 * here it is deliberate, so saying it in code is clearer than suppressing a
 * warning that is usually right.
 */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0 = code <= 0x1f;
    const isC1 = code >= 0x7f && code <= 0x9f;
    if (!isC0 && !isC1) out += ch;
  }
  return out.trim();
}

/**
 * Parse or throw with the source named, so a bad response is attributable to the
 * service that sent it rather than surfacing as an anonymous type error.
 */
export function parseFrom<T>(source: string, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "response";
    throw new TypeError(
      `${source} returned something unusable: ${where} ${first?.message ?? "failed validation"}`,
    );
  }
  return result.data;
}
