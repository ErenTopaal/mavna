import { outcomeOf, parseLookupKey, toHandle } from "@mavna/status";
import { DraftScale } from "@mavna/widget";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgetHistory, readHistory, type TransferRecord } from "@/lib/history";
import { cctp } from "@/lib/mavna";
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

  useEffect(() => setHistory(readHistory()), []);

  async function look(input: string) {
    setLooking(true);
    setProblem(undefined);
    setFound(undefined);
    try {
      // The parser is deliberately permissive: someone pasting from a wallet or
      // an explorer should not have to know which of the three things they have.
      const handle = toHandle(parseLookupKey(input));
      setFound(await cctp.status(handle));
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
          onRemedy={undefined}
          theme={theme}
        />
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
