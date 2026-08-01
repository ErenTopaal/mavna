/**
 * The live playground.
 *
 * Two things at once, and they only work together. It renders the real widget
 * from `@mavna/widget`, and it renders it against a real quote: the chain list
 * is the adapter's own registry, the fee comes from Circle, and the destination
 * is inspected on Stellar through the freshness guard. Nothing here is a fixture.
 *
 * That is why there is a form in front of the preview. A quote needs a
 * destination, and inventing one so the page looks busier on first paint would
 * make every number below it a decoration.
 */
import { CCTP_CONTRACTS, CctpAdapter, EVM_DEPLOYMENTS } from "@mavna/adapter-cctp";
import type { Asset, NetworkId, RouteSet } from "@mavna/core";
import { raceAdapters } from "@mavna/routing";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { RouteList, TransferPanel } from "@mavna/widget";
import "@mavna/widget/widget.css";
import { type ReactElement, useMemo, useState } from "react";

const NETWORK: NetworkId = "testnet";

/** The tokens worth putting a control next to. The full list is in the reference. */
const TOKENS = [
  { name: "--mv-surface", label: "Panel", swatch: true },
  { name: "--mv-ground", label: "Behind the panel", swatch: true },
  { name: "--mv-ink", label: "Text", swatch: true },
  { name: "--mv-muted", label: "Secondary text", swatch: true },
  { name: "--mv-rule", label: "Borders", swatch: true },
  { name: "--mv-rule-strong", label: "Emphasised borders", swatch: true },
  { name: "--mv-signal", label: "Something is wrong", swatch: true },
  { name: "--mv-radius", label: "Radius", swatch: false },
  { name: "--mv-radius-lg", label: "Radius, large", swatch: false },
  { name: "--mv-font", label: "Typeface", swatch: false },
] as const;

type TokenName = (typeof TOKENS)[number]["name"];
type Overrides = Partial<Record<TokenName, string>>;

