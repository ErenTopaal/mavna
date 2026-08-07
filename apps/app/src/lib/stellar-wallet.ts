import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import { NETWORK } from "./mavna";

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
 */

let initialised = false;

function ensureInit(): void {
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
    network: NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  });
  initialised = true;
}

/** Open the kit's own modal and return the connected address. */
export async function connectStellarWallet(): Promise<string> {
  ensureInit();
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

/**
 * Sign one transaction with whatever wallet the user picked.
 *
 * The passphrase is passed explicitly on every call rather than trusted to the
 * wallet's own selector, because a wallet pointed at the wrong network signs a
 * perfectly valid transaction for a chain the user is not looking at.
 */
export async function signWithStellarWallet(xdr: string, address: string): Promise<string> {
  ensureInit();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    address,
    networkPassphrase:
      NETWORK === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
  });
  return signedTxXdr;
}

export async function disconnectStellarWallet(): Promise<void> {
  if (!initialised) return;
  await StellarWalletsKit.disconnect();
}
