import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { RpcClient } from "./rpc.js";

/**
 * What an account can spend from its XLM without dropping below its minimum
 * balance, in stroops.
 *
 * The minimum is two base reserves for the account itself plus one per
 * subentry, plus one per reserve it sponsors for others, less one per reserve
 * others sponsor for it; XLM promised to open offers is not spendable either.
 * This is the protocol's own arithmetic, read from the account entry rather
 * than estimated, because a trustline opened from too small a balance fails on
 * the network after the user has already signed.
 */
export function spareStroops(entry: xdr.AccountEntry, baseReserveStroops: number): bigint {
  let selling = 0n;
  let sponsoring = 0;
  let sponsored = 0;
  if (entry.ext.type === "v1") {
    const v1 = entry.ext.v1;
    selling = v1.liabilities.selling;
    if (v1.ext.type === "v2") {
      sponsoring = v1.ext.v2.numSponsoring;
      sponsored = v1.ext.v2.numSponsored;
    }
  }
  const slots = BigInt(2 + entry.numSubEntries + sponsoring - sponsored);
  const minimum = slots * BigInt(baseReserveStroops);
  return entry.balance - minimum - selling;
}

/** The account's ledger entry, or undefined when the account does not exist. */
export async function readAccountEntry(
  rpc: RpcClient,
  address: string,
): Promise<xdr.AccountEntry | undefined> {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const ledgerKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
  const entries = await rpc.read(`account ${address}`, async () => {
    const response = await rpc.server.getLedgerEntries(ledgerKey);
    return { value: response.entries, ledger: response.latestLedger };
  });
  for (const entry of entries) {
    if (entry.val.type === "account") return entry.val.account;
  }
  return undefined;
}
