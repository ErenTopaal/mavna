/*
 * Small display helpers shared by the component and its screen renderers.
 */
import type { StellarWalletApi } from "./stellar-wallet";

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

/**
 * A Stellar wallet that keeps the address it connected. Opening the kit's
 * picker is how it connects, so asking again for every step of one transfer
 * would show the picker several times; a picker that was dismissed is asked
 * again next time, and a disconnect forgets the address.
 */
export function rememberConnection(wallet: StellarWalletApi): StellarWalletApi {
  let connected: string | undefined;
  return {
    async connect() {
      connected ??= await wallet.connect();
      return connected;
    },
    sign: (xdr, address) => wallet.sign(xdr, address),
    async disconnect() {
      connected = undefined;
      await wallet.disconnect();
    },
  };
}
