import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import type { NetworkId } from "@mavna/core";
import { asError } from "./helpers";

/**
 * The Stellar side of signing, through the kit and its own modal.
 *
 * The kit rather than per-wallet integrations, and the kit's own modal rather
 * than a chooser of ours, both because the specification says so and for the
 * reason it gives: a user should meet the connection interface they already
 * recognise from every other Stellar product, and this project should not be
 * maintaining six wallet integrations that each drift on their own schedule.
 *
 * Two of the spec's named wallets are absent, stated rather than hidden:
 * WalletConnect needs a project identifier from a human signup nobody has done,
 * and Ledger and Trezor are hardware paths that cannot be exercised here. The
 * kit makes adding each a one-line module when they arrive.
 *
 * Every method verified against the installed package's own declarations:
 * version 2.5.0 is a static class, `authModal()` opens the modal and returns
 * the address, and `signTransaction` returns `{ signedTxXdr }`, an object.
 *
 * Bound to a network by `createStellarWallet` rather than reading a module-level
 * constant, so the same code serves a widget an integrator configures for either
 * network. The passphrase is passed explicitly on every sign for the same reason
 * the app has always passed it: a wallet pointed at the wrong network will sign a
 * perfectly valid transaction for a chain the user is not looking at.
 */

export interface StellarWalletApi {
  /** Open the kit's own modal and return the connected address. */
  connect(): Promise<string>;
  /** Sign one transaction with whatever wallet the user picked. */
  sign(xdr: string, address: string): Promise<string>;
  disconnect(): Promise<void>;
  /**
   * Drop a remembered connection without disconnecting the wallet, so the next
   * connect asks it again. Present on the engine's own wrapper.
   */
  forget?(): void;
}

const PASSPHRASE: Readonly<Record<NetworkId, string>> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

/**
 * A Stellar wallet interface bound to one network.
 *
 * The kit is a static singleton in the installed version, so two engines on one
 * page configured for different networks would share it; that is not a case the
 * product has (a page runs one network), and it is called out here rather than
 * papered over.
 */
export function createStellarWallet(network: NetworkId): StellarWalletApi {
  let initialised = false;

  const ensureInit = (): void => {
    if (initialised) return;
    StellarWalletsKit.init({
      modules: [
        new FreighterModule(),
        new xBullModule(),
        new AlbedoModule(),
        new LobstrModule(),
        new HanaModule(),
        new RabetModule(),
      ],
      network: network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    });
    initialised = true;
  };

  return {
    async connect(): Promise<string> {
      ensureInit();
      try {
        const { address } = await StellarWalletsKit.authModal();
        return address;
      } catch (cause) {
        // the kit rejects with plain objects; their message is the wallet's reason
        throw asError(cause);
      }
    },
    async sign(xdr: string, address: string): Promise<string> {
      ensureInit();
      try {
        const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
          address,
          networkPassphrase: PASSPHRASE[network],
        });
        return signedTxXdr;
      } catch (cause) {
        throw asError(cause);
      }
    },
    async disconnect(): Promise<void> {
      if (!initialised) return;
      await StellarWalletsKit.disconnect();
    },
  };
}
