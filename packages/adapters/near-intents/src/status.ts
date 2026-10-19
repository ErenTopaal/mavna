import type { Asset, NetworkId, OnChainRef, StepPhase } from "@mavna/core";
import { MavnaError } from "@mavna/core";
import type { ChainTx, StatusReply } from "./api.js";
import type { OriginChain } from "./chains.js";

/**
 * 1Click's swap status in the status machine's terms.
 *
 * A NEAR Intents transfer has more ways to end than a bridge message does. A
 * solver can deliver, the deposit can come back, it can arrive short, or it can
 * fail. Each is a terminal phase of its own here, so a refund never reads as a
 * success and a short deposit never reads as a transfer still on its way.
 */

export interface StatusContext {
  readonly network: NetworkId;
  readonly depositAddress: string;
  /** The deposit as the caller knows it, used until 1Click reports its own. */
  readonly sourceTxHash: string | undefined;
  readonly origin: OriginChain;
  readonly originAsset: Asset;
  readonly delivered: Asset;
}

export function phaseFor(reply: StatusReply, context: StatusContext): StepPhase {
  const deposit = depositRef(reply.swap.originTxs[0], context);
  const expectedByUnix = expectedBy(reply);

  switch (reply.status) {
    case "PENDING_DEPOSIT":
      // Nothing has reached the deposit address yet. With a transaction in hand
      // that is a deposit still being included; without one, nothing has started.
      return deposit === undefined
        ? { phase: "idle" }
        : { phase: "pending", ref: deposit, expectedByUnix };

    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return {
        phase: "pending",
        ref: deposit ?? addressRef(context),
        expectedByUnix,
      };

    case "INCOMPLETE_DEPOSIT": {
      const deadline = parseUnix(reply.quote.deadline);
      return {
        phase: "stalled",
        ref: deposit ?? addressRef(context),
        overdueSeconds: 0,
        remedy: {
          kind: "wait",
          untilUnix: deadline ?? 0,
          because:
            "Less arrived at the deposit address than this transfer needs. Unless the rest " +
            "is sent there, NEAR Intents returns it to the sending wallet once the quote " +
            "expires.",
        },
      };
    }

    case "SUCCESS": {
      // When 1Click does not say what settled, only the floor is known to have
      // arrived (SUCCESS settles at or above it), never the quote's estimate.
      const arrived = reply.swap.amountOut ?? reply.quote.minAmountOut;
      const ref =
        stellarRef(reply.swap.destinationTxs[0], context) ?? deposit ?? addressRef(context);
      const received = { asset: context.delivered, baseUnits: arrived };
      // A solver settles at or above the floor or not at all, so this should not
      // happen. If 1Click ever reports it, it is said as it is rather than as done.
      if (BigInt(arrived) < BigInt(reply.quote.minAmountOut)) {
        return {
          phase: "partial",
          ref,
          received,
          expected: { asset: context.delivered, baseUnits: reply.quote.amountOut },
          remedy: {
            kind: "contact",
            reference: context.depositAddress,
            because:
              "Less arrived than the least this transfer promised. NEAR Intents support " +
              "finds a transfer by its deposit address.",
          },
        };
      }
      return { phase: "done", ref, received };
    }

    case "REFUNDED": {
      const returned = reply.swap.refundedAmount ?? reply.swap.depositedAmount;
      if (returned === undefined) {
        throw new MavnaError(
          "1Click reports this transfer as returned but not how much came back.",
          { retryable: true },
        );
      }
      return {
        phase: "refunded",
        ref: deposit ?? addressRef(context),
        to: reply.refundTo,
        returned: { asset: context.originAsset, baseUnits: returned },
      };
    }

    case "FAILED":
      return {
        phase: "failed",
        cause: "NEAR Intents could not complete this transfer.",
        remedy: {
          kind: "contact",
          reference: context.depositAddress,
          because: "NEAR Intents support finds a transfer by its deposit address.",
        },
        ref: deposit ?? addressRef(context),
      };
  }
}

function depositRef(reported: ChainTx | undefined, context: StatusContext): OnChainRef | undefined {
  const hash = reported?.hash ?? context.sourceTxHash;
  if (hash === undefined) return undefined;
  return {
    chainId: context.origin.chainId,
    txHash: hash,
    explorerUrl:
      reported?.explorerUrl !== undefined && reported.explorerUrl !== ""
        ? reported.explorerUrl
        : `${context.origin.explorer}/tx/${hash}`,
  };
}

/**
 * The deposit address itself, for a transfer 1Click knows about before any
 * transaction has been reported. The link shows the address, not a transaction,
 * and the hash is left empty rather than filled with something that is not one.
 */
function addressRef(context: StatusContext): OnChainRef {
  return {
    chainId: context.origin.chainId,
    txHash: "",
    explorerUrl: `${context.origin.explorer}/address/${context.depositAddress}`,
  };
}

function stellarRef(reported: ChainTx | undefined, context: StatusContext): OnChainRef | undefined {
  if (reported === undefined) return undefined;
  const path = context.network === "mainnet" ? "public" : "testnet";
  return {
    chainId: context.delivered.chainId,
    txHash: reported.hash,
    explorerUrl:
      reported.explorerUrl !== ""
        ? reported.explorerUrl
        : `https://stellar.expert/explorer/${path}/tx/${reported.hash}`,
  };
}

function expectedBy(reply: StatusReply): number {
  const updated = parseUnix(reply.updatedAt);
  return updated === undefined ? 0 : updated + Math.ceil(reply.quote.timeEstimate);
}

function parseUnix(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}
