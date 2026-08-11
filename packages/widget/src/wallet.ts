import type { NativeCurrency } from "@mavna/adapter-cctp";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";

/**
 * Talking to a source-chain wallet, without a connection library.
 *
 * EIP-6963 is the reason no library is needed. Before it, every wallet fought
 * over the single `window.ethereum` slot and whoever loaded last won, which is
 * why connection libraries exist at all. Now each extension announces itself on
 * an event with its own name, icon and provider, so discovery is a listener and
 * a few lines rather than a dependency with a list of wallets in it.
 *
 * That matters beyond bundle size: a hardcoded wallet list is a list that goes
 * stale, and a wallet not on it cannot be used no matter how standard it is.
 * Announcing wallets appear here the day they ship.
 *
 * Reads go through the connected wallet's own provider rather than an endpoint we
 * choose. It is already talking to a node the user trusts, and it means this app
 * ships no RPC URL of its own for any of the twenty-four chains it supports.
 */

/** What a wallet tells us about itself when it announces. */
export interface WalletInfo {
  readonly uuid: string;
  readonly name: string;
  /** A data URI, per the standard. Rendered as an image, never as markup. */
  readonly icon: string;
  readonly rdns: string;
}

export interface DiscoveredWallet {
  readonly info: WalletInfo;
  readonly provider: EIP1193Provider;
}

interface AnnounceEvent extends Event {
  readonly detail: DiscoveredWallet;
}

/**
 * Watch for wallets announcing themselves.
 *
 * Returns a function that stops watching. Announcements arrive whenever asked
 * for, and a wallet installed mid-session announces on its own, so this stays
 * subscribed rather than taking one snapshot.
 */
export function watchWallets(onChange: (wallets: readonly DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>();

  const announce = (event: Event): void => {
    const detail = (event as AnnounceEvent).detail;
    if (detail?.info?.uuid === undefined) return;
    // Keyed by uuid because a wallet announces again on every request, and
    // pushing each time would show the same wallet several times over.
    found.set(detail.info.uuid, detail);
    onChange([...found.values()]);
  };

  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", announce);
}

export interface Connection {
  readonly info: WalletInfo;
  readonly address: Address;
  readonly chainId: number;
  readonly wallet: WalletClient;
  readonly reader: PublicClient;
  /**
   * Kept alongside the clients because switching chains is a wallet request, not
   * a chain call, and viem's transport is not the provider that answers it.
   */
  readonly provider: EIP1193Provider;
}

/**
 * Ask a wallet who is using it, and make the wallet actually respond.
 *
 * `eth_requestAccounts` alone is silent once a site has been authorized before:
 * it resolves with the account and the wallet never opens, which reads as a
 * connect that did nothing. So this first asks for the account permission, which
 * makes the wallet show its own account-selection UI every time, the connect
 * experience people expect. Not every wallet implements that method, so a
 * failure other than the user declining falls through to `eth_requestAccounts`,
 * which still prompts on the first connect.
 */
export async function connect(discovered: DiscoveredWallet): Promise<Connection> {
  try {
    await discovered.provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new Error("You did not connect the wallet, so nothing is connected.");
    }
    // Method not supported by this wallet; the request below still prompts.
  }

  const accounts = await discovered.provider.request({ method: "eth_requestAccounts" });
  const address = accounts[0];
  if (address === undefined) {
    throw new Error("That wallet did not offer an account. Unlock it and try again.");
  }

  const chainId = Number(await discovered.provider.request({ method: "eth_chainId" }));
  const transport = custom(discovered.provider);

  return {
    info: discovered.info,
    address,
    chainId,
    wallet: createWalletClient({ account: address, transport }),
    reader: createPublicClient({ transport }),
    provider: discovered.provider,
  };
}

/**
 * Move the wallet to the chain the transfer is on.
 *
 * A wallet pointed at the wrong chain does not fail loudly. It offers to sign
 * something addressed to a contract that is not there, and the money goes
 * wherever that address happens to lead on the chain it is actually on.
 *
 * Error 4902 means the chain is not in the wallet yet. Adding it needs an RPC URL
 * and a currency name we do not have for every chain, so this reports it plainly
 * rather than inventing an endpoint on the user's behalf.
 */
export async function switchChain(
  provider: EIP1193Provider,
  chainId: number,
  chainName: string,
): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  } catch (cause) {
    if (isUserRejection(cause))
      throw new Error("You did not switch networks, so nothing was sent.");
    if (codeOf(cause) === 4902) {
      throw new Error(`Add ${chainName} to your wallet first, then try again.`);
    }
    throw cause;
  }
}

/**
 * A minimal chain, since viem wants one to send a transaction and we have the id.
 *
 * The gas token comes from the verified chain registry rather than being assumed
 * to be ETH, which it is not on Avalanche, Polygon, Cronos or Sei. Where the
 * registry does not carry a chain, an unnamed 18-decimal unit is used: viem needs
 * the decimals to format a fee estimate, and leaving the symbol blank shows the
 * user no token name rather than the wrong one.
 */
export function chainFor(chainId: number, name: string, native: NativeCurrency | undefined): Chain {
  return {
    id: chainId,
    name,
    nativeCurrency: native ?? { name: "", symbol: "", decimals: 18 },
    // Left empty on purpose. Every request goes through the wallet's own
    // transport, so a URL here would be an endpoint nobody asked us to pick.
    rpcUrls: { default: { http: [] } },
  };
}

/** Wallets disagree on the shape of a rejection, so both forms are checked. */
export function isUserRejection(cause: unknown): boolean {
  const code = codeOf(cause);
  return code === 4001 || code === "ACTION_REJECTED";
}

function codeOf(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  const withCode = cause as { code?: unknown; cause?: { code?: unknown } };
  return withCode.code ?? withCode.cause?.code;
}
