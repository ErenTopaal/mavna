import { AnchorIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { NETWORK, RPC_IS_A_DEFAULT } from "@/lib/mavna";

/**
 * The frame every page sits in.
 *
 * The one thing this must never be coy about is which network is live. The plan
 * calls for it to be unmistakable at all times, so it is a bar across the top in
 * the signal colour rather than a chip somewhere in a corner: on a test network
 * the money is not real, and a user who mistakes one for the other has either
 * wasted their time or lost their funds.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {NETWORK === "testnet" ? (
        <p className="bg-destructive/10 px-4 py-1.5 text-center text-xs font-medium text-destructive">
          Test network. Nothing here is real money.
        </p>
      ) : null}

      {/* On mainnet the money is real, and an endpoint nobody chose is a party
          this product depends on without having said so. It gets one line rather
          than a dismissible banner, because a warning that can be dismissed is a
          warning nobody has read. */}
      {NETWORK === "mainnet" && RPC_IS_A_DEFAULT ? (
        <p className="bg-destructive/10 px-4 py-1.5 text-center text-xs font-medium text-destructive">
          Reading Stellar through a public node nobody here chose. Set your own before sending.
        </p>
      ) : null}

      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <HugeiconsIcon icon={AnchorIcon} className="size-5" aria-hidden />
            <span className="font-heading text-base font-semibold tracking-tight">Mavna</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link to="/" className="hover:text-foreground [&.active]:text-foreground">
              Send
            </Link>
            <Link to="/track" className="hover:text-foreground [&.active]:text-foreground">
              Find
            </Link>
            <Link to="/dev/widget" className="hover:text-foreground [&.active]:text-foreground">
              Widget
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>

      <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-muted-foreground">
        Mavna moves value onto Stellar from wherever it already is.
      </footer>
    </div>
  );
}
