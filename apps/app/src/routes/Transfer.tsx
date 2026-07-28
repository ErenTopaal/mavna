import { explorerTxUrl } from "@mavna/adapter-cctp";
import type { Asset, Route, RouteSet } from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import { RouteList, TransferPanel } from "@mavna/widget";
import { useState } from "react";
import { ConnectWallet } from "@/components/ConnectWallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ExecutionEvent, execute } from "@/lib/execute";
import { remember } from "@/lib/history";
import {
  breaker,
  cctp,
  DEFAULT_SOURCE_CHAIN,
  NETWORK,
  SOURCE_CHAINS,
  STELLAR_CHAIN_ID,
  sourceChainDetail,
} from "@/lib/mavna";
import { useTheme } from "@/lib/theme";
import type { Connection } from "@/lib/wallet";

/**
 * Ask for a quote, and show what came back.
 *
 * Everything on this page is real: the fee comes from Circle and the state of the
 * destination is read off Stellar through the freshness guard. Nothing is stubbed,
 * which is why the form asks for so little — an amount, a chain, and where it is
 * going is genuinely all that is needed to answer the question.
 */

const USDC_DECIMALS_ON_EVM = 6;
const USDC_DECIMALS_ON_STELLAR = 7;

/** The issuer is part of the asset's identity; a bare symbol is not one. */
const STELLAR_USDC_ISSUER =
  NETWORK === "mainnet"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function Transfer() {
  const [chainId, setChainId] = useState(DEFAULT_SOURCE_CHAIN);
  const [amount, setAmount] = useState("25");
  const [destination, setDestination] = useState("");
  const [routes, setRoutes] = useState<RouteSet | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  async function quote() {
    setAsking(true);
    setProblem(undefined);
    setRoutes(undefined);
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
        // Routes render as they land rather than all at once, so the wait reads as
        // progress instead of a spinner.
        { onUpdate: setRoutes, breaker },
      );
      setRoutes(result);
      setSelected(result.routes[0]?.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That did not work. Try again.");
    } finally {
      setAsking(false);
    }
  }

  const chosen = routes?.routes.find((r) => r.id === selected) ?? routes?.routes[0];
  // Told, not guessed. The widget follows the machine when nobody says, which is
  // right in someone else's page and wrong in ours.
  const theme = useTheme();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Send USDC to Stellar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          From {SOURCE_CHAINS.length} chains. You will see what arrives before you send anything.
        </p>
      </div>

      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void quote();
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="chain">From</Label>
          <Select
            value={chainId}
            // Base UI reports a cleared selection as null. Coercing it back to the
            // current value keeps a chain always chosen, since there is no such
            // thing as a transfer from nowhere.
            onValueChange={(value) => setChainId(value ?? chainId)}
          >
            <SelectTrigger id="chain">
              {/* Base UI renders the raw value here by default, which showed the
                  internal id. A user picks a chain by its name. */}
              <SelectValue placeholder="Pick a chain">
                {(value: unknown) =>
                  SOURCE_CHAINS.find((chain) => chain.id === value)?.name ?? "Pick a chain"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SOURCE_CHAINS.map((chain) => (
                <SelectItem key={chain.id} value={chain.id}>
                  {chain.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="amount">Amount</Label>
          <Input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="25"
          />
        </div>

        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="destination">To this Stellar address</Label>
          <Input
            id="destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="G…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={asking || destination.trim() === ""}>
            {asking ? "Asking…" : "Show me what arrives"}
          </Button>
        </div>
      </form>

      {problem === undefined ? null : <p className="text-sm text-destructive">{problem}</p>}

      {routes === undefined ? null : (
        <div className="space-y-8">
          {routes.routes.length > 1 || routes.rejected.length > 0 ? (
            <RouteList routes={routes} selectedId={selected} onSelect={setSelected} theme={theme} />
          ) : null}

          {chosen === undefined ? null : (
            <>
              <TransferPanel
                route={chosen}
                steps={undefined}
                outcome="in-flight"
                onConfirm={undefined}
                onRemedy={undefined}
                theme={theme}
              />
              <SendPanel route={chosen} chainId={chainId} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Turning a quote into a transfer.
 *
 * Separated from the quoting above because it is where consent happens, and
 * consent needs the user to see what they are about to do. Nothing here fires
 * until they press the button, and the button says what pressing it costs.
 */
function SendPanel({ route, chainId }: { route: Route; chainId: string }) {
  const [connection, setConnection] = useState<Connection | undefined>(undefined);
  const [events, setEvents] = useState<readonly ExecutionEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const chain = sourceChainDetail(chainId);

  if (chain.kind !== "evm") {
    return (
      <p className="text-sm text-muted-foreground">
        This page cannot sign for {chain.name} yet. The quote above is real, and so is the route,
        but sending needs a {chain.family} wallet.
      </p>
    );
  }

  async function send() {
    if (connection === undefined || chain.kind !== "evm") return;
    setSending(true);
    setProblem(undefined);
    setEvents([]);
    try {
      const transactions = await cctp.buildTransactions(route);
      const hashes = await execute({
        connection,
        route,
        transactions,
        chainName: chain.name,
        evmChainId: chain.evmChainId,
        nativeCurrency: chain.nativeCurrency,
        onEvent: (event) => setEvents((all) => [...all, event]),
      });
      // The burn is the last transaction and the one worth remembering: it is
      // the key every recovery path is keyed on. Written after it lands rather
      // than before, so nothing in history refers to a transfer that never
      // happened.
      const burnHash = hashes.at(-1);
      if (burnHash !== undefined) {
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
      }
      setDone(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The transfer did not go through.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4 border-t pt-6">
      <ConnectWallet
        connection={connection}
        chainName={chain.name}
        onConnect={setConnection}
        onDisconnect={() => setConnection(undefined)}
      />

      {connection === undefined ? null : (
        <Button onClick={() => void send()} disabled={sending || done}>
          {sending ? "Waiting for your wallet…" : done ? "Sent" : "Send from this wallet"}
        </Button>
      )}

      {events.length === 0 ? null : (
        <ol className="space-y-1 text-sm">
          {events.map((event) => (
            <li key={`${event.kind}-${event.index}`} className="text-muted-foreground">
              {describeEvent(event, chain.kind === "evm" ? chain.name : "")}
            </li>
          ))}
        </ol>
      )}

      {problem === undefined ? null : <p className="text-sm text-destructive">{problem}</p>}
    </div>
  );
}

/** One line per event, saying what happened rather than which call it was. */
function describeEvent(event: ExecutionEvent, chainName: string): string {
  switch (event.kind) {
    case "skipped":
      return event.why;
    case "awaiting-signature":
      return `Confirm in your wallet: ${event.describes}`;
    case "sent":
      return `Sent to ${chainName}. Waiting for it to be included.`;
    case "confirmed":
      return `Included: ${event.hash}`;
  }
}

/**
 * Decimal text to integer base units, without going through a float.
 *
 * `Number("0.1") * 1e6` is 100000.00000000001, and truncating that is how an
 * amount quietly loses its last unit. Everything here stays in strings.
 */
export function toBaseUnits(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return "0";

  const [whole = "0", fraction = ""] = trimmed.split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}
