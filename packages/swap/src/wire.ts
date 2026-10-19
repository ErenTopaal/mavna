import { MavnaError, type NetworkId, parseFrom } from "@mavna/core";
import { Asset, Networks } from "@stellar/stellar-sdk";
import type { z } from "zod";

/**
 * What every venue does at its network boundary, written once.
 *
 * Each provider used to carry its own copy of the fetch wrapper, and copies are
 * how one of them ends up treating a timeout as permanent.
 */

/** A network failure or timeout is the venue being briefly unreachable, so it is retryable. */
export async function fetchOrThrow(
  venue: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new MavnaError(`${venue} did not answer.`, { retryable: true, cause });
  }
}

/**
 * Read and validate a JSON answer.
 *
 * A venue that answers with something we cannot use is not going to answer
 * differently a moment later, so a shape failure is not retryable. A body that
 * is not JSON at all usually is a proxy's error page, which is.
 */
export async function readValidated<T>(
  venue: string,
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new MavnaError(`${venue} answered with something that is not JSON.`, {
      retryable: true,
      cause,
    });
  }
  return validated(venue, schema, body);
}

export function validated<T>(venue: string, schema: z.ZodType<T>, input: unknown): T {
  try {
    return parseFrom(venue, schema, input);
  } catch (cause) {
    throw new MavnaError(cause instanceof Error ? cause.message : `${venue} answered badly.`, {
      retryable: false,
      cause,
    });
  }
}

export const PASSPHRASE: Readonly<Record<NetworkId, string>> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

/**
 * The contract address the Soroban venues trade an asset under.
 *
 * Accepts `native`, `CODE:ISSUER` or a contract address. A classic asset's
 * contract is its Stellar Asset Contract, which is derived, not looked up, so
 * nothing here can point at an imitation: the issuer is part of the input.
 */
export function toContractId(id: string, network: NetworkId): string {
  if (/^C[A-Z2-7]{55}$/.test(id)) return id;
  if (id === "native" || id === "XLM") return Asset.native().contractId(PASSPHRASE[network]);
  const [code, issuer] = id.split(":");
  if (code === undefined || issuer === undefined || issuer === "") {
    throw new MavnaError(
      `An asset here is a contract address, CODE:ISSUER or native, got "${id}".`,
      { retryable: false },
    );
  }
  return new Asset(code, issuer).contractId(PASSPHRASE[network]);
}
