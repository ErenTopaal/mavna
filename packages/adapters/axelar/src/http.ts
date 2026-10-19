import { MavnaError } from "@mavna/core";

/**
 * How long any one of Axelar's endpoints, or a node it publishes, gets to answer.
 *
 * Without a limit a host that accepts the connection and then says nothing holds
 * a quote open until the racing deadline gives up on the whole rail.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface JsonReply {
  readonly ok: boolean;
  readonly status: number;
  /** The parsed body when the status is a success, undefined otherwise. */
  readonly body: unknown;
}

/**
 * Fetch and parse, under one timeout, with network failures told apart from answers.
 *
 * The body is read inside the same guard because the timeout can fire while it is
 * still arriving, and that abort is as much a network failure as a refused
 * connection. A body that arrives whole and is not JSON is an answer, a wrong
 * one, and is left to surface as it is.
 */
export async function requestJson(
  service: string,
  url: string,
  init: RequestInit = {},
): Promise<JsonReply> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw unreachable(service, cause);
  }
  if (!response.ok) return { ok: false, status: response.status, body: undefined };

  try {
    return { ok: true, status: response.status, body: await response.json() };
  } catch (cause) {
    if (isAbort(cause)) throw unreachable(service, cause);
    throw cause;
  }
}

/**
 * Retryable, because nothing about the request is known to be wrong, and a raw
 * TypeError or DOMException from fetch says nothing a caller can act on.
 */
function unreachable(service: string, cause: unknown): MavnaError {
  const detail = isAbort(cause)
    ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return new MavnaError(`${service} could not be reached: ${detail}`, { retryable: true, cause });
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}
