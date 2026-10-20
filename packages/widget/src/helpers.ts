/*
 * Small display helpers shared by the component and its screen renderers.
 */

/**
 * Anything thrown, as an Error that keeps what it said. The Stellar wallet kit
 * rejects with plain `{ code, message }` objects, and their message is the only
 * account of what the wallet did.
 */
export function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const said = (e as { message?: unknown } | null)?.message;
  return new Error(typeof said === "string" && said !== "" ? said : String(e));
}

/** Error to a readable string, with a fallback when it says nothing readable. */
export const msg = (e: unknown, fallback = "That did not work."): string => {
  if (e instanceof Error) return e.message;
  const said = (e as { message?: unknown } | null)?.message;
  return typeof said === "string" && said !== "" ? said : fallback;
};

/** A 6…4 elision of an address, matching the design's wallet label. */
export const shortAddr = (a: string): string =>
  a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
