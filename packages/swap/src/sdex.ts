import { MavnaError, type NetworkId } from "@mavna/core";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { Asset, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  applySlippage,
  type SwapProvider,
  type SwapQuote,
  type SwapQuoteRequest,
} from "./provider.js";

/**
 * Stellar's own exchange, as a swap provider.
 *
 * This is the one venue whose execution needs no research and no third party: a
 * classic path payment is a single operation the network itself routes, and the
 * quote comes from Horizon's path finding, which is the only path finding that
 * exists (every candidate RPC method answers "method not found"; the owner
 * lifted the Horizon prohibition for exactly this).
 *
 * It is also the only venue executable on testnet today. Soroswap indexes no
 * testnet markets at all, and Aquarius quotes through Soroban pools whose router
 * calldata is its own integration. The orderbook makes "receive an asset other
 * than the bridge delivers" real now rather than pending.
 *
 * The known limit is stated by the type: a classic path payment cannot deliver
 * to a contract address, and `isClassicPathPayment: true` is how callers know.
 */

interface HorizonPathRecord {
  readonly destination_amount?: string;
  readonly path?: readonly {
    readonly asset_type: string;
    readonly asset_code?: string;
    readonly asset_issuer?: string;
  }[];
}

/** `CODE:ISSUER`, or `native` for XLM. The identity form, never a bare code. */
function parseAsset(id: string): Asset {
  if (id === "native" || id === "XLM") return Asset.native();
  const [code, issuer] = id.split(":");
  if (code === undefined || issuer === undefined || issuer === "") {
    throw new MavnaError(
      `An asset here is CODE:ISSUER or native, got "${id}". A bare code is not an ` +
        "identity: anyone can issue an asset with any name.",
      { retryable: false },
    );
  }
  return new Asset(code, issuer);
}

/** Base units (7 decimals) to Horizon's decimal string form. */
function toDecimal(baseUnits: string): string {
  const value = BigInt(baseUnits);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

function toBaseUnits(decimal: string): string {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return (BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7))).toString();
}

export class SdexProvider implements SwapProvider {
  readonly id = "sdex";
  readonly network: NetworkId;
  /** No mechanism exists here at all; the orderbook takes no fee parameter. */
  readonly canCollectIntegratorFee = false;

  private readonly horizonUrl: string;

  constructor(network: NetworkId, horizonUrl?: string) {
    this.network = network;
    this.horizonUrl = (
      horizonUrl ??
      (network === "mainnet"
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org")
    ).replace(/\/$/, "");
  }

  async isUsable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.horizonUrl}/`, {
        signal: AbortSignal.timeout(8_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async quote(request: SwapQuoteRequest): Promise<SwapQuote> {
    if (request.destinationKind === "contract") {
      // Not a maybe: the operation cannot address a contract, and finding out at
      // build time would be finding out after the bridge leg was already priced.
      throw new MavnaError("Stellar's orderbook delivers to accounts, not contract addresses.", {
        retryable: false,
      });
    }

    const sendAsset = parseAsset(request.assetIn);
    const destAsset = parseAsset(request.assetOut);

    const params = new URLSearchParams({
      source_amount: toDecimal(request.amountIn),
      destination_assets: destAsset.isNative()
        ? "native"
        : `${destAsset.getCode()}:${destAsset.getIssuer()}`,
    });
    if (sendAsset.isNative()) {
      params.set("source_asset_type", "native");
    } else {
      params.set(
        "source_asset_type",
        sendAsset.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      );
      params.set("source_asset_code", sendAsset.getCode());
      // Non-native by the branch above, so the issuer exists; the type cannot see that.
      params.set("source_asset_issuer", sendAsset.getIssuer() ?? "");
    }

    const response = await fetch(`${this.horizonUrl}/paths/strict-send?${params.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new MavnaError(`Stellar's exchange could not be read (HTTP ${response.status}).`, {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as {
      _embedded?: { records?: readonly HorizonPathRecord[] };
    };
    // Horizon returns candidates best-first; the head is the best executable path.
    const best = body._embedded?.records?.[0];
    if (best?.destination_amount === undefined) {
      throw new MavnaError("Stellar's exchange has no path between these assets right now.", {
        retryable: true,
      });
    }

    const amountOut = toBaseUnits(best.destination_amount);
    return {
      provider: this.id,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: request.amountIn,
      amountOut,
      amountOutMinimum: applySlippage(amountOut, request.maxSlippageBps),
      venues: ["sdex"],
      isClassicPathPayment: true,
      raw: best,
    };
  }
}

export interface PathPaymentInputs {
  readonly networkPassphrase: string;
  /** The account converting its own money, already loaded for its sequence. */
  readonly account: Account;
  readonly quote: SwapQuote;
  readonly feeStroops?: string;
}

/**
 * Turn an orderbook quote into the transaction that executes it.
 *
 * Strict-send with the user's own account on both ends: they convert what just
 * arrived into what they asked for, and the floor is the minimum their slippage
 * choice allows. If the market has moved past that floor the operation fails
 * whole and they keep the arrived asset, which is the safe direction to fail.
 */
export function buildPathPayment(inputs: PathPaymentInputs): Transaction {
  const quote = inputs.quote;
  if (!quote.isClassicPathPayment) {
    throw new MavnaError(
      "This quote routes through contracts, and this builder only executes the " +
        "orderbook. Build it with the venue that quoted it.",
      { retryable: false },
    );
  }

  const record = quote.raw as HorizonPathRecord;
  const path = (record.path ?? []).map((hop) =>
    hop.asset_type === "native"
      ? Asset.native()
      : new Asset(hop.asset_code ?? "", hop.asset_issuer ?? ""),
  );

  return new TransactionBuilder(inputs.account, {
    fee: inputs.feeStroops ?? "1000000",
    networkPassphrase: inputs.networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: parseAsset(quote.assetIn),
        sendAmount: toDecimal(quote.amountIn),
        destination: inputs.account.accountId(),
        destAsset: parseAsset(quote.assetOut),
        destMin: toDecimal(quote.amountOutMinimum),
        path,
      }),
    )
    .setTimeout(120)
    .build();
}
