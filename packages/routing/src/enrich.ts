import {
  type Amount,
  type Asset,
  amountOf,
  MavnaError,
  type Route,
  type RouteRejection,
} from "@mavna/core";

/**
 * The slice of the exchange layer this module needs, stated structurally.
 *
 * `@mavna/swap` exports the real providers, and they satisfy this shape without
 * routing depending on that package: routing is consumed by everything and the
 * fewer packages it drags, the fewer every integrator inherits. Structural
 * typing keeps the seam honest, because a provider that stops fitting stops
 * compiling at the call site that passes it.
 */
export interface SwapQuoter {
  readonly id: string;
  quote(request: {
    readonly assetIn: string;
    readonly assetOut: string;
    readonly amountIn: string;
    readonly maxSlippageBps: number;
    readonly destinationKind: "account" | "contract";
  }): Promise<{
    readonly provider: string;
    readonly amountOut: string;
    readonly amountOutMinimum: string;
  }>;
}

/**
 * What happens to a route between the rail quoting it and the user seeing it.
 *
 * Two transformations live here, and both exist because a rail only knows its
 * own leg. A bridge delivers what it delivers; converting that into what the
 * user actually asked for is the exchange layer's job, and taking the
 * integrator's cut is the aggregator's. Neither belongs inside an adapter,
 * because every adapter would have to repeat them and repeating them is how they
 * drift apart.
 */

export interface SwapAttachment {
  readonly provider: SwapQuoter;
  /**
   * What the rails deliver on Stellar, with the contract address the exchange
   * layer trades it under. `asset.id` is `CODE:ISSUER`, which identifies it to a
   * person; the contract form is what the venues actually quote.
   */
  readonly delivered: Asset;
  readonly deliveredContract: string;
  /** What the user asked to end up holding. */
  readonly wanted: Asset;
  readonly wantedContract: string;
}

/**
 * Attach the conversion leg to a route that arrives in the wrong asset.
 *
 * The rail was asked to deliver its own asset, so `route.receives` is the
 * bridged amount. This turns it into the asset the user chose, at a real quote
 * from the exchange layer, with the floor bounded by the slippage the user
 * picked. A pair the exchange cannot serve becomes a rejection with the reason,
 * never a route that quietly delivers something the user did not ask for.
 */
export async function attachSwapLeg(
  route: Route,
  attachment: SwapAttachment,
  maxSlippageBps: number,
): Promise<Route | RouteRejection> {
  let quote: Awaited<ReturnType<SwapQuoter["quote"]>>;
  try {
    quote = await attachment.provider.quote({
      assetIn: attachment.deliveredContract,
      assetOut: attachment.wantedContract,
      amountIn: route.receives.baseUnits,
      maxSlippageBps,
      destinationKind: route.destination.startsWith("C") ? "contract" : "account",
    });
  } catch (cause) {
    return {
      source: route.source,
      reason: "no-liquidity",
      // An unknown failure is assumed worth asking about again; a provider that
      // says it is permanent is believed.
      retryable: cause instanceof MavnaError ? cause.retryable : true,
      explanation:
        `This route can bring your money to Stellar, but converting it into ` +
        `${attachment.wanted.symbol} is not possible right now.`,
    };
  }

  const receives: Amount = amountOf(attachment.wanted, quote.amountOut);
  const receivesAtLeast: Amount = amountOf(attachment.wanted, quote.amountOutMinimum);

  return {
    ...route,
    receives,
    receivesAtLeast,
    steps: [
      ...route.steps,
      {
        id: `${route.id}-swap`,
        kind: "swap",
        source: quote.provider,
        from: route.receives,
        to: receives,
        // A Stellar transaction settles in one ledger close; the estimate covers
        // building and signing it, not waiting for a network.
        estimatedSeconds: 15,
        execution: undefined,
      },
    ],
    estimatedSeconds: route.estimatedSeconds + 15,
    // The conversion is its own transaction on Stellar, signed by the user.
    signaturesRequired: route.signaturesRequired + 1,
  };
}

export interface IntegratorFee {
  /** Basis points taken from what the user receives. Zero is a valid setting. */
  readonly bps: number;
  /** Who it goes to. Shown, because fees are itemised by recipient. */
  readonly recipient: string;
  readonly recipientName: string;
  /**
   * Whether anything in this route's transactions actually pays the fee out.
   * Required rather than defaulted so every caller decides: showing a fee that
   * nobody collects takes money off the headline and gives it to no one.
   */
  readonly collects: (route: Route) => boolean;
}

/**
 * Take the integrator's cut, visibly.
 *
 * Deducted from the receiving side and itemised, because the functional
 * requirements say fees are broken down so a user can see who is taking what,
 * and the headline number is what actually lands after all of them. The
 * plumbing runs even at zero basis points so that turning a fee on is a
 * configuration change rather than a code path nobody has exercised.
 */
export function applyIntegratorFee(route: Route, fee: IntegratorFee): Route {
  if (!Number.isInteger(fee.bps) || fee.bps < 0 || fee.bps > 1_000) {
    // Ten percent is already far beyond anything defensible; a typo like 300
    // meaning 3% is caught by the cap on the sanity of the number itself.
    throw new RangeError(`An integrator fee must be 0 to 1000 basis points, got ${fee.bps}.`);
  }

  if (!fee.collects(route)) return route;

  const takeFrom = (amount: Amount): { kept: Amount; taken: bigint } => {
    const base = BigInt(amount.baseUnits);
    // Rounded down, so the fee is never a stroop more than the rate promises.
    const taken = (base * BigInt(fee.bps)) / 10_000n;
    return { kept: amountOf(amount.asset, (base - taken).toString()), taken };
  };

  const receives = takeFrom(route.receives);
  const atLeast = takeFrom(route.receivesAtLeast);

  return {
    ...route,
    receives: receives.kept,
    receivesAtLeast: atLeast.kept,
    fees: [
      ...route.fees,
      {
        kind: "integrator",
        total: amountOf(route.receives.asset, receives.taken.toString()),
        recipients: [
          {
            name: fee.recipientName,
            amount: amountOf(route.receives.asset, receives.taken.toString()),
            address: fee.recipient,
          },
        ],
        includedInQuote: true,
      },
    ],
  };
}
