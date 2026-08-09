import { escalateIfOverdue, outcomeOf, parseLookupKey, toHandle } from "@mavna/status";
import { DraftScale } from "@mavna/widget";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgetHistory, readHistory, type TransferRecord } from "@/lib/history";
import { cctp, sourceDomain } from "@/lib/mavna";
import { requestDelivery } from "@/lib/sponsor";
import { useTheme } from "@/lib/theme";

/**
 * Finding a transfer again, and what this browser has seen.
 *
 * Two ways in, and the order matters. The list is the convenience; the box above
 * it is the guarantee. Anyone can find any transfer from a transaction hash or
 * the address they sent to, on any device, having saved nothing. The list only
 * saves them the typing.
 *
 * That is the opposite of the prior art, whose resume path is gated on
 * reconnecting a wallet, so a reload without reconnecting resumes nothing.
 */

export function Track() {
  const theme = useTheme();
  const [history, setHistory] = useState<readonly TransferRecord[]>([]);
  const [query, setQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<Awaited<ReturnType<typeof cctp.status>> | undefined>(
    undefined,
  );
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const [finishing, setFinishing] = useState(false);
  const [remedyNote, setRemedyNote] = useState<string | undefined>(undefined);

  useEffect(() => setHistory(readHistory()), []);

  /**
   * Trigger the mint for whatever transfer is on screen.
   *
   * Works from nothing but the source transaction, which is the point of this
   * page: the person here has closed the tab, changed devices, or been sent a
   * hash by someone else, and none of that should matter.
   */
  async function finishDelivery(): Promise<void> {
    const hash = query.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) {
      setRemedyNote("Finishing a delivery needs the transaction you sent. Paste it above.");
      return;
    }
    setFinishing(true);
    setRemedyNote(undefined);
    try {
      // The source chain is unknown here, so every domain is tried through the
      // adapter's own search when checking, but delivery needs the right one.
      // The history entry carries it when this browser sent the transfer.
      const known = history.find((r) => r.sourceTxHash.toLowerCase() === hash.toLowerCase());
      const domain = known === undefined ? 0 : sourceDomain(known.sourceChainId);
      const outcome = await requestDelivery(hash.startsWith("0x") ? hash : `0x${hash}`, domain);
      if (outcome.kind === "delivered" || outcome.kind === "already-delivered") {
        setRemedyNote("Delivered. The funds are on Stellar.");
        await look(hash);
      } else if (outcome.kind === "not-attested-yet") {
        setRemedyNote("Circle has not attested it yet. Nothing is wrong; try again in a minute.");
      } else {
        setRemedyNote(outcome.detail);
      }
    } catch (error) {
      setRemedyNote(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setFinishing(false);
    }
  }

  async function look(input: string) {
    setLooking(true);
    setProblem(undefined);
    setFound(undefined);
    try {
      // The parser is deliberately permissive: someone pasting from a wallet or
      // an explorer should not have to know which of the three things they have.
      const handle = toHandle(parseLookupKey(input));
      const phase = await cctp.status(handle);

      // Slow and stalled must be tellable apart without reading. The adapter
      // cannot judge it, because it has no idea when this transfer started; this
      // browser's own history does, when it sent the transfer. Twice the
      // standard path's ceiling before escalating, so ordinary slowness never
      // cries wolf.
      const started = history.find(
        (r) => r.sourceTxHash.toLowerCase() === input.trim().toLowerCase().replace(/^0x/, "0x"),
      )?.startedAtUnix;
      const escalated =
        started === undefined
          ? phase
          : escalateIfOverdue(
              {
                id: "bridge",
                label: "",
                phase,
                expectedSeconds: 2400,
                startedAtUnix: started,
              },
              Math.floor(Date.now() / 1000),
              () => ({
                kind: "retry",
                because:
                  "This has taken far longer than the path usually does. Finishing " +
                  "the delivery is safe to try; a repeat cannot happen twice.",
              }),
            ).phase;
      setFound(escalated);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That could not be looked up.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Find a transfer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the transaction you sent, or the Stellar address you sent to.
        </p>
      </div>

      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void look(query);
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="lookup">Transaction or address</Label>
          <Input
            id="lookup"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="0x… or G…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <Button type="submit" disabled={looking || query.trim() === ""}>
            {looking ? "Looking…" : "Find it"}
          </Button>
        </div>
      </form>

      {problem === undefined ? null : <p className="text-sm text-destructive">{problem}</p>}

      {found === undefined ? null : (
        <>
          <DraftScale
            steps={[{ id: "bridge", label: "Move your funds to Stellar", phase: found }]}
            outcome={outcomeOf({
              id: "lookup",
              updatedAtUnix: Math.floor(Date.now() / 1000),
              steps: [
                {
                  id: "bridge",
                  label: "",
                  phase: found,
                  // Unknown from a lookup: someone arriving with only a hash never
                  // saw the quote these came from, and inventing a schedule the
                  // scale would then draw against is worse than admitting neither.
                  expectedSeconds: 0,
                  startedAtUnix: undefined,
                },
              ],
            })}
            onRemedy={(_step, remedy) => {
              // The one remedy this rail has is finishing the delivery, and it is
              // wired to the same control below so both paths lead somewhere.
              if (remedy.kind === "retry" || remedy.kind === "wait") void finishDelivery();
            }}
            theme={theme}
          />

          {/*
          Recoverable from inside the product, which the requirements state
          outright: no explorer, no documentation, no support thread. Retrying
          is always safe because Circle's transmitter refuses a nonce it has
          already used, so a duplicate cannot mint twice.
        */}
          {found.phase === "done" ? null : (
            <Button variant="outline" disabled={finishing} onClick={() => void finishDelivery()}>
              {finishing ? "Finishing…" : "Finish the delivery"}
            </Button>
          )}
          {remedyNote === undefined ? null : (
            <p className="text-sm text-muted-foreground">{remedyNote}</p>
          )}
        </>
      )}

      <section className="space-y-3 border-t pt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-heading text-lg font-medium">From this browser</h2>
          {history.length === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                forgetHistory();
                setHistory([]);
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing here yet. Transfers you send show up in this list, on this browser only. You can
            always find any transfer with the box above.
          </p>
        ) : (
          <ul className="divide-y">
            {history.map((record) => (
              <li key={record.sourceTxHash} className="flex items-baseline gap-4 py-3 text-sm">
                <span className="tabular-nums font-medium">
                  {readable(record.sendsBaseUnits, record.decimals)} {record.symbol}
                </span>
                <span className="text-muted-foreground">from {record.sourceChainName}</span>
                <span className="ml-auto flex items-center gap-3">
                  {record.explorerUrl === undefined ? null : (
                    <a
                      className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
                      href={record.explorerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Explorer
                    </a>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void look(record.sourceTxHash)}
                  >
                    Check
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Base units to a figure a person reads, without going near a float. */
function readable(baseUnits: string, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(baseUnits);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
