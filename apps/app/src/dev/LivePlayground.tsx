import { explorerTxUrl } from "@mavna/adapter-cctp";
import type { Asset, Route, StepPhase } from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import { TransferPanel } from "@mavna/widget";
import { type ReactElement, useState } from "react";
import { ConnectWallet } from "@/components/ConnectWallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { execute } from "@/lib/execute";
import { remember } from "@/lib/history";
import {
  breaker,
  cctp,
  DEFAULT_SOURCE_CHAIN,
  NETWORK,
  STELLAR_CHAIN_ID,
  sourceChainDetail,
} from "@/lib/mavna";
import { useTheme } from "@/lib/theme";
import type { Connection } from "@/lib/wallet";

/**
 * The widget, driven for real, exactly as an integrator would drive it.
 *
 * This is the difference between a gallery and a playground. The states page
 * above renders fixtures, which proves the design; this one quotes Circle, reads
 * Stellar, and hands `onConfirm` to a wallet the host supplies, which proves the
 * component.
 *
 * The signing interface comes from the host and not from the widget, which is
 * the whole resolution of the size-budget conflict: the standard Stellar wallet
 * library floors at roughly 39 kB against a 12 kB budget, so the widget cannot
 * carry one and the design rules already say it must not impose one on a product
 * that has its own. Here the app is the host, and this file is all the glue an
 * integrator would have to write.
 */

const USDC_DECIMALS_ON_EVM = 6;
const USDC_DECIMALS_ON_STELLAR = 7;

const STELLAR_USDC_ISSUER =
  NETWORK === "mainnet"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function LivePlayground(): ReactElement {
  const theme = useTheme();
  const [amount, setAmount] = useState("1");
  const [destination, setDestination] = useState("");
  const [route, setRoute] = useState<Route | undefined>(undefined);
  const [connection, setConnection] = useState<Connection | undefined>(undefined);
  const [phase, setPhase] = useState<StepPhase>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const chainId = DEFAULT_SOURCE_CHAIN;
  const chain = sourceChainDetail(chainId);

  async function quote() {
    setBusy(true);
    setProblem(undefined);
    setRoute(undefined);
    setPhase({ phase: "idle" });
    try {
      const from: Asset = {
        chainId,
        id: chainId,
        symbol: "USDC",
        decimals: USDC_DECIMALS_ON_EVM,
        curatedBy: "Circle",
      };
      const to: Asset = {
        chainId: STELLAR_CHAIN_ID,
        id: `USDC:${STELLAR_USDC_ISSUER}`,
        symbol: "USDC",
        decimals: USDC_DECIMALS_ON_STELLAR,
        curatedBy: "Circle",
      };
      const result = await raceAdapters(
        [cctp],
        {
          from,
          to,
          sends: { asset: from, baseUnits: toBaseUnits(amount, USDC_DECIMALS_ON_EVM) },
          destination: destination.trim(),
          maxSlippageBps: 50,
        },
        { breaker },
      );
      const first = result.routes[0];
      if (first === undefined) {
        setProblem(result.rejected[0]?.explanation ?? "No route was offered for that.");
        return;
      }
      setRoute(first);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That quote did not come back.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * What the widget calls when the user presses its own confirm control.
   *
   * The widget knows nothing about wallets, chains or signatures. It reports that
   * the user said yes, and everything after that is the host's problem, which is
   * exactly the boundary an integrator inherits.
   */
  async function confirm() {
    if (connection === undefined || route === undefined || chain.kind !== "evm") return;
    setBusy(true);
    setProblem(undefined);
    try {
      // Blocked, not pending. Nothing is on chain yet, and `pending` requires a
      // transaction to point at: the type refuses to let this claim otherwise,
      // which is the invariant doing its job rather than getting in the way.
      setPhase({
        phase: "blocked",
        blocked: { kind: "needs-signature", signaturesRemaining: route.signaturesRequired },
      });
      const transactions = await cctp.buildTransactions(route);
      const hashes = await execute({
        connection,
        route,
        transactions,
        chainName: chain.name,
        evmChainId: chain.evmChainId,
        nativeCurrency: chain.nativeCurrency,
        onEvent: (event) => {
          if (event.kind === "confirmed") {
            // Now there is something to point at, so pending is honest.
            setPhase({
              phase: "pending",
              // The explorer link is required by the type, which is the point:
              // a step that has a transaction must be able to show it.
              ref: {
                chainId,
                txHash: event.hash,
                explorerUrl: explorerTxUrl(NETWORK, chainId, event.hash),
              },
              expectedByUnix: Math.floor(Date.now() / 1000) + route.estimatedSeconds,
            });
          }
        },
      });

      const burnHash = hashes.at(-1);
      if (burnHash === undefined) {
        setProblem("Nothing was sent.");
        return;
      }

      remember({
        sourceTxHash: burnHash,
        sourceChainId: chainId,
        sourceChainName: chain.name,
        destination: route.destination,
        sendsBaseUnits: route.sends.baseUnits,
        symbol: route.sends.asset.symbol,
        decimals: route.sends.asset.decimals,
        startedAtUnix: Math.floor(Date.now() / 1000),
        explorerUrl: explorerTxUrl(NETWORK, chainId, burnHash),
      });

      // The burn is on chain; the mint follows once Circle attests. Asking the
      // adapter rather than assuming means the scale shows what is true rather
      // than a hopeful "done" the moment the wallet stops asking.
      setPhase(
        await cctp.status({
          sourceTxHash: burnHash,
          sourceChainId: chainId,
          depositAddress: undefined,
          destinationAddress: route.destination,
        }),
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The transfer did not go through.");
      setPhase({ phase: "idle" });
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (route === undefined) return;
    setPhase(
      await cctp.status({
        sourceTxHash: undefined,
        sourceChainId: chainId,
        depositAddress: undefined,
        destinationAddress: route.destination,
      }),
    );
  }

  return (
    <section className="mb-12">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Live, against the test network
      </h2>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void quote();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="pg-amount">Amount</Label>
              <Input
                id="pg-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pg-destination">Stellar address</Label>
              <Input
                id="pg-destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="G…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Button type="submit" disabled={busy || destination.trim() === ""}>
                {busy ? "Working…" : "Quote it"}
              </Button>
            </div>
          </form>

          <ConnectWallet
            connection={connection}
            chainName={chain.name}
            onConnect={setConnection}
            onDisconnect={() => setConnection(undefined)}
          />

          {problem === undefined ? null : <p className="text-sm text-destructive">{problem}</p>}

          {route === undefined ? null : (
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Check on it
            </Button>
          )}
        </div>

        <div>
          {route === undefined ? (
            <p className="text-sm text-muted-foreground">
              Quote a transfer to see the widget drive a real one.
            </p>
          ) : (
            // One panel, which renders the scale itself. A second copy beside it
            // showed the same thing twice and made the page read as two transfers.
            <TransferPanel
              route={route}
              // Undefined until something has actually happened. The panel treats
              // any steps at all as "this has started" and hides its own confirm
              // control, so passing them upfront leaves nothing to press.
              steps={
                phase.phase === "idle"
                  ? undefined
                  : [{ id: "bridge", label: "Move your funds to Stellar", phase }]
              }
              outcome={phase.phase === "done" ? "succeeded" : "in-flight"}
              onConfirm={connection === undefined ? undefined : () => void confirm()}
              onRemedy={undefined}
              theme={theme}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** Decimal text to integer base units, without going through a float. */
function toBaseUnits(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return "0";
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}
