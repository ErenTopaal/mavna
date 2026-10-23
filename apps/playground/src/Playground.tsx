import {
  type Appearance,
  type HiddenUIElement,
  MavnaWidget,
  type MavnaWidgetConfig,
  type MavnaWidgetEvent,
  type RailName,
  type Variant,
} from "@mavna/widget";
import {
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MAVNA_MARK_PATH, MAVNA_MARK_VIEWBOX } from "./mark.js";
import { buildSource } from "./source.js";

/*
 * A live configurator for the Mavna widget. The rail on the left writes a config;
 * the stage renders the widget with it, and the dock beneath prints the exact
 * config an integrator would paste and logs the events the widget emits.
 *
 * It offers the two embeddable variants: `compact` (the inline card) and `drawer`
 * (that card in a popup that rises from the bottom). The `wide` variant is the
 * full Mavna app, which lives at mavna.app, so it is not a playground concern.
 */

const ALL_RAILS: readonly RailName[] = ["Circle", "Axelar", "LayerZero", "NEAR Intents"];
const HIDEABLE: readonly HiddenUIElement[] = [
  "activity",
  "settings",
  "networkToggle",
  "railToggles",
  "poweredBy",
];
const DOCK_MIN = 160;
const DEFAULT_ACCENT = "#e5484d";
const INTEGRATOR = "playground.mavna.app";
// set at build time, and vite.config.ts refuses a production build without it.
// a dev server leaves it unset, so the widget asks the sponsor on localhost:8787.
const SPONSOR_URL: string | undefined = import.meta.env.VITE_MAVNA_SPONSOR_URL || undefined;

// ready-made looks: each is a tint (hue and strength) for the grounds and surfaces,
// in a light and a dark set that follow the appearance, plus an accent. The text
// tokens stay the widget's own, so their contrast stays what the widget measures
type LookId = "default" | "midnight" | "ocean" | "forest" | "plum" | "rose" | "sand";
type Surfaces = Record<string, string>;
const tint = (hue: number, chroma: number, light: boolean): Surfaces => {
  if (chroma === 0) return {};
  return light
    ? {
        "--mv-ground": `oklch(0.975 ${chroma * 0.5} ${hue})`,
        "--mv-surface": `oklch(0.995 ${chroma * 0.25} ${hue})`,
        "--mv-surface-2": `oklch(0.96 ${chroma * 0.6} ${hue})`,
        "--mv-surface-3": `oklch(0.93 ${chroma * 0.75} ${hue})`,
        "--mv-surface-4": `oklch(0.89 ${chroma * 0.85} ${hue})`,
      }
    : {
        "--mv-ground": `oklch(0.15 ${chroma} ${hue})`,
        "--mv-surface": `oklch(0.2 ${chroma * 1.2} ${hue})`,
        "--mv-surface-2": `oklch(0.24 ${chroma * 1.28} ${hue})`,
        "--mv-surface-3": `oklch(0.27 ${chroma * 1.36} ${hue})`,
        "--mv-surface-4": `oklch(0.31 ${chroma * 1.44} ${hue})`,
      };
};
// strength runs 0..100 on the slider; 100 is a clearly coloured but still quiet tint
const MAX_CHROMA = 0.04;
const LOOKS: readonly {
  id: LookId;
  label: string;
  accent: string;
  hue: number;
  strength: number;
}[] = [
  { id: "default", label: "Default", accent: DEFAULT_ACCENT, hue: 260, strength: 0 },
  { id: "midnight", label: "Midnight", accent: "#4c8dff", hue: 260, strength: 62 },
  { id: "ocean", label: "Ocean", accent: "#1fb6c9", hue: 210, strength: 55 },
  { id: "forest", label: "Forest", accent: "#2f9e64", hue: 160, strength: 52 },
  { id: "plum", label: "Plum", accent: "#b45ce0", hue: 320, strength: 62 },
  { id: "rose", label: "Rose", accent: "#e5487a", hue: 10, strength: 50 },
  { id: "sand", label: "Sand", accent: "#c2410c", hue: 75, strength: 55 },
];
const CORNERS = {
  sharp: { radius: "4px", radiusLg: "6px", pill: "6px" },
  soft: { radius: "12px", radiusLg: "18px", pill: "999px" },
  round: { radius: "16px", radiusLg: "26px", pill: "999px" },
} as const;
type Corners = keyof typeof CORNERS;
const FONTS = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;
type FontId = keyof typeof FONTS;

