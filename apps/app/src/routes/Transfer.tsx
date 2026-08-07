import { explorerTxUrl } from "@mavna/adapter-cctp";
import type { Asset, Route, RouteSet } from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import { buildPathPayment } from "@mavna/swap";
import { RouteList, TransferPanel } from "@mavna/widget";
import { TransactionBuilder } from "@stellar/stellar-sdk";
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
  ADAPTERS,
  breaker,
  cctp,
  DEFAULT_SOURCE_CHAIN,
  NETWORK,
  rpc,
  SOURCE_CHAINS,
  sdex,
  sourceChainDetail,
  sourceDomain,
  USDC_ON_STELLAR,
  XLM_ON_STELLAR,
  XLM_SWAP,
} from "@/lib/mavna";
import { requestDelivery, requestPreparation, sponsorIsUp, submitPreparation } from "@/lib/sponsor";
import { connectStellarWallet, signWithStellarWallet } from "@/lib/stellar-wallet";
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

export function Transfer() {
  const [chainId, setChainId] = useState(DEFAULT_SOURCE_CHAIN);
  const [wanted, setWanted] = useState<"USDC" | "XLM">("USDC");
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
      const to: Asset = wanted === "XLM" ? XLM_ON_STELLAR : USDC_ON_STELLAR;

      const result = await raceAdapters(
        ADAPTERS,
        {
          from,
          to,
          sends: { asset: from, baseUnits: toBaseUnits(amount, USDC_DECIMALS_ON_EVM) },
          destination: destination.trim(),
          maxSlippageBps: 50,
        },
        // Routes render as they land rather than all at once, so the wait reads as
        // progress instead of a spinner. When the user wants an asset the rails do
        // not deliver, the conversion leg is priced and attached per route here.
        {
          onUpdate: setRoutes,
          breaker,
          swap: wanted === "XLM" ? XLM_SWAP : undefined,
        },
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
          <Label htmlFor="wanted">Receive</Label>
          <Select
            value={wanted}
            onValueChange={(value) => setWanted((value as "USDC" | "XLM") ?? "USDC")}
          >
            <SelectTrigger id="wanted">
              <SelectValue placeholder="USDC" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USDC">USDC</SelectItem>
              <SelectItem value="XLM">XLM</SelectItem>
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
  const [stellarAddress, setStellarAddress] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<readonly ExecutionEvent[]>([]);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const chain = sourceChainDetail(chainId);
  const needsPreparing = route.steps.some((step) => step.kind === "prepare-account");
  const note = (text: string): void => setNotes((all) => [...all, text]);

  if (chain.kind !== "evm") {
    return (
      <p className="text-sm text-muted-foreground">
        This page cannot sign for {chain.name} yet. The quote above is real, and so is the route,
        but sending needs a {chain.family} wallet.
      </p>
    );
  }

  /**
   * Prove control of the destination and let it hold USDC, before anything burns.
   *
   * The account being prepared signs the operations that create obligations on
   * itself, so only its owner can do this. Someone sending to an address they do
   * not control is told so here, at the point of choosing, rather than after
   * their money is in flight and bouncing off an unprepared account.
   */
  async function prepareDestination(): Promise<void> {
    note("Connect the Stellar wallet that owns the receiving address.");
    const address = await connectStellarWallet();
    setStellarAddress(address);
    if (address !== route.destination) {
      throw new Error(
        "Only the owner of the receiving account can allow it to hold USDC. " +
          "Connect that wallet, or send to an address that can already receive.",
      );
    }

    note("Asking the sponsor to set the account up. Somebody else pays the deposit.");
    const preparation = await requestPreparation(route.destination, chainId);
    note("Approve this in your Stellar wallet. It costs you nothing.");
    const signed = await signWithStellarWallet(preparation.xdr, address);
    const submitted = await submitPreparation(signed);
    note(`Your account is ready. Included on Stellar: ${submitted.txHash}`);
  }

  /**
   * The last mile, ours to trigger because Circle's own forwarding service
   * cannot serve Stellar. Retrying is always safe: the transmitter refuses a
   * nonce it has already used, so a duplicate cannot mint twice.
   */
  async function deliverToStellar(burnHash: string): Promise<void> {
    const domain = sourceDomain(chainId);
    note("Waiting for Circle to attest the transfer. On this path that takes a few minutes.");
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const outcome = await requestDelivery(burnHash, domain);
      if (outcome.kind === "delivered") {
        note(`Delivered on Stellar: ${outcome.txHash}`);
        return;
      }
      if (outcome.kind === "already-delivered") {
        note("Delivered on Stellar.");
        return;
      }
      if (outcome.kind === "recipient-not-ready") {
        // Nothing was consumed; the message stays deliverable. Saying so beats a
        // failure a user would retry from the top, paying to burn twice.
        throw new Error(outcome.detail);
      }
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    throw new Error(
      "Circle has not attested this transfer yet. Your funds are safe and this page " +
        "can finish the delivery later: find the transfer under Find.",
    );
  }

  /**
   * Convert what arrived into what was asked for, on Stellar's own exchange.
   *
   * Quoted fresh at execution rather than reusing the quote from minutes ago,
   * because the market has moved since and the user's floor must be computed
   * against the price they are actually getting. If the market moves past that
   * floor the operation fails whole and they keep the USDC: the safe direction.
   */
  async function convertOnStellar(): Promise<void> {
    const owner = stellarAddress ?? (await connectStellarWallet());
    setStellarAddress(owner);
    if (owner !== route.destination) {
      throw new Error(
        "The conversion spends from the receiving account, so only its owner can " +
          "sign it. The USDC has arrived and is theirs either way.",
      );
    }

    note("Converting to XLM on Stellar's exchange.");
    const quote = await sdex.quote({
      assetIn: USDC_ON_STELLAR.id,
      assetOut: "native",
      amountIn:
        route.steps.find((step) => step.kind === "swap")?.from.baseUnits ?? route.sends.baseUnits,
      maxSlippageBps: 50,
      destinationKind: "account",
    });
    const account = await rpc.loadAccount(owner);
    const unsigned = buildPathPayment({
      networkPassphrase:
        NETWORK === "mainnet"
          ? "Public Global Stellar Network ; September 2015"
          : "Test SDF Network ; September 2015",
      account,
      quote,
    });
    note("Approve the conversion in your Stellar wallet.");
    const signed = await signWithStellarWallet(unsigned.toXDR(), owner);
    const parsed = TransactionBuilder.fromXDR(signed, unsigned.networkPassphrase);
    const submitted = await rpc.submit("conversion", async () => parsed as never);
    note(`Converted. Included on Stellar: ${submitted.txHash}`);
  }

  async function send() {
    if (connection === undefined || chain.kind !== "evm") return;
    setSending(true);
    setProblem(undefined);
    setEvents([]);
    setNotes([]);
    try {
      if (needsPreparing) {
        if (!(await sponsorIsUp())) {
          throw new Error(
            "Setting up a new Stellar account needs the sponsor service, which is not " +
              "reachable right now. Nothing has been sent.",
          );
        }
        await prepareDestination();
      }

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
      if (burnHash !== undefined) {
        await deliverToStellar(burnHash);
      }
      if (route.steps.some((step) => step.kind === "swap")) {
        await convertOnStellar();
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

      {stellarAddress === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Stellar wallet:{" "}
          <span className="tabular-nums">
            {stellarAddress.slice(0, 4)}…{stellarAddress.slice(-4)}
          </span>
        </p>
      )}

      {notes.length === 0 ? null : (
        <ol className="space-y-1 text-sm">
          {notes.map((entry) => (
            <li key={entry} className="text-muted-foreground">
              {entry}
            </li>
          ))}
        </ol>
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
