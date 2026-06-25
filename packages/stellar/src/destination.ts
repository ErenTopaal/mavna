import type { Asset } from "@stellar/stellar-sdk";
import { Address, xdr } from "@stellar/stellar-sdk";
import { classifyAddress } from "./address.js";
import type { RpcClient } from "./rpc.js";

/**
 * What a destination needs before value can be sent to it. This is the single
 * most valuable check in the product: three of these six lanes cost nothing, and
 * the routing layer must know which it is in before it quotes.
 *
 * Costs are in reserve slots at 0.5 XLM each, measured on-chain: an account
 * occupies 2 slots and each trustline occupies 1.
 */
export type DestinationLane =
  /** A contract. Holds assets in contract storage, so no account and no trustline. */
  | { readonly kind: "contract-ready"; readonly slotsNeeded: 0 }
  /** An account that already holds this asset. Nothing to do. */
  | { readonly kind: "ready"; readonly slotsNeeded: 0 }
  /** The account exists but cannot hold this asset yet. */
  | { readonly kind: "needs-trustline"; readonly slotsNeeded: 1 }
  /** Nothing exists. Needs the account and the trustline. */
  | { readonly kind: "needs-account"; readonly slotsNeeded: 3 }
  /** The address cannot receive value at all. */
  | { readonly kind: "unusable"; readonly slotsNeeded: 0; readonly reason: string };

export interface DestinationState {
  readonly address: string;
  readonly lane: DestinationLane;
  /** Present only when an ordinary account exists. */
  readonly account: { readonly balanceStroops: string; readonly subEntryCount: number } | undefined;
  /** Present only when a trustline for the asset exists. */
  readonly trustline:
    | {
        readonly balanceStroops: string;
        readonly limitStroops: string;
        readonly authorized: boolean;
      }
    | undefined;
}

/** Trustline flag bit meaning the issuer has authorised this account to hold the asset. */
const AUTHORIZED_FLAG = 1;

/**
 * Inspect a destination in a single round trip, answering both "does this account
 * exist" and "can it hold this asset".
 *
 * Absence is only believed when it comes from a node at or past our high-water
 * mark. A lagging node's silence is indistinguishable from a genuinely missing
 * account, so the read guard is what makes this answer trustworthy.
 */
export async function inspectDestination(
  client: RpcClient,
  address: string,
  asset: Asset,
): Promise<DestinationState> {
  const classified = classifyAddress(address);

  if (!classified.canReceive) {
    return {
      address,
      lane: {
        kind: "unusable",
        slotsNeeded: 0,
        reason: `A ${classified.kind} address cannot receive a payment.`,
      },
      account: undefined,
      trustline: undefined,
    };
  }

  // Contracts hold assets in contract storage. No account entry, no trustline,
  // no reserve, nothing to prepare.
  if (!classified.needsTrustline) {
    return {
      address,
      lane: { kind: "contract-ready", slotsNeeded: 0 },
      account: undefined,
      trustline: undefined,
    };
  }

  // A muxed address is a wrapper: the account entry and the trustline both belong
  // to the account underneath it.
  const holder = classified.trustlineHolder ?? address;
  const accountId = Address.fromString(holder).toScAddress().accountId();

  const accountKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
  const trustlineKey = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId, asset: asset.toTrustLineXDRObject() }),
  );

  const entries = await client.read(`destination ${holder}`, async () => {
    const response = await client.server.getLedgerEntries(accountKey, trustlineKey);
    return { value: response.entries, ledger: response.latestLedger };
  });

  let account: DestinationState["account"];
  let trustline: DestinationState["trustline"];

  for (const entry of entries) {
    const data = entry.val;
    if (data.switch().name === "account") {
      const parsed = data.account();
      account = {
        balanceStroops: parsed.balance().toString(),
        subEntryCount: parsed.numSubEntries(),
      };
    }
    if (data.switch().name === "trustline") {
      const parsed = data.trustLine();
      trustline = {
        balanceStroops: parsed.balance().toString(),
        limitStroops: parsed.limit().toString(),
        authorized: (parsed.flags() & AUTHORIZED_FLAG) !== 0,
      };
    }
  }

  const lane: DestinationLane =
    account === undefined
      ? { kind: "needs-account", slotsNeeded: 3 }
      : trustline === undefined
        ? { kind: "needs-trustline", slotsNeeded: 1 }
        : { kind: "ready", slotsNeeded: 0 };

  return { address, lane, account, trustline };
}
