/**
 * Which Stellar network a piece of configuration refers to.
 *
 * Network selection is configuration everywhere in this codebase, never a code
 * path. Nothing may be meaningful on only one network.
 */
export type NetworkId = "testnet" | "mainnet";

/** Base for every error this project raises, so callers can discriminate ours from anyone else's. */
export class MavnaError extends Error {
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MavnaError";
    this.retryable = options.retryable;
  }
}
