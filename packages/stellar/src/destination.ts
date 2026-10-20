import type { Asset } from "@stellar/stellar-sdk";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { classifyAddress } from "./address.js";
import { stroopsToXlm } from "./reserve.js";
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
  /**
   * A contract that exists on this network. Holds assets in contract storage, so
   * no account and no trustline.
   */
  | { readonly kind: "contract-ready"; readonly slotsNeeded: 0 }
  /** An account that can take this asset now. Nothing to do. */
  | { readonly kind: "ready"; readonly slotsNeeded: 0 }
  /** The account exists but cannot hold this asset yet. */
  | { readonly kind: "needs-trustline"; readonly slotsNeeded: 1 }
  /** Nothing exists. Needs the account, and the trustline unless the asset is XLM. */
  | { readonly kind: "needs-account"; readonly slotsNeeded: 2 | 3 }
  /**
   * The address cannot receive this value now: it cannot hold value at all, no
   * contract exists there, or its trustline is not authorised or has no room.
   */
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
        /** What it can still take: the limit, less the balance and pending buy offers. */
        readonly headroomStroops: string;
        readonly authorized: boolean;
      }
    | undefined;
}

/** Trustline flag bit meaning the issuer has authorised this account to hold the asset. */
const AUTHORIZED_FLAG = 1;

export interface InspectOptions {
  /**
   * The amount about to be sent, in stroops. When given, a trustline whose limit
   * cannot take it reads as unusable rather than ready.
   */
  readonly amountStroops?: bigint;
}

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
  options: InspectOptions = {},
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

  // Contracts hold assets in contract storage, so there is no account entry, no
  // trustline and no reserve. But an asset contract credits any contract address,
  // including one where nothing is deployed, and nothing can ever move funds out
  // of that. Contract ids also differ per network, so one copied from testnet is
  // empty on mainnet. Only an instance on this ledger makes the address usable.
  if (!classified.needsTrustline) {
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(address).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const instance = await client.read(`contract ${address}`, async () => {
      const response = await client.server.getLedgerEntries(instanceKey);
      return { value: response.entries[0], ledger: response.latestLedger };
    });
    // A Stellar asset contract never authorises a transfer out of its own
    // balance, so pasting a token's id where the wallet's belongs loses the funds.
    const data = instance?.val;
    const isTokenItself =
      data?.type === "contractData" &&
      data.contractData.val.type === "scvContractInstance" &&
      data.contractData.val.instance.executable.type === "contractExecutableStellarAsset";
    let lane: DestinationLane;
    if (instance === undefined) {
      lane = {
        kind: "unusable",
        slotsNeeded: 0,
        reason: "No contract exists at that address on this network.",
      };
    } else if (isTokenItself) {
      lane = {
        kind: "unusable",
        slotsNeeded: 0,
        reason: "That is a token's contract, not a wallet: anything sent to it can never be moved.",
      };
    } else {
      lane = { kind: "contract-ready", slotsNeeded: 0 };
    }
    return { address, lane, account: undefined, trustline: undefined };
  }

  // A muxed address is a wrapper: the account entry and the trustline both belong
  // to the account underneath it.
  const holder = classified.trustlineHolder ?? address;
  const accountId = Keypair.fromPublicKey(holder).xdrAccountId();

  // an account holds XLM by existing; there is no trustline to look for
  const native = asset.isNative();
  const keys: xdr.LedgerKey[] = [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }))];
  if (!native) {
    keys.push(
      xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({ accountId, asset: asset.toTrustLineXdrObject() }),
      ),
    );
  }

  const entries = await client.read(`destination ${holder}`, async () => {
    const response = await client.server.getLedgerEntries(...keys);
    return { value: response.entries, ledger: response.latestLedger };
  });

  let account: DestinationState["account"];
  let trustline: DestinationState["trustline"];

  for (const entry of entries) {
    const data = entry.val;
    if (data.type === "account") {
      account = {
        balanceStroops: data.account.balance.toString(),
        subEntryCount: data.account.numSubEntries,
      };
    }
    if (data.type === "trustline") {
      const parsed = data.trustLine;
      // an open buy offer reserves room under the limit, so it counts against it
      const buying = parsed.ext.type === "v1" ? parsed.ext.v1.liabilities.buying : 0n;
      const balance = parsed.balance;
      const limit = parsed.limit;
      trustline = {
        balanceStroops: balance.toString(),
        limitStroops: limit.toString(),
        headroomStroops: (limit - balance - buying).toString(),
        authorized: (parsed.flags & AUTHORIZED_FLAG) !== 0,
      };
    }
  }

  const code = native ? "XLM" : asset.getCode();
  let lane: DestinationLane;
  if (account === undefined) {
    lane = { kind: "needs-account", slotsNeeded: native ? 2 : 3 };
  } else if (native) {
    lane = { kind: "ready", slotsNeeded: 0 };
  } else if (trustline === undefined) {
    lane = { kind: "needs-trustline", slotsNeeded: 1 };
  } else if (!trustline.authorized) {
    lane = {
      kind: "unusable",
      slotsNeeded: 0,
      reason: `The issuer of ${code} has not authorised that account to hold it.`,
    };
  } else {
    const headroom = BigInt(trustline.headroomStroops);
    const needed = options.amountStroops ?? 1n;
    lane =
      headroom >= needed
        ? { kind: "ready", slotsNeeded: 0 }
        : {
            kind: "unusable",
            slotsNeeded: 0,
            reason:
              headroom <= 0n
                ? `That account's ${code} trustline is at its limit, so it cannot take more until the limit is raised.`
                : `That account's ${code} trustline limit has room for only ${stroopsToXlm(headroom)} ${code} more.`,
          };
  }

  return { address, lane, account, trustline };
}
