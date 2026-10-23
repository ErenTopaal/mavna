/*
 * The per-screen renderers for the app, split out of Flow so the class file
 * stays about behaviour. Every inline style here is the design's, passed verbatim
 * through s(); every hover/active/focus is pseudo(). All the bound values are
 * computed from the real component state, never from demo constants.
 */
import { recipientRefusal, stroopsToXlm } from "@mavna/stellar";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { ChainIcon } from "./chain-icon";
import type { SourceDetail } from "./engine";
import type { Flow } from "./flow";
import { fmt, fmtAmount, fromBaseUnits, short, shortIds } from "./format";
import { MAVNA_MARK_PATH, MAVNA_MARK_VIEWBOX } from "./mark";
import { pseudo } from "./pseudo";
import {
  approvalsLabel,
  deliveryBudget,
  enabledRailCount,
  type RailName,
  type RouteView,
  railDisplay,
  railsLabel,
  TRUST_LABEL,
  visibleDeclines,
  type Wanted,
} from "./quote";
import { s } from "./style";
import type { FlightRow, FlightStep } from "./transfer";

/**
 * The rail label, with the swap venue when the route converts.
 *
 * "Circle" for a plain route, "Circle + SDEX" when a swap leg is attached. The
 * venue is read off the route, never assumed, so this is only ever the truth.
 */
// a number standing alone in a string: not part of a word, an address or a hash
const FIGURE = /(?<![\w.,])(\d+(?:[.,]\d+)*)(?![\w])/;
const FIGURE_FACE = s("font-family:var(--mv-font-num)");

/**
 * An amount and its unit ("25.00 USDC") sets the amount in the figure face and the
 * unit in the text face. A phrase that only mentions a number ("About 22 min",
 * "Up to 5 steps") stays in the text face, where its tabular figures still line
 * up: the figure face beside small words reads heavier than they do.
 */
function figures(text: string, unit?: CSSProperties): ReactNode {
  const parts = text.split(FIGURE);
  if (parts.length === 1 || parts[0] !== "") return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string, never reordered
      <span key={i} style={FIGURE_FACE}>
        {part}
      </span>
    ) : unit === undefined || part.trim() === "" ? (
      part
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: as above
      <span key={i} style={unit}>
        {part}
      </span>
    ),
  );
}

// the unit beside a large figure, set like the form's own: smaller, muted, apart
const HERO_UNIT = s(
  "font-size:13px;font-weight:400;letter-spacing:0;color:var(--mv-muted-2);margin-left:4px",
);

function railLabel(x: RouteView): string {
  if (x.compose !== undefined) return `${x.source} · ${x.compose.label}`;
  return x.swapVenue === undefined ? x.source : `${x.source} + ${x.swapVenue}`;
}

// ------------------------------------------------------------------- send ---

/**
 * What the user sends, as the design's own segmented control, the same one the
 * receive side uses for USDC and XLM.
 */
function renderSendAsset(c: Flow): ReactElement {
  const usdt0 = c.state.send === "USDT0";
  const ink = (on: boolean): string => (on ? "var(--mv-on-light)" : "var(--mv-muted)");
  return (
    <div
      style={s(
        "position:relative;display:flex;align-items:center;flex:0 0 auto;padding:2px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px",
      )}
    >
      <div
        style={s(
          `position:absolute;top:2px;left:2px;width:52px;height:calc(100% - 4px);background:var(--mv-white);border-radius:999px;transition:transform 260ms cubic-bezier(0.2,0,0,1);transform:translateX(${usdt0 ? "52px" : "0px"})`,
        )}
      />
      {(["USDC", "USDT0"] as const).map((asset) => (
        <button
          key={asset}
          type="button"
          aria-pressed={c.state.send === asset}
          onClick={() => c.setSend(asset)}
          style={s(
            `position:relative;z-index:1;width:52px;padding:5px 0;background:transparent;border:0;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);color:${ink(c.state.send === asset)}`,
          )}
        >
          {asset}
        </button>
      ))}
    </div>
  );
}