const SOURCE_CHAINS = Object.entries(EVM_DEPLOYMENTS[NETWORK])
  .map(([id, chain]) => ({ id, name: chain.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const config = createNetworkConfig({ id: NETWORK, rpcUrl: PUBLIC_TESTNET_RPC_URL });
const adapter = new CctpAdapter({
  network: NETWORK,
  rpc: new RpcClient({ url: config.rpcUrl }),
  baseReserveStroops: config.baseReserveStroops,
});

export function Playground(): ReactElement {
  const [chainId, setChainId] = useState(SOURCE_CHAINS[0]?.id ?? "ethereum-sepolia");
  const [amount, setAmount] = useState("25");
  const [destination, setDestination] = useState("");
  const [asking, setAsking] = useState(false);
  const [routes, setRoutes] = useState<RouteSet | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const [overrides, setOverrides] = useState<Overrides>({});
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [copied, setCopied] = useState<"no" | "yes" | "refused">("no");

  const css = useMemo(() => stylesheet(overrides), [overrides]);
  const route = routes?.routes.find((r) => r.id === selected) ?? routes?.routes[0];

  async function quote(): Promise<void> {
    setAsking(true);
    setProblem(undefined);
    setRoutes(undefined);

    try {
      const deployment = EVM_DEPLOYMENTS[NETWORK][chainId];
      if (deployment === undefined) throw new Error(`No deployment for ${chainId}.`);

      const from: Asset = {
        chainId,
        id: deployment.usdc,
        symbol: "USDC",
        decimals: 6,
        curatedBy: "Circle",
      };
      const to: Asset = {
        chainId: "stellar-testnet",
        id: `USDC:${CCTP_CONTRACTS[NETWORK].usdcIssuer}`,
        symbol: "USDC",
        decimals: 7,
        curatedBy: "Circle",
      };

      const result = await raceAdapters(
        [adapter],
        {
          from,
          to,
          sends: { asset: from, baseUnits: toBaseUnits(amount, from.decimals) },
          destination: destination.trim(),
          maxSlippageBps: 50,
        },
        { onUpdate: setRoutes },
      );
      setRoutes(result);
      setSelected(result.routes[0]?.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That request did not complete.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mv-play not-content">
      {/* Exactly the block the copy button hands over, applied to this page. The
          preview and the snippet cannot disagree, because they are one string. */}
      {css === undefined ? null : <style>{css}</style>}

      <div className="mv-play-split">
        <div className="mv-play-controls">
          <fieldset className="mv-play-group">
            <legend>Quote</legend>

            <label className="mv-play-field">
              <span>From</span>
              <select
                value={chainId}
                onChange={(event) => {
                  setChainId(event.target.value);
                }}
              >
                {SOURCE_CHAINS.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="mv-play-field">
              <span>USDC</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
              />
            </label>

            <label className="mv-play-field">
              <span>To this Stellar address</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="G..."
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value);
                }}
              />
            </label>

            <button
              type="button"
              disabled={asking || destination.trim() === ""}
              onClick={() => {
                void quote();
              }}
            >
              {asking ? "Asking Circle and Stellar" : "Get a real quote"}
            </button>
          </fieldset>

          <fieldset className="mv-play-group">
            <legend>Theme</legend>
            <label className="mv-play-field">
              <span>Follows the machine unless you say otherwise</span>
              <select
                value={theme}
                onChange={(event) => {
                  setTheme(event.target.value as "system" | "light" | "dark");
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </fieldset>

          <fieldset className="mv-play-group">
            <legend>Tokens</legend>
            {TOKENS.map((token) => (
              <label className="mv-play-field" key={token.name}>
                <span>
                  {token.label} <code>{token.name}</code>
                </span>
                <span className="mv-play-row">
                  {token.swatch ? (
                    <Swatch
                      value={overrides[token.name]}
                      token={token.name}
                      theme={theme === "system" ? undefined : theme}
                    />
                  ) : null}
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="unchanged"
                    value={overrides[token.name] ?? ""}
                    onChange={(event) => {
                      setOverrides((current) => ({
                        ...current,
                        [token.name]: event.target.value,
                      }));
                      // What is on the clipboard is no longer what is on the
                      // page, so the button must stop claiming otherwise.
                      setCopied("no");
                    }}
                  />
                </span>
              </label>
            ))}
            <button
              type="button"
              data-quiet=""
              disabled={css === undefined}
              onClick={() => {
                setOverrides({});
                setCopied("no");
              }}
            >
              Back to the defaults
            </button>
          </fieldset>
        </div>

        <div className="mv-play-stage">
          {route === undefined ? (
            <p className="mv-play-empty">
              {routes === undefined
                ? "Paste a Stellar address and ask for a quote. The panel renders what actually comes back."
                : "No route. The reasons are below."}
            </p>
          ) : (
            <TransferPanel
              route={route}
              steps={undefined}
              outcome="in-flight"
              onConfirm={undefined}
              onRemedy={undefined}
              theme={theme === "system" ? undefined : theme}
            />
          )}

          {routes !== undefined && routes.rejected.length > 0 ? (
            <RouteList
              routes={routes}
              selectedId={selected}
              onSelect={setSelected}
              theme={theme === "system" ? undefined : theme}
            />
          ) : null}

          {problem === undefined ? null : <p className="mv-play-problem">{problem}</p>}
        </div>
      </div>

      <div className="mv-play-output">
        {css === undefined ? (
          <p className="mv-play-empty">Change a token and the CSS to paste appears here.</p>
        ) : (
          <>
            <pre>
              <code>{css}</code>
            </pre>
            {/* A browser that refuses clipboard access must not leave a button
                saying "Copied" over nothing. The block is on the page either
                way, so the honest failure is to say select it yourself. */}
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(css).then(
                  () => {
                    setCopied("yes");
                  },
                  () => {
                    setCopied("refused");
                  },
                );
              }}
            >
              {copied === "yes" ? "Copied" : copied === "refused" ? "Select it above" : "Copy"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A live preview of whatever the field currently says.
 *
 * It shows the real resolved colour, including nothing at all when the value is
 * not a colour the browser understands, which is more useful than validating the
 * string ourselves and being wrong about a format CSS accepts.
 */
function Swatch({
  value,
  token,
  theme,
}: {
  value: string | undefined;
  token: string;
  theme: "light" | "dark" | undefined;
}): ReactElement {
  return (
    // Carries mv-root so the widget's own tokens are defined on it, which is what
    // lets an untouched field preview the real default rather than a copy of it,
    // and data-mv-theme so it previews the default for the theme being looked at.
    // Without that it followed the machine while the panel beside it did not, and
    // showed white as black.
    <span
      className="mv-root mv-play-swatch"
      data-mv-theme={theme}
      aria-hidden="true"
      style={{ background: value === undefined || value === "" ? `var(${token})` : value }}
    />
  );
}

/**
 * Only what was changed, under a selector that actually wins.
 *
 * A plain `.mv-root` rule ties with the widget's own on specificity, so which one
 * applies comes down to the order a bundler happens to emit the two stylesheets
 * in. Doubling the class settles it without needing to know anything about the
 * host's build.
 */
function stylesheet(overrides: Overrides): string | undefined {
  const set = Object.entries(overrides).filter(([, value]) => value !== undefined && value !== "");
  if (set.length === 0) return undefined;
  return [
    "/* Doubled so it outranks the widget's own .mv-root rule whatever order",
    "   your bundler emits the two stylesheets in. */",
    ".mv-root.mv-root {",
    ...set.map(([name, value]) => `  ${name}: ${value};`),
    "}",
  ].join("\n");
}

/** Decimal string to integer base units, without going through a float. */
function toBaseUnits(value: string, decimals: number): string {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const digits = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
  return digits.replace(/^0+(?=\d)/, "") || "0";
}
