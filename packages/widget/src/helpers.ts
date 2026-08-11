/*
 * Small display helpers shared by the component and its screen renderers.
 */

/** Error to a readable string, with a fallback when it is not an Error. */
export const msg = (e: unknown, fallback = "That did not work."): string =>
  e instanceof Error ? e.message : fallback;

/** A 6…4 elision of an address, matching the design's wallet label. */
export const shortAddr = (a: string): string =>
  a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