export function renderSend(
  c: Flow,
  d: {
    r: RouteView | undefined;
    chain: { id: string; name: string };
    sym: string;
    xlm: boolean;
    resting: boolean;
  },
): ReactElement {
  const st = c.state;
  const { r, chain, sym } = d;
  const hasBalance = st.wallet !== null && st.balance !== null;
  const balanceLine = st.balance !== null ? `Balance ${fmt(st.balance)} ${st.send}` : "";
  // USDT0 lands as itself unless converted on Stellar; USDC lands as USDC or XLM
  const receiveChoices: readonly Wanted[] =
    st.send === "USDT0" ? ["USDT0", "USDC", "XLM"] : ["USDC", "XLM"];
  const segX = `${Math.max(0, receiveChoices.indexOf(st.wanted)) * 52}px`;
  const receiveFigure = r === undefined ? "0" : fmt(r.receives);
  const figureInk = r === undefined ? "var(--mv-faintest)" : "var(--mv-ink)";
  const floorLine =
    r === undefined
      ? ""
      : r.exact
        ? "Exact"
        : `Min ${fmtAmount(r.route.receivesAtLeast, 7)} ${sym}`;
  const destShort = st.destination === "" ? "Not set" : short(st.destination);
  const destInk = c.destValid() ? "var(--mv-ink-2)" : "var(--mv-signal)";
  const priorityLabel = st.priority === "best" ? "Best return" : "Fastest";
  const railsShown = railsLabel(st.rails, c.availableRails());
  const approvals = r === undefined ? "Nothing yet" : approvalsLabel(r);

  return (
    <div style={s("display:flex;flex-direction:column")}>
      <div style={s("background:var(--mv-surface-2);border-radius:14px;padding:15px 16px 14px")}>
        <div style={s("display:flex;align-items:center;justify-content:space-between;gap:10px")}>
          <p
            style={s(
              "margin:0;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
            )}
          >
            Send
          </p>
          <button
            type="button"
            onClick={() => c.go("chains", "push")}
            className={pseudo({
              hover: "background:var(--mv-surface-3)",
              active: "transform:translateY(1px)",
            })}
            style={s(
              "display:flex;align-items:center;gap:8px;padding:6px 12px 6px 7px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font:inherit;color:var(--mv-ink)",
            )}
          >
            <ChainIcon chainId={chain.id} name={chain.name} size={22} />
            <span style={s("font-size:13px;font-weight:500;white-space:nowrap")}>{chain.name}</span>
            <span
              style={s(
                "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
              )}
            >
              ▸
            </span>
          </button>
        </div>
        <div style={s("display:flex;align-items:baseline;gap:10px;margin-top:12px")}>
          {/* width 0, grown by flex: an input's own width is its 20-character size,
              which at this type size held the whole widget at 440px in a host that sizes to content */}
          <input
            value={st.amount}
            onChange={(e) => c.setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            placeholder="0"
            aria-label="Amount to send"
            style={s(
              "flex:1 1 auto;width:0;min-width:0;border:0;padding:0;background:transparent;font-family:var(--mv-font-num);font-weight:500;font-size:33px;line-height:1.1;letter-spacing:-0.055em;color:var(--mv-ink)",
            )}
          />
          {c.usdt0Offered() ? (
            renderSendAsset(c)
          ) : (
            <span style={s("font-family:var(--mv-font);font-size:13px;color:var(--mv-muted-2)")}>
              USDC
            </span>
          )}
        </div>
        {hasBalance ? (
          <div style={s("display:flex;align-items:baseline;gap:8px;margin-top:8px")}>
            <span style={s("font-family:var(--mv-font);font-size:11.5px;color:var(--mv-faint)")}>
              {balanceLine}
            </span>
            <button
              type="button"
              onClick={() =>
                st.balance !== null &&
                c.setState({ amount: String(st.balance) }, () => c.runQuote())
              }
              className={pseudo({
                hover: "color:var(--mv-ink);border-color:var(--mv-rule-hover)",
              })}
              style={s(
                "padding:2px 7px;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:9.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted)",
              )}
            >
              Max
            </button>
          </div>
        ) : null}
      </div>

      <div style={s("position:relative;height:0;z-index:2")}>
        <div
          ref={c.pivotRef}
          style={s(
            "position:absolute;left:50%;top:-15px;margin-left:-15px;width:30px;height:30px;display:grid;place-items:center;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px;font-family:var(--mv-font);font-size:12px;color:var(--mv-ink-2)",
          )}
        >
          ↓
        </div>
      </div>

      <div
        style={s(
          "position:relative;overflow:hidden;background:var(--mv-surface-2);border-radius:14px;padding:15px 16px 14px;margin-top:8px",
        )}
      >
        <div
          ref={c.sweepRef}
          style={s(
            "position:absolute;top:0;left:0;right:0;height:2px;background:var(--mv-white);transform:scaleX(0);transform-origin:left center",
          )}
        />
        <div style={s("display:flex;align-items:center;justify-content:space-between;gap:10px")}>
          <p
            style={s(
              "margin:0;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
            )}
          >
            Receive on Stellar
          </p>
          <div
            style={s(
              "position:relative;display:flex;align-items:center;flex:0 0 auto;padding:2px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px",
            )}
          >
            <div
              style={s(
                `position:absolute;top:2px;left:2px;width:52px;height:calc(100% - 4px);background:var(--mv-white);border-radius:999px;transition:transform 260ms cubic-bezier(0.2,0,0,1);transform:translateX(${segX})`,
              )}
            />
            {receiveChoices.map((asset) => (
              <button
                key={asset}
                type="button"
                aria-label={`Receive ${asset}`}
                aria-pressed={st.wanted === asset}
                onClick={() => {
                  if (st.wanted === asset) return;
                  c.setState({ wanted: asset }, () => c.runQuote());
                }}
                style={s(
                  `position:relative;z-index:1;width:52px;padding:5px 0;background:transparent;border:0;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);color:${st.wanted === asset ? "var(--mv-on-light)" : "var(--mv-muted)"}`,
                )}
              >
                {asset}
              </button>
            ))}
          </div>
        </div>
        <div style={s("display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-top:12px")}>
          <span
            ref={c.figureRef}
            style={s(
              `min-width:0;overflow-wrap:anywhere;font-family:var(--mv-font-num);font-weight:500;font-size:33px;line-height:1.1;letter-spacing:-0.055em;color:${figureInk}`,
            )}
          >
            {receiveFigure}
          </span>
          <span style={s("font-family:var(--mv-font);font-size:13px;color:var(--mv-muted-2)")}>
            {sym}
          </span>
        </div>
        {/* held open while an amount waits on its quote, so the rows below stay put when it lands */}
        {r !== undefined || !d.resting ? (
          <p
            style={s(
              "margin:10px 0 0;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
            )}
          >
            {r === undefined ? "\u00a0" : floorLine}
          </p>
        ) : null}
      </div>

      <div style={s("display:flex;flex-direction:column;gap:6px;margin-top:10px")}>
        <button
          type="button"
          onClick={() => {
            // requiredUI: destination locks the recipient to the configured address.
            if (!c.required("destination")) c.go("address", "push");
          }}
          className={pseudo(
            c.required("destination") ? {} : { hover: "background:var(--mv-surface-3)" },
          )}
          style={s(
            `display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:${c.required("destination") ? "default" : "pointer"};font:inherit;color:var(--mv-ink);text-align:left`,
          )}
        >
          <span style={s("font-size:13px;font-weight:500")}>Recipient</span>
          <span style={s("display:flex;align-items:center;gap:9px;min-width:0")}>
            <span
              style={s(
                `font-family:${st.destination === "" ? "var(--mv-font);font-size:12px" : "var(--mv-font-address);font-size:11.5px"};color:${destInk};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
              )}
            >
              {destShort}
            </span>
            {c.required("destination") ? null : (
              <span
                style={s(
                  "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
                )}
              >
                ▸
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => c.go("priority", "push")}
          className={pseudo({ hover: "background:var(--mv-surface-3)" })}
          style={s(
            "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
          )}
        >
          <span style={s("font-size:13px;font-weight:500")}>Route priority</span>
          <span style={s("display:flex;align-items:center;gap:9px")}>
            <span style={s("font-family:var(--mv-font);font-size:12px;color:var(--mv-muted)")}>
              {priorityLabel}
            </span>
            <span
              style={s(
                "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
              )}
            >
              ▸
            </span>
          </span>
        </button>

        {c.hidden("railToggles") ? null : (
          <button
            type="button"
            onClick={() => c.go("rails", "push")}
            className={pseudo({ hover: "background:var(--mv-surface-3)" })}
            style={s(
              "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
            )}
          >
            <span style={s("font-size:13px;font-weight:500")}>Rails</span>
            <span style={s("display:flex;align-items:center;gap:9px")}>
              <span style={s("font-family:var(--mv-font);font-size:12px;color:var(--mv-muted)")}>
                {railsShown}
              </span>
              <span
                style={s(
                  "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
                )}
              >
                ▸
              </span>
            </span>
          </button>
        )}

        <div
          style={s(
            "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;background:var(--mv-surface-2);border-radius:12px",
          )}
        >
          <span style={s("font-size:13px;font-weight:500")}>You will approve</span>
          <span style={s("font-family:var(--mv-font);font-size:12px;color:var(--mv-muted)")}>
            {approvals}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The shared preamble for both primary buttons.
 *
 * The order is the order a transfer actually needs things in: a source wallet,
 * then a Stellar recipient (a connected Stellar wallet fills it, or the user types
 * one), then an amount, then a route that has answered. Without the recipient the
 * rails cannot quote, which is why it is asked for before the amount rather than
 * after. Returns true when it handled the click by asking for the next missing
 * thing, false when everything is ready and the caller should advance.
 */
function primaryGuard(c: Flow, chain: SourceDetail): boolean {
  const st = c.state;
  if (st.wallet === null) {
    c.setState({ walletOpen: true });
    return true;
  }
  if (!c.destValid()) {
    c.go("address", "push");
    return true;
  }
  if (chain.kind !== "evm") {
    c.setState({
      note: `Sending from ${chain.name} needs a ${chain.family} wallet.`,
      noteKind: "quiet",
    });
    return true;
  }
  if (c.amountNumber() <= 0) {
    c.setState({ note: "Enter an amount to send.", noteKind: "quiet" });
    return true;
  }
  if (st.routes.length === 0) {
    c.setState({ note: "No rail has answered for this transfer yet.", noteKind: "quiet" });
    return true;
  }
  return false;
}

/** The primary button's label, from what the transfer still needs next. */
export function primaryLabel(c: Flow, whenReady: string): string {
  const st = c.state;
  if (st.wallet === null) return "Connect a wallet";
  if (!c.destValid()) return "Set a recipient";
  if (c.amountNumber() <= 0) return "Enter an amount";
  if (st.quoting) return "Finding routes…";
  if (st.routes.length === 0) return "No route available";
  return whenReady;
}

/** Wide flow: straight to review once everything is ready. */
export function onPrimary(c: Flow, d: { r: RouteView | undefined; chain: SourceDetail }): void {
  if (primaryGuard(c, d.chain)) return;
  c.go("review", "push");
}

/** Compact flow: open the route-selection screen once everything is ready. */
export function onPrimaryCompact(c: Flow, d: { chain: SourceDetail }): void {
  if (primaryGuard(c, d.chain)) return;
  c.go("routes", "push");
}

// ----------------------------------------------------------------- chains ---

function rowStyle(on: boolean): CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "11px 14px",
    background: on ? "var(--mv-surface-3)" : "var(--mv-surface-2)",
    border: 0,
    borderRadius: "12px",
    cursor: "pointer",
    font: "inherit",
    color: "var(--mv-ink)",
    textAlign: "left",
  };
}

export function renderChains(c: Flow): ReactElement {
  const st = c.state;
  const q = st.chainQuery.trim().toLowerCase();
  const matches = c.list().filter((chain) => q === "" || chain.name.toLowerCase().includes(q));
  const rows = matches.map((chain) => {
    const detail = c.engine.sourceChainDetail(chain.id);
    // The tag is real: the chain's gas token on EVM, the chain family otherwise.
    const tag =
      detail.kind === "evm" ? (detail.nativeCurrency?.symbol ?? "") : detail.family.toUpperCase();
    return {
      id: chain.id,
      name: chain.name,
      tag,
      kind: detail.kind,
      need: detail.kind === "evm" ? "" : `${detail.family.toUpperCase()} WALLET`,
      mark: chain.id === st.chainId ? "✓" : "",
      choose: () =>
        c.setState({ chainId: chain.id, chainQuery: "" }, () => {
          c.go("send", "pop");
          c.runQuote();
          void c.refreshBalance({ align: true });
        }),
    };
  });
  const signable = rows.filter((row) => row.kind === "evm");
  const unsignable = rows.filter((row) => row.kind !== "evm");

  return (
    <div style={s("display:flex;flex-direction:column;gap:12px")}>
      <div
        style={s(
          "display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--mv-surface-2);border:1px solid transparent;border-radius:12px",
        )}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          style={s("flex:0 0 auto;color:var(--mv-faint)")}
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4 4" />
        </svg>
        <input
          value={st.chainQuery}
          onChange={(e) => c.setState({ chainQuery: e.target.value })}
          placeholder="Search chains"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search chains"
          style={s(
            "flex:1 1 auto;width:0;min-width:0;border:0;padding:0;background:transparent;outline:none;font-size:13.5px",
          )}
        />
        <span
          style={s(
            "flex:0 0 auto;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);color:var(--mv-faint-2)",
          )}
        >
          {chainCount(c)}
        </span>
      </div>

      {signable.length > 0 ? (
        <div style={s("display:flex;flex-direction:column;gap:6px")}>
          {signable.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={row.choose}
              className={pseudo({ hover: "background:var(--mv-surface-3)" })}
              style={rowStyle(row.id === st.chainId)}
            >
              <ChainIcon chainId={row.id} name={row.name} size={28} />
              <span style={s("flex:1 1 auto;min-width:0;font-size:13.5px;font-weight:500")}>
                {row.name}
              </span>
              <span
                style={s(
                  "flex:0 0 auto;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);color:var(--mv-faint-2)",
                )}
              >
                {row.tag}
              </span>
              <span
                style={s(
                  "flex:0 0 auto;width:14px;text-align:center;font-family:var(--mv-font);font-size:11px;color:var(--mv-ink)",
                )}
              >
                {row.mark}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {unsignable.length > 0 ? (
        <div style={s("display:flex;flex-direction:column;gap:6px")}>
          <p
            style={s(
              "margin:0 2px 6px;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
            )}
          >
            Quoted, not signable here yet
          </p>
          {unsignable.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={row.choose}
              className={pseudo({ hover: "background:var(--mv-surface-3)" })}
              style={rowStyle(row.id === st.chainId)}
            >
              <ChainIcon chainId={row.id} name={row.name} size={28} />
              <span
                style={s(
                  "flex:1 1 auto;min-width:0;font-size:13.5px;font-weight:500;color:var(--mv-ink-2)",
                )}
              >
                {row.name}
              </span>
              <span
                style={s(
                  "flex:0 0 auto;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);color:var(--mv-faint-2)",
                )}
              >
                {row.need}
              </span>
              <span
                style={s(
                  "flex:0 0 auto;width:14px;text-align:center;font-family:var(--mv-font);font-size:11px;color:var(--mv-ink)",
                )}
              >
                {row.mark}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p
          style={s(
            "margin:0;padding:4px 2px;font-size:13px;line-height:1.5;color:var(--mv-muted-2)",
          )}
        >{`No chain called “${st.chainQuery}”. Mavna sends from ${chainCount(c)}.`}</p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- priority ---

export function renderPriority(c: Flow, sym: string): ReactElement {
  const st = c.state;
  const rows = [
    { id: "best" as const, name: "Best return", note: `Most ${sym} on Stellar` },
    { id: "fast" as const, name: "Fastest", note: "Shortest time to arrival" },
  ];
  return (
    <div style={s("display:flex;flex-direction:column;gap:6px")}>
      {rows.map((p) => {
        const on = st.priority === p.id;
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            onClick={() =>
              c.setState({ priority: p.id, picked: false }, () => {
                c.go("send", "pop");
                c.runQuote();
              })
            }
            className={pseudo({ hover: "background:var(--mv-surface-3)" })}
            style={s(
              `display:flex;align-items:center;gap:12px;padding:15px 16px;background:${on ? "var(--mv-surface-3)" : "var(--mv-surface-2)"};border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left`,
            )}
          >
            <span style={s("flex:1 1 auto;min-width:0")}>
              <span style={s("display:block;font-size:14px;font-weight:500")}>{p.name}</span>
              <span
                style={s("display:block;margin-top:4px;font-size:12.5px;color:var(--mv-muted-2)")}
              >
                {p.note}
              </span>
            </span>
            <span
              style={s(
                "flex:0 0 auto;width:16px;text-align:center;font-family:var(--mv-font);font-size:12px;color:var(--mv-ink)",
              )}
            >
              {on ? "✓" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The chains the picker lists for what is being sent, counted. */
function chainCount(c: Flow): string {
  const n = c.list().length;
  return `${n} chain${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- address ---

/**
 * Why the typed recipient is refused. Something with an account's shape fails
 * on its checksum, and a secret key is said to be one, in the words every rail
 * uses for the same input; anything else is told the shape it needs.
 */
function addressHint(destination: string): string {
  const shape =
    "A Stellar address starts with G or C and is 56 characters, or starts with M and is 69.";
  if (/^[A-Z2-7]{56,69}$/.test(destination)) return recipientRefusal(destination) ?? shape;
  return shape;
}

export function renderAddress(c: Flow): ReactElement {
  const st = c.state;
  const invalid = st.destination !== "" && !c.destValid();
  const destBorder =
    st.destination === "" || c.destValid() ? "var(--mv-rule)" : "var(--mv-signal-line)";
  const use = (): void => {
    if (!c.destValid()) {
      c.destRef.current?.focus();
      return;
    }
    c.go("send", "pop");
  };
  return (
    <div style={s("display:flex;flex-direction:column;gap:12px")}>
      <input
        value={st.destination}
        onChange={(e) => c.setDestination(e.target.value.trim())}
        // not a <form>: the widget may sit inside a host page's own form
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          use();
        }}
        ref={c.destRef}
        placeholder="G…, M… or C…"
        spellCheck={false}
        autoComplete="off"
        aria-label="Stellar address"
        style={s(
          `width:100%;padding:14px 15px;background:var(--mv-surface-2);border:1px solid ${destBorder};border-radius:12px;font-family:var(--mv-font-address);font-size:12px;letter-spacing:0.03em;line-height:1.5`,
        )}
      />
      {invalid ? (
        <p
          style={s(
            "margin:0;font-size:12.5px;line-height:1.5;color:var(--mv-signal);text-wrap:pretty",
          )}
        >
          {addressHint(st.destination)}
        </p>
      ) : null}
      <button
        type="button"
        onClick={use}
        className={pseudo({
          hover: "background:var(--mv-cta-hover)",
          active: "transform:translateY(1px)",
        })}
        style={s(
          "width:100%;padding:14px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600",
        )}
      >
        Use this address
      </button>
    </div>
  );
}

// --------------------------------------------------------------- settings ---

export function renderSettings(c: Flow): ReactElement {
  const st = c.state;
  const priorityLabel = st.priority === "best" ? "Best return" : "Fastest";
  const railsShown = railsLabel(st.rails, c.availableRails());
  const switchBg = st.showDeclined ? "var(--mv-ink)" : "var(--mv-rule-2)";
  const knobBg = st.showDeclined ? "var(--mv-surface)" : "var(--mv-ink-2)";
  const knobX = st.showDeclined ? "18px" : "0px";
  return (
    <div style={s("display:flex;flex-direction:column;gap:6px")}>
      <button
        type="button"
        onClick={() => c.go("priority", "push")}
        className={pseudo({ hover: "background:var(--mv-surface-3)" })}
        style={s(
          "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
        )}
      >
        <span style={s("font-size:13.5px;font-weight:500")}>Route priority</span>
        <span style={s("display:flex;align-items:center;gap:9px")}>
          <span style={s("font-family:var(--mv-font);font-size:12px;color:var(--mv-ink-3)")}>
            {priorityLabel}
          </span>
          <span
            style={s(
              "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
            )}
          >
            ▸
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => c.go("rails", "push")}
        className={pseudo({ hover: "background:var(--mv-surface-3)" })}
        style={s(
          "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
        )}
      >
        <span style={s("font-size:13.5px;font-weight:500")}>Rails</span>
        <span style={s("display:flex;align-items:center;gap:9px")}>
          <span style={s("font-family:var(--mv-font);font-size:12px;color:var(--mv-ink-3)")}>
            {railsShown}
          </span>
          <span
            style={s(
              "font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-muted-2)",
            )}
          >
            ▸
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => c.setState((prev) => ({ showDeclined: !prev.showDeclined }))}
        className={pseudo({ hover: "background:var(--mv-surface-3)" })}
        style={s(
          "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
        )}
      >
        <span style={s("font-size:13.5px;font-weight:500")}>Show rails that declined</span>
        <span
          style={s(
            `position:relative;flex:0 0 auto;display:block;width:40px;height:22px;border-radius:999px;transition:background 200ms cubic-bezier(0.2,0,0,1);background:${switchBg}`,
          )}
        >
          <span
            style={s(
              `position:absolute;top:3px;left:3px;display:block;width:16px;height:16px;border-radius:999px;transition:transform 220ms cubic-bezier(0.2,0,0,1),background 200ms linear;background:${knobBg};transform:translateX(${knobX})`,
            )}
          />
        </span>
      </button>
      <div
        style={s(
          "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--mv-surface-2);border-radius:12px",
        )}
      >
        <span style={s("font-size:13.5px;font-weight:500")}>Network</span>
        {renderNetworkToggle(c)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ network toggle ---

/**
 * The network segmented control, the design's own USDC/XLM toggle primitive,
 * shown in the header and in Settings from the same state so they stay in sync.
 * A network the integrator does not offer is shown and cannot be chosen, with
 * the reason on hover; choosing an offered one rebuilds the engine for it.
 */
export function renderNetworkToggle(c: Flow): ReactElement {
  const net = c.state.network;
  const offered = c.offeredNetworks();
  const seg = net === "mainnet" ? "68px" : "0px";
  const option = (id: "testnet" | "mainnet", label: string): ReactElement => {
    const current = net === id;
    const available = offered.includes(id);
    const ink = current
      ? "var(--mv-on-light)"
      : available
        ? "var(--mv-muted)"
        : "var(--mv-faintest)";
    return (
      <button
        type="button"
        disabled={!available}
        aria-disabled={!available}
        aria-pressed={current}
        title={available ? undefined : `${label.toLowerCase()} is not set up on this page`}
        onClick={() => c.setNetwork(id)}
        style={s(
          `position:relative;z-index:1;width:68px;padding:5px 0;background:transparent;border:0;cursor:${available && !current ? "pointer" : "default"};font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);color:${ink}`,
        )}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      style={s(
        "position:relative;display:flex;align-items:center;flex:0 0 auto;padding:2px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px",
      )}
    >
      <div
        style={s(
          `position:absolute;top:2px;left:2px;width:68px;height:calc(100% - 4px);background:var(--mv-white);border-radius:999px;transition:transform 260ms cubic-bezier(0.2,0,0,1);transform:translateX(${seg})`,
        )}
      />
      {option("testnet", "TESTNET")}
      {option("mainnet", "MAINNET")}
    </div>
  );
}

// ------------------------------------------------------------------ rails ---

export function renderRails(c: Flow): ReactElement {
  const st = c.state;
  // Only the rails the integrator offers; the default is all four.
  const names: readonly RailName[] = c.availableRails();
  return (
    <div style={s("display:flex;flex-direction:column;gap:6px")}>
      {names.map((name) => {
        const on = st.rails[name] !== false;
        const bg = on ? "var(--mv-ink)" : "transparent";
        const bd = on ? "var(--mv-ink)" : "var(--mv-fill-dim)";
        const toggle = (): void => {
          const enabled = names.filter((n) => st.rails[n] !== false);
          if (enabled.length === 1 && enabled[0] === name) return;
          c.setState(
            (prev) => ({
              rails: { ...prev.rails, [name]: prev.rails[name] === false },
              picked: false,
            }),
            () => c.runQuote(),
          );
        };
        return (
          <button
            key={name}
            type="button"
            onClick={toggle}
            className={pseudo({ hover: "background:var(--mv-surface-3)" })}
            style={s(
              "display:flex;align-items:flex-start;gap:12px;padding:14px 16px;background:var(--mv-surface-2);border:0;border-radius:12px;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
            )}
          >
            <span style={s("flex:1 1 auto;min-width:0")}>
              <span style={s("display:block;font-size:13.5px;font-weight:500")}>{name}</span>
              <span
                style={s(
                  "display:block;margin-top:5px;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
                )}
              >
                {TRUST_LABEL[name]}
              </span>
            </span>
            <span
              style={s(
                `flex:0 0 auto;width:22px;height:22px;display:grid;place-items:center;border-radius:7px;font-family:var(--mv-font);font-size:11px;color:var(--mv-on-light);transition:background 160ms linear;background:${bg};border:1px solid ${bd}`,
              )}
            >
              {on ? "✓" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- review ---

function sentLabel(r: RouteView): string {
  return `${fmtAmount(r.route.sends)} ${r.route.sends.asset.symbol}`;
}

export function renderReview(
  c: Flow,
  d: { r: RouteView | undefined; chain: { id: string; name: string }; sym: string },
): ReactElement {
  // what is shown is what the route signs for, never the form, which may have
  // moved on since the quote
  const { r, sym } = d;
  const chain = r === undefined ? d.chain : r.route.fromChain;
  const reviewSend = r === undefined ? "-" : sentLabel(r);
  const reviewGet = r === undefined ? "-" : `${fmt(r.receives)} ${sym}`;
  const reviewGetOn = r === undefined ? "Stellar" : `Stellar · ${r.source}`;
  const reviewRows =
    r === undefined
      ? []
      : [
          { key: "dest", name: "Recipient", value: short(r.route.destination) },
          { key: "rail", name: "Rail", value: railLabel(r) },
          { key: "fee", name: "Transfer fee", value: `${r.feeAmount} ${r.feeSymbol}` },
          ...(r.integratorFee === undefined
            ? []
            : [
                {
                  key: "integrator",
                  name: "Integrator fee",
                  value: `${fmt(r.integratorFee.amount)} ${r.integratorFee.symbol} to ${r.integratorFee.recipient}`,
                },
              ]),
          ...(r.newAccount && r.reserveXlm !== undefined
            ? [
                {
                  key: "res",
                  name:
                    c.state.reserveFunding === "self"
                      ? "Reserve, from your own XLM"
                      : "Kept in your account",
                  value: `${fmt(r.reserveXlm)} XLM`,
                },
              ]
            : []),
          // the account signs and pays Circle's mint itself; the budget is what
          // this page will let that transaction cost
          ...(c.state.reserveFunding === "self" && r.route.source === "cctp"
            ? [
                {
                  key: "delivery",
                  name: "Delivery fee, from your own XLM",
                  value: `Up to ${stroopsToXlm(deliveryBudget(c.state.network))} XLM`,
                },
              ]
            : []),
          ...(r.repaymentSetAside !== undefined
            ? [
                {
                  key: "repay",
                  name:
                    r.swapVenue === undefined
                      ? "Repays the reserve, from what arrives"
                      : "Left unconverted to repay the reserve",
                  value: `${r.swapVenue === undefined ? "Up to " : ""}${fmt(r.repaymentSetAside.amount)} ${r.repaymentSetAside.symbol}`,
                },
              ]
            : []),
          {
            key: "min",
            name: r.exact ? "You receive" : "Minimum received",
            value: `${fmtAmount(r.route.receivesAtLeast, 7)} ${sym}`,
          },
          ...(c.state.reserveFunding === "self" && r.compose?.finishXlm !== undefined
            ? [
                {
                  key: "finish",
                  name: "If you finish it yourself",
                  value: `Up to ${r.compose.finishXlm} XLM, simulated now`,
                },
              ]
            : []),
          { key: "sig", name: "Approvals", value: approvalsLabel(r) },
          { key: "eta", name: "Estimated time", value: `About ${r.minutes} min` },
        ];
  return (
    <div style={s("display:flex;flex-direction:column;gap:10px")}>
      <div style={s("background:var(--mv-surface-2);border-radius:14px;overflow:hidden")}>
        <div
          style={s(
            "display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:16px 16px 15px",
          )}
        >
          <span style={s("min-width:0")}>
            <span
              style={s(
                "display:block;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
              )}
            >
              Send
            </span>
            <span
              style={s(
                "display:block;margin-top:9px;overflow-wrap:anywhere;font-size:24px;font-weight:500;letter-spacing:-0.05em",
              )}
            >
              {figures(reviewSend, HERO_UNIT)}
            </span>
          </span>
          <span
            style={s("flex:0 0 auto;font-size:12.5px;color:var(--mv-muted-b);text-align:right")}
          >
            {chain.name}
          </span>
        </div>
        <div style={s("height:1px;background:var(--mv-rule-hair)")} />
        <div
          style={s(
            "display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:15px 16px 16px",
          )}
        >
          <span style={s("min-width:0")}>
            <span
              style={s(
                "display:block;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
              )}
            >
              Receive
            </span>
            <span
              style={s(
                "display:block;margin-top:9px;overflow-wrap:anywhere;font-size:24px;font-weight:500;letter-spacing:-0.05em",
              )}
            >
              {figures(reviewGet, HERO_UNIT)}
            </span>
          </span>
          <span
            style={s("flex:0 0 auto;font-size:12.5px;color:var(--mv-muted-b);text-align:right")}
          >
            {reviewGetOn}
          </span>
        </div>
      </div>
      <div
        style={s(
          "display:flex;flex-direction:column;gap:11px;padding:15px 16px;background:var(--mv-surface-2);border-radius:14px",
        )}
      >
        {reviewRows.map((v) => (
          <div
            key={v.key}
            style={s("display:flex;align-items:baseline;justify-content:space-between;gap:14px")}
          >
            <span style={s("font-size:12.5px;color:var(--mv-muted-2)")}>{v.name}</span>
            <span
              style={
                v.key === "dest"
                  ? s(
                      "font-family:var(--mv-font-address);font-size:12px;color:var(--mv-ink-strong);text-align:right",
                    )
                  : s(
                      "font-family:var(--mv-font);font-size:12.5px;color:var(--mv-ink-strong);text-align:right",
                    )
              }
            >
              {v.key === "dest" ? v.value : figures(v.value)}
            </span>
          </div>
        ))}
      </div>
      {c.state.askAgain && r !== undefined ? (
        <div
          role="alert"
          style={s(
            "display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--mv-signal-line);border-radius:14px",
          )}
        >
          <p
            style={s(
              "margin:0;font-size:12.5px;line-height:1.5;color:var(--mv-ink-strong);text-wrap:pretty",
            )}
          >
            {`The transfer you just sent, ${sentLabel(r)} to ${short(r.route.destination)}, may still arrive. Starting this sends it again, as a second transfer. Check Activity first if you are not sure.`}
          </p>
          <button
            type="button"
            onClick={() => c.confirmSendAgain()}
            className={pseudo({ hover: "background:var(--mv-surface-3)" })}
            style={s(
              "width:100%;padding:13px 20px;background:transparent;color:var(--mv-ink);border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600",
            )}
          >
            Send it again
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => c.start()}
          className={pseudo({
            hover: "background:var(--mv-cta-hover)",
            active: "transform:translateY(1px)",
          })}
          style={s(
            "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
          )}
        >
          Start transfer
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- flight ---

/** The step the flight is on, and what it says, for a screen reader. */
function flightAnnouncement(steps: readonly FlightStep[], eyebrow: string): string {
  const now =
    steps.find((step) => step.phase === "failed") ??
    steps.find((step) => step.phase === "blocked" || step.phase === "pending");
  if (now === undefined) return eyebrow;
  const lead = now.phase === "failed" ? "Stopped" : eyebrow;
  return [`${lead}: ${now.label}.`, now.note ?? ""].join(" ").trim();
}

/** How long a transfer took, said in the largest unit that reads naturally. */
function tookLabel(seconds: number): string {
  if (seconds < 60) return "Under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function renderFlight(
  c: Flow,
  d: {
    r: RouteView | undefined;
    chain: { id: string; name: string };
    sym: string;
    arrived: boolean;
  },
): ReactElement {
  const { r, sym, arrived } = d;
  const chain = r === undefined ? d.chain : r.route.fromChain;
  const asCame = c.state.arrivedAs;
  // a transfer that stopped on a failed step is not on its way, whatever it was quoted for
  const stopped = c.state.phase === "ended" && c.state.steps.some((st) => st.phase === "failed");
  const flightEyebrow =
    asCame !== null
      ? "Arrived on Stellar, not converted"
      : arrived
        ? "Arrived on Stellar"
        : stopped
          ? "Did not arrive on Stellar"
          : "Arriving on Stellar";
  const flightFigure =
    asCame !== null ? fmt(asCame.amount) : r === undefined ? "-" : fmt(r.receives);
  const flightSym = asCame !== null ? asCame.symbol : sym;
  const flightMeta =
    r === undefined
      ? []
      : [
          { key: "from", name: "From", value: chain.name },
          { key: "sent", name: "Sent", value: sentLabel(r) },
          { key: "rail", name: "Rail", value: railLabel(r) },
          { key: "to", name: "Recipient", value: short(r.route.destination) },
          arrived && c.state.tookSeconds !== null
            ? { key: "eta", name: "Took", value: tookLabel(c.state.tookSeconds) }
            : { key: "eta", name: "Estimated time", value: `About ${r.minutes} min` },
        ];
  const { stepEyebrow, stepCount, stepRows } = c.flightVals(arrived);
  return (
    <div style={s("height:100%;min-height:0;display:flex;flex-direction:column;gap:14px")}>
      <div
        style={s("flex:0 0 auto;background:var(--mv-surface-2);border-radius:14px;overflow:hidden")}
      >
        <div style={s("padding:16px")}>
          <p
            style={s(
              "margin:0;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
            )}
          >
            {flightEyebrow}
          </p>
          <p
            style={s(
              "margin:9px 0 0;overflow-wrap:anywhere;font-family:var(--mv-font-num);font-size:30px;font-weight:500;letter-spacing:-0.055em",
            )}
          >
            {flightFigure}
            <span
              style={s(
                "font-family:var(--mv-font);font-size:13px;font-weight:400;letter-spacing:0;color:var(--mv-muted-2);margin-left:8px",
              )}
            >
              {flightSym}
            </span>
          </p>
          {asCame !== null ? (
            <p style={s("margin:10px 0 0;font-size:12.5px;line-height:1.5;color:var(--mv-muted)")}>
              {asCame.reason}
            </p>
          ) : null}
        </div>
        <div style={s("height:1px;background:var(--mv-rule-hair)")} />
        <div style={s("display:flex;flex-direction:column;gap:9px;padding:14px 16px 15px")}>
          {flightMeta.map((m) => (
            <div
              key={m.key}
              style={s("display:flex;align-items:baseline;justify-content:space-between;gap:14px")}
            >
              <span style={s("font-size:12px;color:var(--mv-muted-2)")}>{m.name}</span>
              <span
                style={
                  m.key === "to"
                    ? s(
                        "font-family:var(--mv-font-address);font-size:11.5px;color:var(--mv-ink-strong);text-align:right",
                      )
                    : s(
                        "font-family:var(--mv-font);font-size:12px;color:var(--mv-ink-strong);text-align:right",
                      )
                }
              >
                {m.key === "to" ? m.value : figures(m.value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        ref={c.stepRef}
        style={s("flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:0 2px")}
      >
        <div
          style={s(
            "flex:0 0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:14px;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
          )}
        >
          <span>{stepEyebrow}</span>
          <span>{stepCount}</span>
        </div>
        {/* read out as the flight moves, since the step list itself only changes colour */}
        <p role="status" aria-live="polite" className="mv-sr-only">
          {flightAnnouncement(c.state.steps, stepEyebrow)}
        </p>
        <div
          style={s(
            "flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:8px;margin-right:-8px",
          )}
        >
          {stepRows.map((step: FlightRow) => (
            <div
              key={step.key}
              style={s(
                `position:relative;display:grid;grid-template-columns:18px minmax(0,1fr);column-gap:13px;padding-bottom:${step.gap}`,
              )}
            >
              {step.hasLine ? (
                <span
                  style={s(
                    `position:absolute;left:8px;top:21px;bottom:3px;width:0;border-left:1px ${step.lineStyle} ${step.lineColor}`,
                  )}
                />
              ) : null}
              <span
                style={s(
                  `position:relative;z-index:1;display:grid;place-items:center;width:18px;height:18px;margin-top:1px;border-radius:999px;font-family:var(--mv-font-num);font-size:9px;background:${step.dotBg};border:1px solid ${step.dotBorder};color:${step.markInk};animation:${step.dotAnim}`,
                )}
              >
                {step.mark}
              </span>
              <span style={s("min-width:0")}>
                <span style={s("display:flex;align-items:baseline;gap:12px")}>
                  <span
                    style={s(
                      `min-width:0;font-size:13.5px;font-weight:${step.weight};letter-spacing:-0.005em;color:${step.ink}`,
                    )}
                  >
                    {step.label}
                  </span>
                  {step.meta === "" ? null : (
                    <span
                      style={s(
                        `margin-left:auto;flex:0 0 auto;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:${step.metaInk};white-space:nowrap`,
                      )}
                    >
                      {step.meta}
                    </span>
                  )}
                </span>
                {step.hasNote ? (
                  <span
                    style={s(
                      `display:block;margin-top:5px;font-size:12.5px;line-height:1.5;color:${step.noteInk};text-wrap:pretty`,
                    )}
                  >
                    {step.note}
                  </span>
                ) : null}
                {step.hasRef ? (
                  <a
                    href={step.refUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={s(
                      "display:inline-block;margin-top:7px;font-family:var(--mv-font-address);font-size:10.5px;color:var(--mv-muted-b);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--mv-rule-hover)",
                    )}
                  >
                    {step.refText} ↗
                  </a>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- activity ---

export function renderActivity(c: Flow): ReactElement {
  const st = c.state;
  const readable = (record: (typeof st.history)[number]): string => {
    const value = fmt(Number(BigInt(record.sendsBaseUnits)) / 10 ** record.decimals);
    return `${value} ${record.symbol}`;
  };
  return (
    <div style={s("display:flex;flex-direction:column;gap:12px")}>
      <div style={s("display:flex;gap:8px")}>
        <input
          value={st.lookup}
          onChange={(e) => c.setState({ lookup: e.target.value.trim() })}
          placeholder="0x… or G…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Transaction or address"
          style={s(
            "flex:1 1 auto;width:0;min-width:0;padding:12px 15px;background:var(--mv-surface-2);border:1px solid transparent;border-radius:12px;outline:none;font-family:var(--mv-font);font-size:12.5px",
          )}
        />
        <button
          type="button"
          onClick={() => void c.onFind()}
          className={pseudo({
            hover: "background:var(--mv-surface-3)",
            active: "transform:translateY(1px)",
          })}
          style={s(
            "flex:0 0 auto;padding:12px 16px;background:var(--mv-surface-2);border:1px solid var(--mv-rule);border-radius:12px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;color:var(--mv-ink)",
          )}
        >
          Find
        </button>
      </div>

      {st.lookupNote !== null ? (
        <p
          style={s(
            `margin:0 2px;font-size:12.5px;line-height:1.5;color:${st.lookupNoteKind === "fault" ? "var(--mv-signal)" : "var(--mv-muted-2)"};text-wrap:pretty`,
          )}
        >
          {st.lookupNote}
        </p>
      ) : null}

      {st.found !== null ? (
        <div
          style={s(
            "display:flex;flex-direction:column;gap:12px;padding:15px 16px;background:var(--mv-surface-2);border-radius:14px",
          )}
        >
          <div>
            <div
              style={s(
                `height:3px;border-radius:2px;transition:background 300ms linear;background:${
                  st.found.tone === "ok"
                    ? "var(--mv-white)"
                    : st.found.tone === "bad"
                      ? "var(--mv-signal-strong)"
                      : // information: neither the success white nor the warning signal
                        st.found.tone === "info"
                        ? "var(--mv-muted-b)"
                        : "var(--mv-track-neutral)"
                }`,
              )}
            />
            <p style={s("margin:13px 0 0;font-size:13.5px;font-weight:500")}>
              Move your funds to Stellar
            </p>
            <p
              style={s(
                "margin:6px 0 0;font-size:12.5px;line-height:1.5;color:var(--mv-muted-2);text-wrap:pretty",
              )}
            >
              {st.found.note}
            </p>
            {st.found.link !== undefined ? (
              <a
                href={st.found.link.href}
                target="_blank"
                rel="noreferrer noopener"
                style={s(
                  "display:inline-block;margin-top:7px;font-size:12px;color:var(--mv-muted-b);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--mv-rule-hover)",
                )}
              >
                {st.found.link.label} ↗
              </a>
            ) : null}
          </div>
          {st.found.canFinish ? (
            <button
              type="button"
              onClick={() => void c.onFinish()}
              className={pseudo({
                hover: "background:var(--mv-signal-tint);border-color:var(--mv-signal-strong)",
                active: "transform:translateY(1px)",
              })}
              style={s(
                "align-self:flex-start;padding:9px 14px;background:transparent;border:1px solid var(--mv-signal-outline);border-radius:999px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:500;color:var(--mv-ink)",
              )}
            >
              Finish the delivery
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        style={s(
          "display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 2px 0",
        )}
      >
        <h2
          style={s(
            "margin:0;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
          )}
        >
          From this browser
        </h2>
        {st.history.length > 0 ? (
          <button
            type="button"
            onClick={() => c.clearHistory()}
            className={pseudo({ hover: "color:var(--mv-ink)" })}
            style={s(
              "padding:2px 6px;margin:-2px -6px;background:transparent;border:0;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
            )}
          >
            Clear
          </button>
        ) : null}
      </div>

      {st.history.length > 0 ? (
        <div style={s("display:flex;flex-direction:column;gap:6px")}>
          {st.history.map((h) => (
            <div
              key={h.sourceTxHash}
              style={s(
                "display:flex;align-items:center;gap:12px;padding:13px 16px;background:var(--mv-surface-2);border-radius:12px",
              )}
            >
              <div style={s("flex:1 1 auto;min-width:0")}>
                <p
                  style={s(
                    "margin:0;font-family:var(--mv-font);font-size:13px;font-weight:500;letter-spacing:-0.02em",
                  )}
                >
                  {figures(readable(h))}
                </p>
                <p style={s("margin:4px 0 0;font-size:12px;color:var(--mv-muted-2)")}>
                  {`From ${h.sourceChainName} `}
                  {h.explorerUrl !== undefined ? (
                    <a
                      href={h.explorerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={s("font-family:var(--mv-font);font-size:10px;color:var(--mv-muted-b)")}
                    >
                      ↗
                    </a>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                onClick={() => c.setState({ lookup: h.sourceTxHash }, () => void c.onFind())}
                className={pseudo({
                  hover: "border-color:var(--mv-rule-hover);color:var(--mv-ink)",
                })}
                style={s(
                  "flex:0 0 auto;padding:5px 11px;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-ink-3)",
                )}
              >
                Check
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p style={s("margin:0 2px;font-size:12.5px;color:var(--mv-muted-2)")}>
          Nothing on this browser yet.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ routes panel ---

export function renderRoutes(
  c: Flow,
  d: {
    sym: string;
    /** What has to be given before any rail is asked, if anything. */
    resting: "amount" | "recipient" | undefined;
    embed?: boolean;
    pick?: boolean;
  },
): ReactElement {
  const st = c.state;
  const { sym, embed = false, pick = false } = d;
  const resting = d.resting !== undefined;
  const xlm = st.wanted === "XLM";
  const routes = st.routes;
  const expected = enabledRailCount(st.rails);
  const best =
    routes.length > 0 ? routes.reduce((a, b) => (b.receives > a.receives ? b : a)) : undefined;
  const fastest =
    routes.length > 0 ? routes.reduce((a, b) => (b.minutes < a.minutes ? b : a)) : undefined;

  const enabledRails: RailName[] = (
    ["Circle", "Axelar", "LayerZero", "NEAR Intents"] as RailName[]
  ).filter((n) => st.rails[n] !== false);
  const landed = new Set(routes.map((x) => x.source));
  const declinedNames = new Set(st.rejected.map((r) => railDisplay(r.source)));
  const awaiting = enabledRails.filter((n) => !landed.has(n) && !declinedNames.has(n));
  const declines =
    st.showDeclined && st.complete && !resting
      ? visibleDeclines(
          st.rejected,
          routes.map((x) => x.route.source),
        ).map((r) => ({
          key: `${r.source}-${r.reason}`,
          source: railDisplay(r.source),
          why: r.explanation,
          // The backend says whether asking again can change the answer. A
          // retryable decline offers a re-ask; a settled one does not.
          retryable: r.retryable,
        }))
      : [];

  const routesStatus = resting
    ? `Awaiting ${d.resting === "recipient" ? "a recipient" : "an amount"}`
    : st.quoting
      ? "Asking"
      : `${routes.length} of ${expected}`;

  return (
    <div
      ref={embed ? undefined : c.routesRef}
      style={
        embed
          ? s("position:relative;z-index:1;display:flex;flex-direction:column")
          : s(
              "position:relative;z-index:1;flex:0 0 auto;width:380px;height:624px;max-width:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--mv-surface);border:1px solid var(--mv-rule-hair);border-radius:18px;padding:18px",
            )
      }
    >
      {pick ? null : (
        <div
          style={
            embed
              ? s(
                  "flex:0 0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:16px 2px 14px;margin-top:4px;border-top:1px solid var(--mv-rule-hair)",
                )
              : s(
                  "flex:0 0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 2px 14px",
                )
          }
        >
          <h2 style={s("margin:0;font-size:15px;font-weight:600;letter-spacing:-0.01em")}>
            Receive
          </h2>
          <span
            style={s(
              "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
            )}
          >
            {routesStatus}
          </span>
        </div>
      )}

      <div
        style={
          embed
            ? s("display:flex;flex-direction:column;gap:8px")
            : s(
                "flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;padding-left:4px;margin-left:-4px;padding-right:9px;margin-right:-13px;scrollbar-gutter:stable",
              )
        }
      >
        {routes.map((x, i) => {
          const on = x.id === st.selected;
          const isBest = best !== undefined && x.id === best.id;
          const isFastest =
            fastest !== undefined &&
            x.id === fastest.id &&
            best !== undefined &&
            fastest.id !== best.id;
          const badged = isBest || isFastest;
          const open = st.expanded === x.id;
          const detail = routeDetail(x, sym, xlm, c.state.reserveFunding === "self");
          const cardStyle: CSSProperties = {
            position: "relative",
            width: "100%",
            color: "var(--mv-ink)",
            background: on ? "var(--mv-surface-3)" : "var(--mv-surface-2)",
            border: `1px solid ${on ? "var(--mv-rule-max)" : "transparent"}`,
            borderRadius: "14px",
            transition: "background 160ms cubic-bezier(0.2,0,0,1)",
          };
          const badgeStyle: CSSProperties = {
            display: "inline-block",
            padding: "4px 10px",
            borderRadius: "999px",
            visibility: badged ? "visible" : "hidden",
            background: on ? "var(--mv-white)" : "var(--mv-rule)",
            color: on ? "var(--mv-on-light)" : "var(--mv-ink-strong)",
            fontFamily: "var(--mv-font)",
            fontSize: "9.5px",
            fontWeight: "var(--mv-caps-weight)",
            letterSpacing: "var(--mv-caps-track)",
            textTransform: "uppercase",
          };
          return (
            <div
              key={x.id}
              ref={(el) => {
                c.rows[i] = el;
              }}
              style={cardStyle}
            >
              <div
                style={s(
                  "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 15px 0",
                )}
              >
                <span style={badgeStyle}>{isBest ? "Best return" : "Fastest"}</span>
                <button
                  type="button"
                  onClick={() =>
                    c.setState((prev) => ({ expanded: prev.expanded === x.id ? null : x.id }))
                  }
                  aria-expanded={open}
                  aria-label={`${open ? "Hide" : "Show"} ${x.source} route detail`}
                  className={pseudo({
                    hover: "background:var(--mv-surface-4);color:var(--mv-ink)",
                    active: "transform:translateY(1px)",
                  })}
                  style={s(
                    "flex:0 0 auto;width:28px;height:28px;display:grid;place-items:center;background:transparent;border:1px solid var(--mv-rule-2);border-radius:999px;cursor:pointer;font-family:var(--mv-font);font-size:13px;line-height:1;color:var(--mv-ink-2)",
                  )}
                >
                  {open ? "▴" : "▾"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  c.setState({ selected: x.id, picked: true });
                  c.emit({ type: "routeSelected", source: x.source, receives: x.receives });
                }}
                aria-pressed={on}
                style={s(
                  "display:block;width:100%;padding:12px 16px 16px;background:transparent;border:0;cursor:pointer;font:inherit;color:inherit;text-align:left",
                )}
              >
                <span style={s("display:flex;flex-wrap:wrap;align-items:baseline;gap:10px")}>
                  <span
                    style={s(
                      "min-width:0;overflow-wrap:anywhere;font-family:var(--mv-font-num);font-size:22px;font-weight:500;letter-spacing:-0.05em",
                    )}
                  >
                    {fmt(x.receives)}
                    <span
                      style={s(
                        "font-family:var(--mv-font);font-size:11.5px;font-weight:400;letter-spacing:0;color:var(--mv-muted-2);margin-left:7px",
                      )}
                    >
                      {sym}
                    </span>
                  </span>
                  <span
                    style={s(
                      "margin-left:auto;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10.5px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted);white-space:nowrap",
                    )}
                  >
                    {railLabel(x)}
                  </span>
                </span>
                <span
                  style={s(
                    "display:block;margin-top:11px;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted-2)",
                  )}
                >
                  {x.compose === undefined
                    ? x.trust
                    : `${x.trust} · ${x.compose.walletNote} ${x.compose.fallback}`}
                </span>
                <span
                  style={s(
                    "display:flex;align-items:center;gap:16px;margin-top:14px;padding-top:13px;border-top:1px solid var(--mv-rule-hair);font-family:var(--mv-font-num);font-size:10.5px;letter-spacing:0.02em;color:var(--mv-muted-2)",
                  )}
                >
                  <span
                    style={s("display:flex;align-items:center;gap:6px;white-space:nowrap")}
                    title={`Transfer fee in ${x.feeSymbol}`}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={s("flex:0 0 auto;color:var(--mv-faint)")}
                    >
                      <circle cx="12" cy="12" r="8.5" />
                      <path d="M12 8v8M9.5 10.2c0-1.2 1.1-2.2 2.5-2.2s2.5 1 2.5 2.2c0 2.6-5 1.4-5 3.9 0 1.2 1.1 2.1 2.5 2.1s2.5-.9 2.5-2.1" />
                    </svg>
                    <span>{x.feeAmount}</span>
                  </span>
                  <span
                    style={s("display:flex;align-items:center;gap:6px;white-space:nowrap")}
                    title="Estimated time"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={s("flex:0 0 auto;color:var(--mv-faint)")}
                    >
                      <circle cx="12" cy="12" r="8.5" />
                      <path d="M12 7.8V12l3 1.9" />
                    </svg>
                    <span style={s("font-family:var(--mv-font)")}>
                      ~<span style={FIGURE_FACE}>{x.minutes}</span>m
                    </span>
                  </span>
                  <span
                    style={s(
                      "display:flex;align-items:center;gap:6px;margin-left:auto;white-space:nowrap",
                    )}
                    title={`${x.sigsUpTo ? "Up to " : ""}${x.sigs} approvals in your wallet`}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={s("flex:0 0 auto;color:var(--mv-faint)")}
                    >
                      <path d="M8.5 12.5l2.5 2.5 5-6" />
                      <path d="M4.5 12.5l2.5 2.5" />
                    </svg>
                    <span>{String(x.sigs)}</span>
                  </span>
                </span>
              </button>
              {open ? (
                <div
                  style={s(
                    "display:flex;flex-direction:column;gap:10px;margin:0 14px 14px;padding:14px;background:var(--mv-surface);border-radius:10px",
                  )}
                >
                  {detail.map((row) => (
                    <div
                      key={row.key}
                      style={s(
                        "display:flex;align-items:baseline;justify-content:space-between;gap:14px",
                      )}
                    >
                      <span style={s("font-size:12px;color:var(--mv-muted-2)")}>{row.name}</span>
                      <span
                        style={s(
                          "font-family:var(--mv-font);font-size:12px;color:var(--mv-ink-strong);text-align:right",
                        )}
                      >
                        {figures(row.value)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {resting ? (
          <div
            style={s(
              "flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:26px;padding:24px 12px",
            )}
          >
            <svg
              viewBox={MAVNA_MARK_VIEWBOX}
              aria-hidden="true"
              fill="currentColor"
              style={s(
                "width:46px;height:46px;display:block;color:var(--mv-ink);animation:mv-emerge 520ms cubic-bezier(0.2,0,0,1) both,mv-breathe 4600ms cubic-bezier(0.4,0,0.6,1) 640ms infinite",
              )}
            >
              <path d={MAVNA_MARK_PATH} />
            </svg>
            <div
              style={s(
                "display:flex;align-items:stretch;gap:0;animation:mv-emerge 520ms cubic-bezier(0.2,0,0,1) 90ms both",
              )}
            >
              <div
                style={s(
                  "display:flex;flex-direction:column;align-items:center;gap:7px;padding:0 22px",
                )}
              >
                <span
                  style={s(
                    "font-family:var(--mv-font-num);font-size:32px;font-weight:500;letter-spacing:-0.05em;line-height:1;color:var(--mv-ink)",
                  )}
                >
                  {c.list().length}
                </span>
                <span
                  style={s(
                    "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
                  )}
                >
                  Chains
                </span>
              </div>
              <span style={s("width:1px;background:var(--mv-rule)")} />
              <div
                style={s(
                  "display:flex;flex-direction:column;align-items:center;gap:7px;padding:0 22px",
                )}
              >
                <span
                  style={s(
                    "font-family:var(--mv-font-num);font-size:32px;font-weight:500;letter-spacing:-0.05em;line-height:1;color:var(--mv-ink)",
                  )}
                >
                  {expected}
                </span>
                <span
                  style={s(
                    "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
                  )}
                >
                  {expected === 1 ? "Rail" : "Rails"}
                </span>
              </div>
            </div>
            <div style={s("display:flex;flex-direction:column;gap:6px;max-width:266px")}>
              <p
                style={s(
                  "margin:0;font-size:14px;font-weight:500;letter-spacing:-0.01em;color:var(--mv-ink-strong);animation:mv-emerge 520ms cubic-bezier(0.2,0,0,1) 160ms both",
                )}
              >
                Every route into Stellar, asked at once.
              </p>
              <p
                style={s(
                  "margin:0;font-size:12.5px;line-height:1.55;color:var(--mv-faint);text-wrap:pretty;animation:mv-emerge 520ms cubic-bezier(0.2,0,0,1) 220ms both",
                )}
              >
                {`Mavna ranks them by what actually arrives. ${d.resting === "recipient" ? "Set a recipient" : "Enter an amount"} to compare.`}
              </p>
            </div>
          </div>
        ) : null}

        {awaiting.length > 0 && !resting && !st.complete
          ? awaiting.map((a) => (
              <div
                key={a}
                style={s(
                  "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px;border:1px dashed var(--mv-rule);border-radius:14px",
                )}
              >
                <span
                  style={s(
                    "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
                  )}
                >
                  {a}
                </span>
                <span
                  style={s(
                    "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faintest)",
                  )}
                >
                  Asking
                </span>
              </div>
            ))
          : null}

        {declines.length > 0
          ? declines.map((decline) => (
              <div
                key={decline.key}
                style={s(
                  "display:flex;flex-direction:column;gap:10px;padding:16px;border:1px dashed var(--mv-rule);border-radius:14px",
                )}
              >
                <div
                  style={s(
                    "display:flex;align-items:center;justify-content:space-between;gap:10px",
                  )}
                >
                  <span
                    style={s(
                      "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faint)",
                    )}
                  >
                    {decline.source}
                  </span>
                  <span
                    style={s(
                      "font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-faintest)",
                    )}
                  >
                    Declined
                  </span>
                </div>
                <p
                  title={decline.why}
                  style={s(
                    "margin:0;min-width:0;font-size:12.5px;line-height:1.45;color:var(--mv-muted-2);text-wrap:pretty;overflow-wrap:anywhere",
                  )}
                >
                  {shortIds(decline.why)}
                </p>
                {decline.retryable ? (
                  <button
                    type="button"
                    onClick={() => c.runQuote()}
                    className={pseudo({
                      hover: "color:var(--mv-ink);border-color:var(--mv-rule-hover)",
                    })}
                    style={s(
                      "align-self:flex-start;padding:5px 11px;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font);font-weight:var(--mv-caps-weight);font-size:10px;letter-spacing:var(--mv-caps-track);text-transform:uppercase;color:var(--mv-muted)",
                    )}
                  >
                    Try again
                  </button>
                ) : null}
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

/** The expanded route detail rows, from real route figures. */
export function routeDetail(
  x: RouteView,
  sym: string,
  xlm: boolean,
  /** The account pays its own way, so finishing a conversion by hand is its cost. */
  selfFunded = false,
): { key: string; name: string; value: string }[] {
  // the rate is per unit of what was sent; a fee only comes off it when it is
  // paid in that same asset, never gas in another
  const sends = x.route.sends;
  const bridgeFee = x.route.fees.find((f) => f.kind === "bridge");
  const sameAsset = bridgeFee !== undefined && bridgeFee.total.asset.id === sends.asset.id;
  const netBase = BigInt(sends.baseUnits) - (sameAsset ? BigInt(bridgeFee.total.baseUnits) : 0n);
  const net = fromBaseUnits(netBase > 0n ? netBase.toString() : "0", sends.asset.decimals);
  const perUnit = net > 0 ? x.receives / net : 0;
  return [
    { key: "rail", name: "Rail", value: x.source },
    {
      key: "fee",
      name: "Transfer fee",
      value: x.fee === 0 ? "None" : `${x.feeAmount} ${x.feeSymbol}`,
    },
    {
      key: "min",
      name: x.exact ? "You receive" : "Minimum received",
      value: `${fmtAmount(x.route.receivesAtLeast, 7)} ${sym}`,
    },
    ...(xlm
      ? [
          {
            key: "rate",
            name: "Conversion rate",
            value: `1 ${sends.asset.symbol} ≈ ${perUnit.toFixed(4)} XLM`,
          },
        ]
      : []),
    ...(x.swapVenue !== undefined
      ? [{ key: "venue", name: "Converted on", value: x.swapVenue }]
      : []),
    ...(x.compose !== undefined
      ? [
          { key: "compose", name: "Conversion", value: x.compose.label },
          { key: "wallet", name: "Stellar wallet", value: x.compose.walletNote },
          { key: "fallback", name: "If it cannot convert", value: x.compose.fallback },
          { key: "trust", name: "Who is trusted", value: x.compose.trust },
          // paying its own way, the account finishes an overdue conversion itself
          ...(selfFunded && x.compose.finishXlm !== undefined
            ? [
                {
                  key: "finish",
                  name: "If you finish it yourself",
                  value: `Up to ${x.compose.finishXlm} XLM from your account, simulated now`,
                },
              ]
            : []),
        ]
      : []),
    ...(x.newAccount && x.reserveXlm !== undefined
      ? [{ key: "res", name: "Account reserve", value: `${fmt(x.reserveXlm)} XLM` }]
      : []),
    ...(x.repaymentSetAside !== undefined
      ? [
          {
            key: "repay",
            name: "Left unconverted to repay the reserve",
            value: `${fmt(x.repaymentSetAside.amount)} ${x.repaymentSetAside.symbol}`,
          },
        ]
      : []),
    { key: "sig", name: "Approvals", value: approvalsLabel(x) },
    { key: "eta", name: "Estimated time", value: `About ${x.minutes} min` },
    { key: "settle", name: "Settles on", value: "Stellar" },
  ];
}