export function Playground(): ReactElement {
  const [variant, setVariant] = useState<Exclude<Variant, "wide">>("compact");
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [priority, setPriority] = useState<"best-received" | "fastest">("best-received");
  const [rails, setRails] = useState<readonly RailName[]>(ALL_RAILS);
  const [hidden, setHidden] = useState<readonly HiddenUIElement[]>([]);
  const [requireDest, setRequireDest] = useState(false);
  const [toAddress, setToAddress] = useState("");
  const [fromChain, setFromChain] = useState("");
  const [fromAmount, setFromAmount] = useState("");
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [log, setLog] = useState<readonly string[]>([]);
  const [tab, setTab] = useState<"config" | "events">("config");
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [look, setLook] = useState<LookId>("default");
  const [hue, setHue] = useState(260);
  const [strength, setStrength] = useState(0);
  const [corners, setCorners] = useState<Corners>("soft");
  const [font, setFont] = useState<FontId>("system");
  const [figures, setFigures] = useState<"mono" | "text">("mono");
  const [dockHeight, setDockHeight] = useState(420);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // The playground's own light/dark, separate from the widget's configured
  // appearance; it themes the chrome only.
  useEffect(() => {
    document.documentElement.dataset.pgTheme = theme;
  }, [theme]);

  const onHandleDown = (e: ReactPointerEvent): void => {
    drag.current = { y: e.clientY, h: dockHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent): void => {
    const d = drag.current;
    if (d === null) return;
    // Dragging the handle up grows the dock, down shrinks it.
    const next = d.h + (d.y - e.clientY);
    setDockHeight(Math.max(DOCK_MIN, Math.min(next, window.innerHeight - 220)));
  };
  const onHandleUp = (e: ReactPointerEvent): void => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // the looks pick their light or dark set from what the widget will actually show
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  const dark = appearance === "dark" || (appearance === "system" && systemDark);

  const onEvent = useCallback((e: MavnaWidgetEvent) => {
    setLog((prev) => [describeEvent(e), ...prev].slice(0, 60));
  }, []);

  const config: MavnaWidgetConfig = useMemo(() => {
    const corner = CORNERS[corners];
    const tokens = {
      ...tint(hue, (strength / 100) * MAX_CHROMA, !dark),
      ...(accent === DEFAULT_ACCENT ? {} : { "--mv-signal": accent, "--mv-signal-strong": accent }),
      ...(corners === "soft" ? {} : { "--mv-radius-pill": corner.pill }),
    };
    const theme = {
      ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
      ...(font === "system" ? {} : { font: FONTS[font] }),
      ...(figures === "text" ? { fontMono: FONTS[font] } : {}),
      ...(corners === "soft" ? {} : { radius: corner.radius, radiusLg: corner.radiusLg }),
    };
    return {
      integrator: INTEGRATOR,
      network: "testnet",
      ...(SPONSOR_URL !== undefined ? { sponsorUrl: SPONSOR_URL } : {}),
      variant,
      appearance,
      routePriority: priority,
      ...(rails.length < ALL_RAILS.length ? { rails } : {}),
      ...(hidden.length > 0 ? { hiddenUI: hidden } : {}),
      ...(requireDest ? { requiredUI: ["destination"] as const } : {}),
      ...(toAddress.trim() !== "" ? { toAddress: toAddress.trim() } : {}),
      ...(fromChain.trim() !== "" ? { fromChain: fromChain.trim() } : {}),
      ...(fromAmount.trim() !== "" ? { fromAmount: fromAmount.trim() } : {}),
      ...(Object.keys(theme).length > 0 ? { theme } : {}),
      onEvent,
    };
  }, [
    variant,
    appearance,
    priority,
    rails,
    hidden,
    requireDest,
    toAddress,
    fromChain,
    fromAmount,
    accent,
    hue,
    strength,
    corners,
    font,
    figures,
    dark,
    onEvent,
  ]);

  const source = useMemo(() => buildSource(config), [config]);

  const toggleRail = (name: RailName): void => {
    setRails((prev) => {
      const has = prev.includes(name);
      if (has && prev.length === 1) return prev; // never zero rails
      return has ? prev.filter((r) => r !== name) : [...prev, name];
    });
  };
  const toggleHidden = (el: HiddenUIElement): void => {
    setHidden((prev) => (prev.includes(el) ? prev.filter((h) => h !== el) : [...prev, el]));
  };
  const copy = (): void => {
    void navigator.clipboard?.writeText(source).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  // Re-mount the widget when structural config changes, so it picks up a fresh
  // engine and initial state rather than reconciling in place.
  const widgetKey = `${variant}-${appearance}-${rails.join()}-${requireDest}-${fromChain}-${fromAmount}-${toAddress}`;

  return (
    <div className="pg-app">
      <header className="pg-header">
        <svg
          className="pg-mark"
          viewBox={MAVNA_MARK_VIEWBOX}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d={MAVNA_MARK_PATH} />
        </svg>
        <span className="pg-brand">MAVNA</span>
        <span className="pg-eyebrow">Playground</span>
        <div className="pg-header-right">
          <button
            type="button"
            className="pg-toggle"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label="Toggle theme"
            title="Toggle theme"
          >
            {theme === "light" ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            )}
          </button>
          <a className="pg-header-link" href="https://web.mavna.app">
            Home
          </a>
          <a className="pg-header-link" href="https://mavna.app">
            App
          </a>
          <a className="pg-header-link" href="https://docs.mavna.app">
            Docs
          </a>
          <a
            className="pg-header-link"
            href="https://github.com/ErenTopaal/mavna"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </header>

      <div className="pg-body">
        <aside className="pg-rail">
          <div className="pg-group">
            <p className="pg-group-title">Layout</p>
            <div className="pg-row">
              <span className="pg-row-label">Variant</span>
              <Segmented
                value={variant}
                options={[
                  ["compact", "Compact"],
                  ["drawer", "Drawer"],
                ]}
                onChange={setVariant}
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Appearance</span>
              <Segmented
                value={appearance}
                options={[
                  ["system", "Auto"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ]}
                onChange={setAppearance}
              />
            </div>
          </div>

          <div className="pg-group">
            <p className="pg-group-title">Routing</p>
            <div className="pg-row">
              <span className="pg-row-label">Priority</span>
              <Segmented
                value={priority}
                options={[
                  ["best-received", "Received"],
                  ["fastest", "Fastest"],
                ]}
                onChange={setPriority}
              />
            </div>
            {ALL_RAILS.map((name) => (
              <label className="pg-check" key={name}>
                <input
                  type="checkbox"
                  checked={rails.includes(name)}
                  onChange={() => toggleRail(name)}
                />
                {name}
              </label>
            ))}
          </div>

          <div className="pg-group">
            <p className="pg-group-title">Hide UI</p>
            {HIDEABLE.map((el) => (
              <label className="pg-check" key={el}>
                <input
                  type="checkbox"
                  checked={hidden.includes(el)}
                  onChange={() => toggleHidden(el)}
                />
                {el}
              </label>
            ))}
          </div>

          <div className="pg-group">
            <p className="pg-group-title">Recipient</p>
            <label className="pg-check">
              <input
                type="checkbox"
                checked={requireDest}
                onChange={() => setRequireDest((v) => !v)}
              />
              Lock recipient
            </label>
            <div className="pg-field">
              <span className="pg-field-label">toAddress</span>
              <input
                className="pg-input"
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                placeholder="G…, M… or C…"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="pg-group">
            <p className="pg-group-title">Form start</p>
            <div className="pg-field">
              <span className="pg-field-label">fromChain</span>
              <input
                className="pg-input"
                value={fromChain}
                onChange={(e) => setFromChain(e.target.value)}
                placeholder="ethereum-sepolia"
                spellCheck={false}
              />
            </div>
            <div className="pg-field">
              <span className="pg-field-label">fromAmount</span>
              <input
                className="pg-input"
                value={fromAmount}
                onChange={(e) => setFromAmount(e.target.value)}
                placeholder="10"
                inputMode="decimal"
              />
            </div>
          </div>

          <div className="pg-group">
            <p className="pg-group-title">Theme</p>
            <div className="pg-looks">
              <span className="pg-row-label">Look</span>
              <span className="pg-look-list">
                {LOOKS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className="pg-look"
                    aria-pressed={look === l.id}
                    onClick={() => {
                      setLook(l.id);
                      setAccent(l.accent);
                      setHue(l.hue);
                      setStrength(l.strength);
                    }}
                  >
                    <span
                      className="pg-look-swatch"
                      style={{
                        background:
                          tint(l.hue, (l.strength / 100) * MAX_CHROMA, !dark)["--mv-surface"] ??
                          (dark ? "#262626" : "#ffffff"),
                      }}
                    >
                      <span style={{ background: l.accent }} />
                    </span>
                    {l.label}
                  </button>
                ))}
              </span>
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Tint</span>
              <input
                className="pg-slider"
                type="range"
                min={0}
                max={360}
                value={hue}
                onChange={(e) => {
                  setHue(Number(e.target.value));
                  setLook("default");
                  if (strength === 0) setStrength(50);
                }}
                aria-label="Tint hue"
                style={{
                  background:
                    "linear-gradient(to right, oklch(0.7 0.12 0), oklch(0.7 0.12 60), oklch(0.7 0.12 120), oklch(0.7 0.12 180), oklch(0.7 0.12 240), oklch(0.7 0.12 300), oklch(0.7 0.12 360))",
                }}
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Tint strength</span>
              <input
                className="pg-slider"
                type="range"
                min={0}
                max={100}
                value={strength}
                onChange={(e) => {
                  setStrength(Number(e.target.value));
                  setLook("default");
                }}
                aria-label="Tint strength"
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Corners</span>
              <Segmented
                value={corners}
                options={[
                  ["sharp", "Sharp"],
                  ["soft", "Soft"],
                  ["round", "Round"],
                ]}
                onChange={setCorners}
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Text</span>
              <Segmented
                value={font}
                options={[
                  ["system", "Sans"],
                  ["serif", "Serif"],
                  ["rounded", "Round"],
                  ["mono", "Mono"],
                ]}
                onChange={setFont}
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Figures</span>
              <Segmented
                value={figures}
                options={[
                  ["mono", "Mono"],
                  ["text", "Like text"],
                ]}
                onChange={setFigures}
              />
            </div>
            <div className="pg-row">
              <span className="pg-row-label">Signal accent</span>
              <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {accent !== DEFAULT_ACCENT ? (
                  <button
                    type="button"
                    className="pg-reset"
                    onClick={() => setAccent(DEFAULT_ACCENT)}
                  >
                    Reset
                  </button>
                ) : null}
                <input
                  className="pg-color"
                  type="color"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  aria-label="Accent colour"
                />
              </span>
            </div>
          </div>
        </aside>

        <main className="pg-main">
          <div className="pg-stage">
            <div className="pg-spot" aria-hidden="true" />
            <div className="pg-grain" aria-hidden="true" />
            <MavnaWidget key={widgetKey} config={config} />
          </div>

          <div className="pg-dock" style={{ height: `${dockHeight}px` }}>
            <div
              className="pg-dock-handle"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            >
              <input
                className="pg-dock-range"
                type="range"
                min={DOCK_MIN}
                max={Math.max(DOCK_MIN, window.innerHeight - 220)}
                step={20}
                value={dockHeight}
                onChange={(e) => setDockHeight(Number(e.target.value))}
                aria-label="Resize panel"
              />
              <span className="pg-dock-grip" />
            </div>
            <div className="pg-tabs">
              <button
                type="button"
                className="pg-tab"
                data-on={tab === "config"}
                onClick={() => setTab("config")}
              >
                Config
              </button>
              <button
                type="button"
                className="pg-tab"
                data-on={tab === "events"}
                onClick={() => setTab("events")}
              >
                Events
                {log.length > 0 ? <span className="pg-tab-badge">{log.length}</span> : null}
              </button>
              {tab === "config" ? (
                <button type="button" className="pg-dock-action" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
              ) : log.length > 0 ? (
                <button type="button" className="pg-dock-action" onClick={() => setLog([])}>
                  Clear
                </button>
              ) : null}
            </div>
            <div className="pg-dock-body">
              {tab === "config" ? (
                <pre className="pg-code">{source}</pre>
              ) : (
                <div className="pg-log">
                  {log.length === 0 ? (
                    <span className="pg-log-empty">
                      Interact with the widget (enter an amount, connect, transfer) and the events
                      it emits land here.
                    </span>
                  ) : (
                    log.map((line, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a prepend-only log has no stable id.
                      <span className="pg-log-row" key={i}>
                        {line}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <span className="pg-seg">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          data-on={props.value === value}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function describeEvent(e: MavnaWidgetEvent): string {
  switch (e.type) {
    case "routesAvailable":
      return `routesAvailable · ${e.count} routes, ${e.declined} declined`;
    case "routeSelected":
      return `routeSelected · ${e.source} → ${e.receives}`;
    case "walletConnected":
      return `walletConnected · ${e.ecosystem} ${e.address.slice(0, 6)}…`;
    case "transferStarted":
      return "transferStarted";
    case "transferStepUpdated":
      return `transferStepUpdated · ${e.id} → ${e.phase}`;
    case "transferCompleted":
      return "transferCompleted";
    case "transferFailed":
      return `transferFailed · ${e.reason}`;
    case "transferStillMoving":
      return `transferStillMoving · ${e.reason}`;
    case "transferDeliveredAsCame":
      return `transferDeliveredAsCame · ${e.asset} · ${e.reason}`;
    case "transferDeliveredUnverified":
      return `transferDeliveredUnverified · ${e.stellarTxHash} · ${e.reason}`;
  }
}
