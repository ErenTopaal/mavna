import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Connection, connect, type DiscoveredWallet, watchWallets } from "@/lib/wallet";

/**
 * Choosing a source-chain wallet.
 *
 * Wallets list themselves rather than being listed by us, so this shows whatever
 * the browser actually has instead of a curated set with an "other" at the
 * bottom. A user with one wallet installed sees one button and never a chooser.
 */

export interface ConnectWalletProps {
  readonly connection: Connection | undefined;
  /** Named in the empty state, because "another chain" is not where they are. */
  readonly chainName: string;
  readonly onConnect: (connection: Connection) => void;
  readonly onDisconnect: () => void;
}

export function ConnectWallet({
  connection,
  chainName,
  onConnect,
  onDisconnect,
}: ConnectWalletProps) {
  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([]);
  const [connecting, setConnecting] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => watchWallets(setWallets), []);

  async function pick(wallet: DiscoveredWallet) {
    setConnecting(wallet.info.uuid);
    setProblem(undefined);
    try {
      onConnect(await connect(wallet));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That wallet did not connect.");
    } finally {
      setConnecting(undefined);
    }
  }

  if (connection !== undefined) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <img src={connection.info.icon} alt="" aria-hidden className="size-5 rounded" />
        <span className="font-medium">{connection.info.name}</span>
        <span className="text-muted-foreground tabular-nums">{shorten(connection.address)}</span>
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No wallet found in this browser. Install one to send from {chainName}.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {wallets.map((wallet) => (
          <Button
            key={wallet.info.uuid}
            variant="outline"
            disabled={connecting !== undefined}
            onClick={() => void pick(wallet)}
          >
            {/* The icon is a data URI the wallet supplied. Rendered as an image
                and never as markup, because it is somebody else's string. */}
            <img src={wallet.info.icon} alt="" aria-hidden className="size-4 rounded" />
            {connecting === wallet.info.uuid ? "Waiting for you…" : wallet.info.name}
          </Button>
        ))}
      </div>
      {problem === undefined ? null : <p className="text-sm text-destructive">{problem}</p>}
    </div>
  );
}

/** Both ends kept, because the middle is what nobody checks and the ends are what they do. */
function shorten(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
