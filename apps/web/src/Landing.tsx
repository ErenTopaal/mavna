import { MavnaWidget, type MavnaWidgetConfig } from "@mavna/widget";
import Lenis from "lenis";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

/*
 * The Mavna landing page. Elements keep their styles inline (parsed from a CSS
 * string by `s`), `Hover` adds a hover style, and the hero shader, the scroll
 * chrome and the reveal-on-scroll all live in one effect. What inline styles
 * cannot say (keyframes, pseudo-elements, breakpoints) is in landing.css.
 */

const APP = "https://mavna.app";
const DOCS = "https://docs.mavna.app";
const DOCS_SDK = "https://docs.mavna.app/developers";
const DOCS_WIDGET = "https://docs.mavna.app/widget";
const PLAYGROUND = "https://playground.mavna.app";
const GITHUB = "https://github.com/ErenTopaal/mavna";

// the widget's own neutrals and its signal red, so the page and the product it
// shows read as one thing
const GROUND = "oklch(0.985 0 0)";
const INK = "oklch(0.205 0 0)";
const MUTED = "oklch(0.46 0 0)";
const FAINT = "oklch(0.72 0 0)";
const RULE = "oklch(0 0 0 / 0.1)";
const NIGHT = "oklch(0.145 0 0)";
const NIGHT_2 = "oklch(0.205 0 0)";
const ON_NIGHT = "oklch(0.97 0 0)";
const MUTED_NIGHT = "oklch(0.74 0 0)";
const RULE_NIGHT = "oklch(1 0 0 / 0.12)";
const SIGNAL = "oklch(0.55 0.2 25)";
const SIGNAL_BRIGHT = "oklch(0.7 0.17 28)";
const OXIDE = "oklch(0.4 0.15 25)";
const ON_OXIDE = "oklch(0.97 0.012 25)";
const MUTED_OXIDE = "oklch(0.88 0.04 25)";

const WRAP =
  "max-width: 1180px; margin: 0 auto; padding-left: clamp(20px, 4vw, 48px); padding-right: clamp(20px, 4vw, 48px)";
const BIG = "margin: 0; font-weight: 300; letter-spacing: -0.04em; line-height: 0.98";

/** Split a box shorthand value into top/right/bottom/left, respecting the spaces
 *  inside functions like clamp(), and applying the 1/2/3/4-value CSS rules. */
function boxSides(value: string): [string, string, string, string] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (cur.trim() !== "") parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  const [a = "0", b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

/** Parse an inline CSS declaration string into a React style object. `padding`
 *  and `margin` shorthands are expanded to longhands: a `Hover` that overrides a
 *  single side (padding-left) must not sit next to the shorthand, or React drops
 *  that side when the hover ends and the padding collapses. */
function s(css: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    if (prop === "") continue;
    const value = decl.slice(i + 1).trim();
    const key = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (key === "padding" || key === "margin") {
      const [t, r, b, l] = boxSides(value);
      out[`${key}Top`] = t;
      out[`${key}Right`] = r;
      out[`${key}Bottom`] = b;
      out[`${key}Left`] = l;
    } else {
      out[key] = value;
    }
  }
  return out as CSSProperties;
}

interface HoverProps {
  readonly as?: "a" | "div";
  readonly base: string;
  readonly hover: string;
  readonly href?: string;
  readonly external?: boolean;
  readonly row2?: boolean;
  readonly children: ReactNode;
}

/** An element whose style gains the `hover` declarations while the pointer is over
 *  it, the way the design's `style-hover` attribute behaved. */
function Hover({ as = "div", base, hover, href, external, row2, children }: HoverProps): ReactNode {
  const [on, setOn] = useState(false);
  const style = on ? { ...s(base), ...s(hover) } : s(base);
  const enter = (): void => setOn(true);
  const leave = (): void => setOn(false);
  if (as === "a") {
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        style={style}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        {children}
      </a>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only drive a decorative hover style, not interaction.
    <div style={style} data-row2={row2 ? "" : undefined} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
    </div>
  );
}

// set at build time, and vite.config.ts refuses a production build without it.
// a dev server leaves it unset, so the widget asks the sponsor on localhost:8787.
const SPONSOR_URL: string | undefined = import.meta.env.VITE_MAVNA_SPONSOR_URL || undefined;

/** A real Mavna widget, mounted only once it nears the viewport so the landing does
 *  not spin up several transfer engines on first paint. It holds its own height
 *  until then, so the page does not jump when the widget arrives. */
function Live({
  config,
  hold,
  style,
}: {
  readonly config: MavnaWidgetConfig;
  readonly hold: number;
  readonly style?: CSSProperties;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (show) return undefined;
    const check = (): void => {
      const el = ref.current;
      if (el && el.getBoundingClientRect().top < window.innerHeight * 1.3) setShow(true);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [show]);
  return (
    <div ref={ref} style={{ minHeight: show ? undefined : hold, ...style }}>
      {show ? (
        <MavnaWidget
          config={SPONSOR_URL === undefined ? config : { ...config, sponsorUrl: SPONSOR_URL }}
        />
      ) : null}
    </div>
  );
}

/** A plain arrow, sized by the text around it. */
function Arrow({ size = "1em" }: { size?: string }): ReactNode {
  return (
    <svg
      data-arrowhead=""
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={s("display: block; flex: none")}
    >
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  );
}

const RAILS = ["Circle CCTP", "LayerZero", "Axelar", "NEAR Intents"];

/** The rails' names drifting past, twice over so the loop has no seam. */
function RailBand(): ReactNode {
  const row = [...RAILS, ...RAILS];
  return (
    <div data-band="" aria-hidden="true" style={s("overflow: hidden; padding: 6px 0")}>
      <div data-band-track="" style={s("display: flex; width: max-content")}>
        {[0, 1].map((copy) => (
          <div key={copy} style={s("display: flex; align-items: center")}>
            {row.map((name, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the names repeat on purpose, so the index is what tells them apart.
                key={`${copy}-${i}`}
                style={s("display: flex; align-items: center")}
              >
                <span
                  style={s(
                    "font-weight: 300; font-size: clamp(56px, 10vw, 150px); letter-spacing: -0.045em; line-height: 1.05; white-space: nowrap; padding: 0 clamp(18px, 2.4vw, 36px)",
                  )}
                >
                  {name}
                </span>
                <img
                  src="/assets/mark-paper.png"
                  alt=""
                  style={s("width: clamp(26px, 3vw, 44px); height: auto; opacity: 0.5")}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const COINS = ["USDC", "USDT0", "XLM"] as const;
type Coin = (typeof COINS)[number];

/** The three hops of a delivery, with the last one set by the coin the visitor picks. */
function CoinPicker(): ReactNode {
  const [coin, setCoin] = useState<Coin>("XLM");
  const stage =
    "flex: 1 1 0; min-width: 0; display: grid; justify-items: center; gap: 18px; text-align: center";
  const disc =
    "width: clamp(150px, 17vw, 210px); aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center; padding: 24px";
  return (
    <div>
      <div data-flow="" style={s("display: flex; align-items: center; gap: 0; position: relative")}>
        <div style={s(stage)}>
          <div style={s(`${disc}; border: 1px solid ${RULE_NIGHT}`)}>
            <span
              style={s(
                `font-size: clamp(17px, 1.6vw, 21px); line-height: 1.3; color: ${MUTED_NIGHT}`,
              )}
            >
              A coin on another chain
            </span>
          </div>
        </div>
        <div
          data-pipe=""
          aria-hidden="true"
          style={s("flex: 0 0 clamp(40px, 7vw, 110px); height: 2px")}
        />
        <div style={s(stage)}>
          <div style={s(`${disc}; background: ${NIGHT_2}`)}>
            <span
              style={s(
                `font-size: clamp(17px, 1.6vw, 21px); line-height: 1.3; color: ${MUTED_NIGHT}`,
              )}
            >
              Whatever that bridge carries
            </span>
          </div>
        </div>
        <div
          data-pipe=""
          aria-hidden="true"
          style={s("flex: 0 0 clamp(40px, 7vw, 110px); height: 2px")}
        />
        <div style={s(stage)}>
          <div
            key={coin}
            data-pop=""
            style={s(
              `width: clamp(170px, 19vw, 240px); aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center; background: ${SIGNAL}; color: ${ON_NIGHT}; box-shadow: 0 30px 80px oklch(0.55 0.2 25 / 0.35)`,
            )}
          >
            <span
              style={s(
                "font-weight: 400; font-size: clamp(34px, 4vw, 54px); letter-spacing: -0.03em",
              )}
            >
              {coin}
            </span>
          </div>
        </div>
      </div>
      <fieldset
        style={s(
          "margin: clamp(40px, 5vw, 60px) 0 0; padding: 0; border: 0; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px",
        )}
      >
        <legend
          style={s(`float: left; margin-right: 14px; font-size: 16px; color: ${MUTED_NIGHT}`)}
        >
          Land it as
        </legend>
        {COINS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === coin}
            onClick={() => setCoin(c)}
            data-chip=""
            style={s(
              `min-height: 46px; padding: 0 22px; border-radius: 999px; font: inherit; font-size: 15.5px; cursor: pointer; border: 1px solid ${c === coin ? ON_NIGHT : RULE_NIGHT}; background: ${c === coin ? ON_NIGHT : "transparent"}; color: ${c === coin ? NIGHT : ON_NIGHT}; transition: background .35s ease, color .35s ease, border-color .35s ease`,
            )}
          >
            {c}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

const STAGES = ["Ask", "Set up", "Cross", "Swap", "Deliver"];

/** Three real looks for the drawer, each just a setting the host passes in. */
const LOOKS: readonly {
  readonly name: string;
  readonly swatch: readonly [string, string];
  readonly config: MavnaWidgetConfig;
}[] = [
  {
    name: "Plain",
    swatch: [GROUND, INK],
    config: {
      integrator: "web.mavna.app",
      network: "testnet",
      variant: "drawer",
      appearance: "light",
    },
  },
  {
    name: "Night",
    swatch: [NIGHT, ON_NIGHT],
    config: {
      integrator: "web.mavna.app",
      network: "testnet",
      variant: "drawer",
      appearance: "dark",
    },
  },
  {
    name: "Harbor",
    swatch: ["oklch(0.97 0.01 245)", "oklch(0.32 0.1 250)"],
    config: {
      integrator: "web.mavna.app",
      network: "testnet",
      variant: "drawer",
      appearance: "light",
      theme: {
        tokens: {
          "--mv-signal": "oklch(0.52 0.15 245)",
          "--mv-signal-strong": "oklch(0.52 0.17 245)",
          "--mv-ink": "oklch(0.32 0.1 250)",
          "--mv-white": "oklch(0.32 0.1 250)",
          "--mv-line": "oklch(0.32 0.1 250)",
          "--mv-ink-strong": "oklch(0.36 0.1 250)",
          "--mv-cta-hover": "oklch(0.4 0.11 250)",
        },
        font: "'Space Grotesk', system-ui, sans-serif",
        radius: "12px",
        radiusLg: "18px",
      },
    },
  },
];

/** The real drawer, restyled live by the look the visitor picks. */
function LookPicker(): ReactNode {
  const [pick, setPick] = useState(0);
  const look = LOOKS[pick] ?? LOOKS[0];
  if (look === undefined) return null;
  return (
    <div
      data-row=""
      style={s(
        "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 72px); align-items: center",
      )}
    >
      <fieldset
        aria-label="Widget look"
        style={s(
          "margin: 0; padding: 0; border: 0; display: flex; gap: clamp(12px, 2vw, 22px); flex-wrap: wrap",
        )}
      >
        {LOOKS.map((l, i) => (
          <button
            key={l.name}
            type="button"
            aria-pressed={i === pick}
            onClick={() => setPick(i)}
            data-look=""
            style={s(
              `display: grid; justify-items: start; gap: 14px; padding: 16px 16px 14px; min-width: 128px; border-radius: 18px; cursor: pointer; font: inherit; text-align: left; background: ${i === pick ? GROUND : "transparent"}; border: 1px solid ${i === pick ? INK : RULE}; color: ${INK}; transition: border-color .35s ease, background .35s ease, transform .5s cubic-bezier(.2,.7,.2,1)`,
            )}
          >
            <span
              aria-hidden="true"
              style={s(
                `width: 96px; height: 60px; border-radius: 10px; background: ${l.swatch[0]}; border: 1px solid ${RULE}; display: grid; place-items: center`,
              )}
            >
              <span
                style={s(
                  `width: 52px; height: 14px; border-radius: 999px; background: ${l.swatch[1]}`,
                )}
              />
            </span>
            <span style={s("font-size: 15.5px")}>{l.name}</span>
          </button>
        ))}
      </fieldset>
      <div
        style={s(
          `display: grid; justify-items: center; gap: 18px; padding: clamp(40px, 5vw, 64px) 20px; border-radius: 28px; background: ${look.swatch[0]}; border: 1px solid ${RULE}; transition: background .6s ease`,
        )}
      >
        <Live hold={64} style={{ display: "grid", justifyItems: "center" }} config={look.config} />
      </div>
    </div>
  );
}

// three routes with made-up relative shapes, no real figures: what reaches you
// (a share of the bar) and how long it takes (a share of the clock)
const BOARD = [
  { id: "A", gets: 0.95, time: 0.72 },
  { id: "B", gets: 0.8, time: 0.22 },
  { id: "C", gets: 0.88, time: 0.46 },
] as const;
const ROW = 76;

/** A small clock whose filled arc is how long a route takes. */
function Clock({ share, lit }: { share: number; lit: boolean }): ReactNode {
  const r = 13;
  const len = 2 * Math.PI * r;
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true" style={s("flex: none")}>
      <circle cx="17" cy="17" r={r} fill="none" stroke={RULE} strokeWidth="4" />
      <circle
        cx="17"
        cy="17"
        r={r}
        fill="none"
        stroke={lit ? INK : FAINT}
        strokeWidth="4"
        strokeDasharray={`${len * share} ${len}`}
        transform="rotate(-90 17 17)"
        style={s("transition: stroke .5s ease")}
      />
    </svg>
  );
}

/** The same routes, ranked the two ways the app offers. */
function RankBoard(): ReactNode {
  const [by, setBy] = useState<"best" | "fast">("best");
  const order = [...BOARD].sort((a, b) => (by === "best" ? b.gets - a.gets : a.time - b.time));
  const place = new Map(order.map((r, i) => [r.id, i]));
  return (
    <div style={s("display: grid; gap: clamp(26px, 3vw, 36px); align-content: start")}>
      <fieldset
        aria-label="Rank routes by"
        style={s(
          `margin: 0; padding: 4px; border: 1px solid ${RULE}; border-radius: 999px; display: inline-flex; justify-self: start; gap: 4px; background: ${GROUND}`,
        )}
      >
        {(
          [
            { id: "best", label: "Best return" },
            { id: "fast", label: "Fastest" },
          ] as const
        ).map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={by === o.id}
            onClick={() => setBy(o.id)}
            style={s(
              `min-height: 44px; padding: 0 20px; border: 0; border-radius: 999px; font: inherit; font-size: 15.5px; cursor: pointer; background: ${by === o.id ? INK : "transparent"}; color: ${by === o.id ? GROUND : INK}; transition: background .35s ease, color .35s ease`,
            )}
          >
            {o.label}
          </button>
        ))}
      </fieldset>
      <div aria-hidden="true" style={s(`position: relative; height: ${ROW * BOARD.length}px`)}>
        {BOARD.map((r) => {
          const i = place.get(r.id) ?? 0;
          const top = i === 0;
          return (
            <div
              key={r.id}
              style={s(
                `position: absolute; left: 0; right: 0; top: ${i * ROW}px; height: ${ROW - 14}px; display: flex; align-items: center; gap: 16px; padding: 0 18px; border-radius: 16px; background: ${top ? GROUND : "transparent"}; border: 1px solid ${top ? INK : RULE}; transition: top .7s cubic-bezier(.2,.8,.2,1), background .4s ease, border-color .4s ease`,
              )}
            >
              <span
                style={s(
                  `width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-family: 'IBM Plex Mono', monospace; color: ${top ? GROUND : MUTED}; background: ${top ? INK : "transparent"}; border: 1px solid ${top ? INK : RULE}; transition: background .4s ease, color .4s ease`,
                )}
              >
                {r.id}
              </span>
              <span
                style={s(
                  `flex: 1; height: 10px; border-radius: 99px; background: ${RULE}; overflow: hidden`,
                )}
              >
                <span
                  style={s(
                    `display: block; height: 100%; width: ${r.gets * 100}%; border-radius: 99px; background: ${by === "best" ? INK : FAINT}; transition: background .5s ease`,
                  )}
                />
              </span>
              <Clock share={r.time} lit={by === "fast"} />
              <span
                style={s(
                  `width: 96px; flex: none; text-align: right; font-size: 13px; color: ${SIGNAL}; opacity: ${top ? 1 : 0}; transition: opacity .4s ease .3s`,
                )}
              >
                {by === "best" ? "Best return" : "Fastest"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// where the quote and the route's minimum sit on the chart; the gap is drawn
// wider than the real one so it can be seen
const QUOTED = 52;
const MINIMUM = 44;

/** A price that keeps moving against the minimum a converting route carries. */
function FloorTicker(): ReactNode {
  const [trades, setTrades] = useState(true);
  const inkPath = useRef<SVGPathElement>(null);
  const redPath = useRef<SVGPathElement>(null);
  const dot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const W = 600;
    const H = 240;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = true;
    // a few sines at odd rates read as a market without pretending to be one
    const value = (x: number, t: number): number =>
      0.55 +
      0.17 * Math.sin(1.3 * (x * 6 - t * 1.1)) +
      0.08 * Math.sin(3.1 * (x * 6 - t * 1.7) + 1) +
      0.04 * Math.sin(7 * (x * 6 - t * 0.9));
    const draw = (t: number): void => {
      let d = "";
      for (let i = 0; i <= 80; i += 1) {
        const x = i / 80;
        d += `${i === 0 ? "M" : "L"}${(x * W).toFixed(1)} ${((1 - value(x, t)) * H).toFixed(1)}`;
      }
      inkPath.current?.setAttribute("d", d);
      redPath.current?.setAttribute("d", d);
      const now = value(1, t);
      // a circle inside the stretched svg would turn into an oval, so the dot is html
      if (dot.current) dot.current.style.top = `${((1 - now) * 100).toFixed(2)}%`;
      const ok = now * 100 >= MINIMUM;
      if (ok !== last) {
        last = ok;
        setTrades(ok);
      }
    };
    const t0 = performance.now();
    const frame = (n: number): void => {
      draw((n - t0) / 1000);
      raf = requestAnimationFrame(frame);
    };
    if (still) draw(0);
    else raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const y = (1 - MINIMUM / 100) * 240;
  const yq = (1 - QUOTED / 100) * 240;
  return (
    <div style={s("display: grid; gap: 18px; align-content: start")}>
      <div
        style={s(
          `position: relative; border-radius: 20px; background: ${GROUND}; border: 1px solid ${RULE}; overflow: hidden`,
        )}
      >
        <svg
          viewBox="0 0 600 240"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={s("display: block; width: 100%; height: clamp(180px, 20vw, 240px)")}
        >
          <defs>
            <clipPath id="above-floor">
              <rect x="0" y="0" width="600" height={y} />
            </clipPath>
            <clipPath id="below-floor">
              <rect x="0" y={y} width="600" height={240 - y} />
            </clipPath>
          </defs>
          <rect x="0" y={y} width="600" height={240 - y} fill="oklch(0.55 0.2 25 / 0.06)" />
          <path
            ref={inkPath}
            clipPath="url(#above-floor)"
            fill="none"
            stroke={INK}
            strokeWidth="2.2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            ref={redPath}
            clipPath="url(#below-floor)"
            fill="none"
            stroke={SIGNAL}
            strokeWidth="2.2"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="0"
            x2="600"
            y1={yq}
            y2={yq}
            stroke={FAINT}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="0"
            x2="600"
            y1={y}
            y2={y}
            stroke={SIGNAL}
            strokeWidth="1.5"
            strokeDasharray="6 6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          ref={dot}
          aria-hidden="true"
          style={s(
            `position: absolute; right: 0; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 0; border-radius: 50%; background: ${trades ? INK : SIGNAL}; transition: background .3s ease`,
          )}
        />
        <span
          style={s(
            `position: absolute; left: 16px; top: calc(${(y / 240) * 100}% + 8px); font-size: 13px; color: ${SIGNAL}; pointer-events: none`,
          )}
        >
          The route’s minimum
        </span>
        <span
          style={s(
            `position: absolute; left: 16px; top: calc(${(yq / 240) * 100}% - 24px); font-size: 13px; color: ${MUTED}; pointer-events: none`,
          )}
        >
          Quoted
        </span>
      </div>
      <p
        style={s(
          `margin: 0; font-size: clamp(20px, 2vw, 26px); font-weight: 300; letter-spacing: -0.02em; line-height: 1.25; color: ${trades ? INK : SIGNAL}; transition: color .3s ease`,
        )}
      >
        {trades
          ? "Above the minimum, so it converts into the coin you asked for."
          : "Below the minimum, so the swap does not happen and what you sent arrives as it came."}
      </p>
    </div>
  );
}

export function Landing(): ReactNode {
  const shaderRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- Hero shader: a plate refracted through slanted glass slats, with a light
    // behind the glass that follows the pointer and bends the slats near it. ---
    let plate: HTMLCanvasElement | null = null;
    let markImg: HTMLImageElement | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const hero = shaderRef.current?.parentElement ?? null;
    const aim = { x: 0.7, y: 0.55 };
    const at = { x: 0.7, y: 0.55 };
    const onPointer = (e: PointerEvent): void => {
      if (hero === null) return;
      const r = hero.getBoundingClientRect();
      aim.x = (e.clientX - r.left) / r.width;
      aim.y = 1 - (e.clientY - r.top) / r.height;
    };

    const drawPlate = (w: number, h: number): HTMLCanvasElement => {
      if (plate === null) plate = document.createElement("canvas");
      const c = plate;
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      if (x === null) return c;
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#fbfbfb");
      g.addColorStop(0.55, "#f1f1f1");
      g.addColorStop(1, "#e6e6e7");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      const band = x.createLinearGradient(w * 0.35, 0, w, h);
      band.addColorStop(0, "rgba(120,120,128,0)");
      band.addColorStop(0.6, "rgba(120,120,128,0.10)");
      band.addColorStop(1, "rgba(90,92,100,0.18)");
      x.fillStyle = band;
      x.fillRect(0, 0, w, h);
      if (markImg?.complete && markImg.naturalWidth > 0) {
        const sz = Math.min(w, h) * 1.15;
        x.globalAlpha = 0.14;
        x.drawImage(markImg, w * 0.66 - sz / 2, h * 0.48 - sz / 2, sz, sz);
        x.globalAlpha = 1;
      }
      return c;
    };

    const cv = shaderRef.current;
    if (cv && !reduce) {
      const gl = cv.getContext("webgl", {
        antialias: false,
        alpha: true,
        premultipliedAlpha: false,
      });
      if (gl) {
        const vs = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
        const fs = [
          "precision highp float;",
          "uniform vec2 u_res; uniform float u_t; uniform sampler2D u_tex; uniform vec2 u_m;",
          "float hash(float n){ return fract(sin(n * 127.1) * 43758.5453); }",
          "void main(){",
          "  vec2 uv = gl_FragCoord.xy / u_res.xy;",
          "  vec2 tuv = vec2(uv.x, 1.0 - uv.y);",
          "  float ar = u_res.x / max(u_res.y, 1.0);",
          "  vec2 dm = (uv - u_m) * vec2(ar, 1.0);",
          "  float near = exp(-dot(dm, dm) * 5.0);",
          "  float ang = 0.5236 + 0.05 * sin(u_t * 0.07);",
          "  vec2 dir = vec2(cos(ang), sin(ang));",
          "  vec2 perp = vec2(-dir.y, dir.x);",
          "  float across = dot(vec2(uv.x * ar, uv.y), dir) + u_t * 0.006;",
          "  float k = across / 0.052;",
          "  float kk = k + (hash(floor(k)) - 0.5) * 0.55;",
          "  float ii = floor(kk);",
          "  float c = fract(kk) * 2.0 - 1.0;",
          "  float lens = c * (0.78 + 0.5 * hash(ii + 3.0));",
          // slats near the pointer bend harder, so the glass feels like it answers
          "  float amt = (0.030 + 0.055 * near) * lens + 0.006 * sin(u_t * 0.4 + ii * 1.7);",
          "  vec2 offs = dir * amt / vec2(ar, 1.0);",
          "  vec3 col = vec3(0.0);",
          "  for (int i = -2; i <= 2; i++) {",
          "    vec2 o = perp * float(i) * 0.0022 / vec2(ar, 1.0);",
          "    col += texture2D(u_tex, tuv + offs + o).rgb;",
          "  }",
          "  col /= 5.0;",
          // a soft white light behind the glass, broken up by the same refraction
          "  vec2 gl2 = dm + offs * vec2(ar, 1.0) * 9.0;",
          "  float glow = exp(-dot(gl2, gl2) * 7.0);",
          "  col = mix(col, vec3(1.0), glow * 0.35);",
          "  float hi = smoothstep(0.55, 1.0, 1.0 - abs(c + 0.52)) * (0.6 + 0.4 * hash(ii + 9.0));",
          "  col += hi * 0.05;",
          "  col -= smoothstep(0.82, 1.0, abs(c)) * 0.05;",
          "  col += (hash(dot(gl_FragCoord.xy, vec2(0.63, 1.31)) + fract(u_t) * 7.0) - 0.5) * 0.012;",
          "  gl_FragColor = vec4(col, 1.0);",
          "}",
        ].join("\n");
        const mk = (type: number, src: string): WebGLShader | null => {
          const sh = gl.createShader(type);
          if (sh === null) return null;
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("landing shader did not compile:", gl.getShaderInfoLog(sh));
            return null;
          }
          return sh;
        };
        const prog = gl.createProgram();
        const vShader = mk(gl.VERTEX_SHADER, vs);
        const fShader = mk(gl.FRAGMENT_SHADER, fs);
        if (prog && vShader && fShader) {
          gl.attachShader(prog, vShader);
          gl.attachShader(prog, fShader);
          gl.linkProgram(prog);
          if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL call, not a React hook.
            gl.useProgram(prog);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(
              gl.ARRAY_BUFFER,
              new Float32Array([-1, -1, 3, -1, -1, 3]),
              gl.STATIC_DRAW,
            );
            const loc = gl.getAttribLocation(prog, "p");
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            const uRes = gl.getUniformLocation(prog, "u_res");
            const uT = gl.getUniformLocation(prog, "u_t");
            const uM = gl.getUniformLocation(prog, "u_m");
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
            const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
            const upload = (): void => {
              const p = drawPlate(Math.min(cv.width, 1600), Math.min(cv.height, 1200));
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p);
            };
            const size = (): void => {
              const r = cv.getBoundingClientRect();
              cv.width = Math.max(1, Math.round(r.width * dpr));
              cv.height = Math.max(1, Math.round(r.height * dpr));
              gl.viewport(0, 0, cv.width, cv.height);
              gl.uniform2f(uRes, cv.width, cv.height);
              upload();
            };
            const mark = new Image();
            mark.onload = () => {
              markImg = mark;
              upload();
            };
            mark.src = "/assets/mark-ink.png";
            size();
            ro = new ResizeObserver(size);
            ro.observe(cv);
            hero?.addEventListener("pointermove", onPointer, { passive: true });
            const t0 = performance.now();
            const frame = (now: number): void => {
              // ease toward the pointer so the light trails it instead of snapping
              at.x += (aim.x - at.x) * 0.045;
              at.y += (aim.y - at.y) * 0.045;
              gl.uniform2f(uM, at.x, at.y);
              gl.uniform1f(uT, (now - t0) / 1000);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
              raf = requestAnimationFrame(frame);
            };
            // Draw the first frame synchronously so the plate is painted at once,
            // even before (or without) an animation frame firing.
            frame(t0);
          }
        }
      }
    }

    // --- Reveal on scroll. Scroll-driven rather than IntersectionObserver, because
    // a tab that is not the foreground one can withhold observer callbacks and leave
    // whole sections stuck at opacity 0. will-change is dropped once a section has
    // revealed, so it never keeps a stale composited layer that only a repaint (a
    // stray hover) would clear. data-in is what starts a section's own motion. ---
    const revealEls: HTMLElement[] = [];
    Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).forEach((el) => {
      if (reduce || el.getBoundingClientRect().top < window.innerHeight * 0.92) {
        el.setAttribute("data-in", "");
        return;
      }
      el.style.transition =
        "opacity 1s cubic-bezier(.2,.7,.2,1), transform 1.1s cubic-bezier(.2,.7,.2,1)";
      el.style.willChange = "opacity, transform";
      el.style.opacity = "0";
      el.style.transform = "translateY(28px)";
      revealEls.push(el);
    });
    const revealVisible = (): void => {
      for (let i = revealEls.length - 1; i >= 0; i -= 1) {
        const el = revealEls[i];
        if (el === undefined) continue;
        if (el.getBoundingClientRect().top >= window.innerHeight * 0.86) continue;
        el.style.opacity = "1";
        el.style.transform = "none";
        el.setAttribute("data-in", "");
        window.setTimeout(() => {
          el.style.willChange = "auto";
        }, 1300);
        revealEls.splice(i, 1);
      }
    };

    // --- Chrome: the header gains its rule once the page has moved. ---
    const header = document.querySelector("header");
    const onScroll = (): void => {
      revealVisible();
      if (header instanceof HTMLElement) {
        header.style.borderBottomColor = window.scrollY > 40 ? RULE : "transparent";
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // --- Smooth scroll. Lenis drives the page's own scroll, so sticky, the reveal
    // and anchors keep working; it stands down for reduced motion on its own. The
    // widget, drawer included, keeps native scroll for its lists. ---
    const lenis = new Lenis({
      autoRaf: true,
      // the header offset comes from scroll-padding-top in landing.css
      anchors: true,
      stopInertiaOnNavigate: true,
      prevent: (node) => node.closest(".mv-root") !== null,
    });

    return () => {
      lenis.destroy();
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      hero?.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div style={s(`background: ${GROUND}; overflow-x: clip`)}>
      <header
        style={s(
          `position: sticky; top: 0; z-index: 50; backdrop-filter: blur(14px); background: oklch(0.985 0 0 / 0.8); border-bottom: 1px solid transparent; transition: border-color .5s ease`,
        )}
      >
        <div
          style={s(
            `${WRAP}; height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px`,
          )}
        >
          <a href="#top" style={s("display: flex; align-items: center; gap: 12px")}>
            <img
              src="/assets/mark-ink.png"
              alt="Mavna"
              style={s("width: 24px; height: 24px; display: block")}
            />
            <span
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 13px; letter-spacing: 0.36em; text-transform: uppercase",
              )}
            >
              Mavna
            </span>
          </a>
          <nav
            style={s(
              `display: flex; align-items: center; gap: clamp(18px, 3vw, 34px); font-size: 14px; color: ${MUTED}`,
            )}
          >
            <a data-navlink="" href={DOCS_SDK}>
              SDK
            </a>
            <a data-navlink="" href={DOCS_WIDGET}>
              Widget
            </a>
            <a data-navlink="" href={DOCS}>
              Docs
            </a>
            <a data-navlink="" href={GITHUB} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <Hover
              as="a"
              href={APP}
              external
              base={`border: 1px solid ${INK}; border-radius: 999px; padding: 8px 18px; color: ${INK}; transition: background .45s ease, color .45s ease`}
              hover={`background: ${INK}; color: ${GROUND}`}
            >
              Open the app
            </Hover>
          </nav>
        </div>
      </header>

      <section
        id="top"
        style={s(
          "position: relative; min-height: calc(100svh - 76px); display: grid; align-items: end; overflow: hidden",
        )}
      >
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative background canvas, not focusable content. */}
        <canvas
          ref={shaderRef}
          aria-hidden="true"
          style={s(
            "position: absolute; inset: 0; width: 100%; height: 100%; display: block; mask-image: radial-gradient(125% 95% at 68% 38%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.85) 45%, rgba(0,0,0,0) 82%); -webkit-mask-image: radial-gradient(125% 95% at 68% 38%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.85) 45%, rgba(0,0,0,0) 82%)",
          )}
        />
        <div
          style={s(
            `position: relative; width: 100%; ${WRAP}; padding-top: clamp(52px, 10vh, 120px); padding-bottom: clamp(56px, 8vh, 92px)`,
          )}
        >
          <h1
            style={s(
              "margin: 0; font-weight: 300; font-size: clamp(42px, 7.6vw, 112px); line-height: 0.96; letter-spacing: -0.038em; max-width: 20ch",
            )}
          >
            <span
              data-line=""
              style={s("display: block; overflow: hidden; padding-bottom: 0.08em")}
            >
              <span
                style={s(
                  "display: block; animation: lineUp 1.3s cubic-bezier(.16,.84,.24,1) .1s both",
                )}
              >
                Ask every rail at once.
              </span>
            </span>
            <span
              data-line=""
              style={s("display: block; overflow: hidden; padding-bottom: 0.08em")}
            >
              <span
                style={s(
                  "display: block; animation: lineUp 1.3s cubic-bezier(.16,.84,.24,1) .25s both",
                )}
              >
                Bring it ashore in one flow.
              </span>
            </span>
          </h1>
          <div
            style={s(
              "margin-top: clamp(34px, 6vh, 64px); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: clamp(22px, 4vw, 52px); animation: riseIn 1.4s cubic-bezier(.16,.84,.24,1) .55s both",
            )}
          >
            <p
              style={s(
                `margin: 0; font-size: clamp(16px, 1.3vw, 19px); line-height: 1.6; color: ${MUTED}; max-width: 40ch`,
              )}
            >
              Move money from another chain onto Stellar, and see what arrives, and the least it can
              be, before you send it.
            </p>
            <div style={s("display: flex; align-items: center; gap: 26px; flex-wrap: wrap")}>
              <a data-cta="" href={APP} style={s(`background: ${SIGNAL}; color: ${GROUND}`)}>
                Open the app <Arrow size="18px" />
              </a>
              <a data-underline="" href={DOCS} style={s(`font-size: 15.5px; color: ${INK}`)}>
                Read the docs
              </a>
            </div>
          </div>
        </div>
      </section>

      <section
        id="rails"
        data-reveal=""
        style={s("padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(70px, 10vh, 130px)")}
      >
        <h2 style={s(`${BIG}; ${WRAP}; font-size: clamp(34px, 5.4vw, 80px)`)}>
          <span style={s(`color: ${FAINT}`)}>Mavna isn’t a bridge.</span> It is every bridge at
          once.
        </h2>
        <div style={s(`margin-top: clamp(40px, 6vw, 80px); color: ${INK}`)}>
          <RailBand />
        </div>
      </section>

      <section id="screen" style={s(`background: ${NIGHT}; color: ${ON_NIGHT}`)}>
        <div
          style={s(
            `${WRAP}; padding-top: clamp(70px, 10vh, 130px); padding-bottom: clamp(70px, 10vh, 130px)`,
          )}
        >
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1.1fr; gap: clamp(36px, 6vw, 90px); align-items: center",
            )}
          >
            <div data-reveal="" style={s("display: grid; gap: clamp(22px, 2.6vw, 30px)")}>
              <h2 style={s(`${BIG}; font-size: clamp(32px, 4.4vw, 64px); max-width: 13ch`)}>
                One transfer. Every bridge answers at the same time.
              </h2>
              <p
                style={s(
                  `margin: 0; font-size: 17px; line-height: 1.62; color: ${MUTED_NIGHT}; max-width: 38ch`,
                )}
              >
                Pick where your money is now and the Stellar address it should land in. Every route
                comes back ranked by what actually reaches you, and the ones that cannot help say
                why, before you commit to anything.
              </p>
              <p
                style={s(
                  `margin: 0; font-size: 17px; line-height: 1.62; color: ${MUTED_NIGHT}; max-width: 38ch`,
                )}
              >
                No sign-up, no account. Just the wallet you already use.
              </p>
              <a
                data-underline=""
                href={APP}
                target="_blank"
                rel="noopener noreferrer"
                style={s(`justify-self: start; font-size: 15.5px; color: ${ON_NIGHT}`)}
              >
                Open mavna.app
              </a>
            </div>
            <div
              data-reveal=""
              style={s("position: relative; display: grid; justify-items: center")}
            >
              <div
                data-halo=""
                aria-hidden="true"
                style={s(
                  "position: absolute; inset: 10% 0; border-radius: 50%; background: radial-gradient(closest-side, oklch(0.55 0.2 25 / 0.28), transparent); filter: blur(30px)",
                )}
              />
              <Live
                hold={540}
                style={{ position: "relative", width: "100%", maxWidth: 440 }}
                config={{
                  integrator: "web.mavna.app",
                  network: "testnet",
                  variant: "compact",
                  appearance: "light",
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        id="app"
        style={s(`position: relative; background: ${OXIDE}; color: ${ON_OXIDE}; overflow: hidden`)}
      >
        <div
          aria-hidden="true"
          data-drift=""
          style={s(
            "position: absolute; right: -8vw; top: 50%; width: min(70vw, 760px); aspect-ratio: 1; margin-top: calc(min(70vw, 760px) / -2); border-radius: 50%; border: 1px dashed oklch(1 0 0 / 0.22)",
          )}
        />
        <div
          data-reveal=""
          style={s(
            `position: relative; ${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
          )}
        >
          <div
            aria-hidden="true"
            style={s(
              "font-weight: 300; font-size: clamp(110px, 22vw, 330px); line-height: 0.8; letter-spacing: -0.07em",
            )}
          >
            1.5
            <span
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 0.16em; letter-spacing: 0.1em; margin-left: 0.4em; vertical-align: 0.9em",
              )}
            >
              XLM
            </span>
          </div>
          <div
            data-row=""
            style={s(
              "margin-top: clamp(40px, 6vw, 72px); display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 6vw, 90px); align-items: start",
            )}
          >
            <h2 style={s(`${BIG}; font-size: clamp(32px, 4.4vw, 64px); max-width: 13ch`)}>
              The address does not have to exist yet.
            </h2>
            <p
              style={s(
                `margin: 0; font-size: 17.5px; line-height: 1.62; color: ${MUTED_OXIDE}; max-width: 40ch`,
              )}
            >
              A new Stellar account has to set aside 1.5 XLM before it can hold USDC, and someone
              arriving from another chain has none. We put it up, and the money coming in pays us
              back inside the same transfer. It stays in your own account, and comes back to you if
              you ever close it.
            </p>
          </div>
          <div
            data-journey=""
            aria-hidden="true"
            style={s("margin-top: clamp(56px, 8vw, 100px); position: relative; height: 70px")}
          >
            <div
              style={s(
                "position: absolute; left: 0; right: 0; top: 10px; height: 1px; background: oklch(1 0 0 / 0.3)",
              )}
            />
            <div
              data-journey-fill=""
              style={s(
                `position: absolute; left: 0; right: 0; top: 9px; height: 3px; background: ${ON_OXIDE}; transform-origin: left`,
              )}
            />
            {[
              { at: "0%", label: "You send", align: "left" },
              { at: "50%", label: "We open the account", align: "center" },
              { at: "100%", label: "It pays us back", align: "right" },
            ].map((stop, i) => (
              <div
                key={stop.label}
                data-stop={i}
                style={s(
                  `position: absolute; top: 0; left: ${stop.at}; transform: translateX(${stop.align === "left" ? "0" : stop.align === "center" ? "-50%" : "-100%"}); display: grid; justify-items: ${stop.align === "left" ? "start" : stop.align === "center" ? "center" : "end"}; gap: 16px`,
                )}
              >
                <span
                  style={s(
                    `width: 21px; height: 21px; border-radius: 50%; background: ${OXIDE}; border: 2px solid ${ON_OXIDE}`,
                  )}
                />
                <span style={s("font-size: 15px; white-space: nowrap")}>{stop.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="trustlines"
        data-reveal=""
        style={s(
          `${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
        )}
      >
        <h2 style={s(`${BIG}; font-size: clamp(34px, 5.4vw, 80px); max-width: 16ch`)}>
          Nobody has to know what a trustline is.
        </h2>
        <div
          data-row=""
          style={s(
            "margin-top: clamp(48px, 7vw, 88px); display: grid; grid-template-columns: 1.1fr 1fr; gap: clamp(30px, 6vw, 90px); align-items: center",
          )}
        >
          <div
            style={s(
              `display: grid; gap: clamp(4px, 0.8vw, 10px); font-weight: 300; font-size: clamp(22px, 2.7vw, 36px); line-height: 1.2; letter-spacing: -0.028em; color: ${FAINT}`,
            )}
          >
            {[
              "Buy XLM before you can start",
              "Open the account by hand",
              "Find the screen that adds a trustline",
              "Work out which bridge to use",
              "Bridge first, then swap by hand",
            ].map((t, i) => (
              <span key={t} data-strike="" style={{ transitionDelay: `${0.35 + i * 0.22}s` }}>
                {t}
              </span>
            ))}
          </div>
          <div data-answer="" style={s("display: grid; gap: clamp(18px, 2.4vw, 26px)")}>
            <p
              style={s(
                `${BIG}; font-size: clamp(30px, 3.8vw, 54px); line-height: 1.05; color: ${INK}`,
              )}
            >
              Paste an address and send, even with nothing on Stellar yet.
            </p>
            <p
              style={s(
                `margin: 0; font-size: 16.5px; line-height: 1.62; color: ${MUTED}; max-width: 38ch`,
              )}
            >
              An account has to say yes to a coin before it can hold it. For USDC, Mavna says that
              yes for you inside the transfer, so it is never a step anyone can get wrong.
            </p>
          </div>
        </div>
      </section>

      <section id="swap" style={s(`background: ${NIGHT}; color: ${ON_NIGHT}`)}>
        <div
          data-reveal=""
          style={s(
            `${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
          )}
        >
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 80px); align-items: end; margin-bottom: clamp(56px, 8vw, 100px)",
            )}
          >
            <h2 style={s(`${BIG}; font-size: clamp(34px, 5vw, 72px); max-width: 12ch`)}>
              Ask for the coin you want.
            </h2>
            <p
              style={s(
                `margin: 0; font-size: 17px; line-height: 1.62; color: ${MUTED_NIGHT}; max-width: 42ch`,
              )}
            >
              A bridge can only hand over what it carries. Mavna converts that into the coin you
              asked for on Stellar, priced into the amount you see before you send. If the price
              moves past the route’s minimum, what you sent arrives as it came.{" "}
              <a
                href="#choice"
                style={s(
                  `color: ${ON_NIGHT}; text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px`,
                )}
              >
                How the minimum works
              </a>
            </p>
          </div>
          <CoinPicker />
        </div>
      </section>

      <section
        id="choice"
        data-grid=""
        style={s(`background: oklch(0.955 0 0); border-bottom: 1px solid ${RULE}`)}
      >
        <div
          data-reveal=""
          style={s(
            `${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
          )}
        >
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 80px); align-items: end; margin-bottom: clamp(48px, 7vw, 88px)",
            )}
          >
            <h2 style={s(`${BIG}; font-size: clamp(34px, 5vw, 72px); max-width: 11ch`)}>
              You decide what best means.
            </h2>
            <p
              style={s(
                `margin: 0; font-size: 17px; line-height: 1.62; color: ${MUTED}; max-width: 42ch`,
              )}
            >
              Rank every route by how much reaches you, or by how soon it gets there. A route that
              converts on arrival carries a minimum it will not go below. If the price moves past
              it, the swap does not happen: what you sent arrives as it came, and you are told why.
            </p>
          </div>
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(36px, 6vw, 90px); align-items: start",
            )}
          >
            <RankBoard />
            <FloorTicker />
          </div>
        </div>
      </section>

      <section
        id="sdk"
        data-reveal=""
        style={s(
          `${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
        )}
      >
        <h2 style={s(`${BIG}; font-size: clamp(34px, 5.4vw, 80px); max-width: 15ch`)}>
          The whole transfer, not just the crossing.
        </h2>
        <div
          data-stages=""
          aria-hidden="true"
          style={s(
            `margin-top: clamp(48px, 7vw, 90px); display: flex; flex-wrap: wrap; align-items: center; gap: clamp(6px, 1vw, 14px) 0; font-weight: 300; font-size: clamp(30px, 5vw, 74px); letter-spacing: -0.04em; line-height: 1.1`,
          )}
        >
          {STAGES.map((st, i) => (
            <span key={st} style={s("display: flex; align-items: center")}>
              <span
                data-stage={st === "Cross" ? "middle" : ""}
                style={{ transitionDelay: `${0.3 + i * 0.25}s` }}
              >
                {st}
              </span>
              {i < STAGES.length - 1 ? (
                <span data-stage-link="" style={{ transitionDelay: `${0.42 + i * 0.25}s` }} />
              ) : null}
            </span>
          ))}
        </div>
        <div
          data-row=""
          style={s(
            "margin-top: clamp(44px, 6vw, 72px); display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 6vw, 90px); align-items: start",
          )}
        >
          <p
            style={s(
              `margin: 0; font-size: 17.5px; line-height: 1.62; color: ${MUTED}; max-width: 40ch`,
            )}
          >
            A bridge only does the crossing in the middle and leaves you the rest. The SDK is the
            same engine our own app runs on, and it hands you the whole row: asking every bridge,
            setting up the account, the swap, and following it home.
          </p>
          <div style={s("display: grid; gap: 22px; justify-items: start")}>
            <p
              style={s(
                `margin: 0; font-size: 17.5px; line-height: 1.62; color: ${MUTED}; max-width: 36ch`,
              )}
            >
              It builds, your users sign. No package ever holds a key.
            </p>
            <a data-underline="" href={DOCS_SDK} style={s(`font-size: 15.5px; color: ${INK}`)}>
              Build on the SDK
            </a>
          </div>
        </div>
      </section>

      <section
        id="widget"
        style={s(
          `background: oklch(0.955 0 0); border-top: 1px solid ${RULE}; border-bottom: 1px solid ${RULE}`,
        )}
      >
        <div
          data-reveal=""
          style={s(
            `${WRAP}; padding-top: clamp(80px, 12vh, 150px); padding-bottom: clamp(80px, 12vh, 150px)`,
          )}
        >
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 80px); align-items: end; margin-bottom: clamp(48px, 7vw, 88px)",
            )}
          >
            <h2 style={s(`${BIG}; font-size: clamp(34px, 5vw, 72px); max-width: 11ch`)}>
              One component. The whole flow.
            </h2>
            <p
              style={s(
                `margin: 0; font-size: 17px; line-height: 1.62; color: ${MUTED}; max-width: 42ch`,
              )}
            >
              Drop it into your wallet or exchange and your users bring money onto Stellar without
              leaving. It takes your colours, your type and your shape. Pick a look, then open it.
            </p>
          </div>
          <LookPicker />
        </div>
      </section>

      <section id="name" style={s(`background: ${NIGHT}; color: ${ON_NIGHT}; overflow: hidden`)}>
        <div
          data-reveal=""
          style={s(
            `${WRAP}; padding-top: clamp(90px, 14vh, 170px); padding-bottom: clamp(60px, 8vh, 100px)`,
          )}
        >
          <img
            data-bob=""
            src="/assets/mark-paper.png"
            alt=""
            style={s("width: clamp(48px, 5vw, 68px); height: auto; display: block")}
          />
          <p
            style={s(
              "margin: clamp(30px, 4vw, 48px) 0 0; font-family: 'Space Grotesk', 'DM Sans', sans-serif; font-weight: 300; font-size: clamp(30px, 4.6vw, 68px); line-height: 1.1; letter-spacing: -0.035em; max-width: 22ch",
            )}
          >
            A <em style={s(`font-style: normal; color: ${SIGNAL_BRIGHT}`)}>mavna</em> is the barge
            that carries cargo ashore when the ship cannot dock.
          </p>
          <p
            style={s(
              `margin: clamp(22px, 2.6vw, 30px) 0 0; font-size: 17px; line-height: 1.62; color: ${MUTED_NIGHT}; max-width: 40ch`,
            )}
          >
            Mavna does the last part of the trip, the part a bridge leaves to you.
          </p>
        </div>
        <div data-reveal="" style={s(`${WRAP}; padding-bottom: clamp(60px, 9vh, 110px)`)}>
          {[
            { href: APP, label: "Open the app", note: "Send something onto Stellar now." },
            {
              href: DOCS_SDK,
              label: "Build on the SDK",
              note: "Put the engine behind your own screens.",
            },
            { href: PLAYGROUND, label: "Embed the widget", note: "Try the real component first." },
          ].map((row) => (
            <a key={row.label} data-way="" href={row.href} style={s(`color: ${ON_NIGHT}`)}>
              <span
                data-way-big=""
                style={s(
                  "font-weight: 300; font-size: clamp(32px, 5.2vw, 76px); line-height: 1; letter-spacing: -0.04em; white-space: nowrap",
                )}
              >
                {row.label}
              </span>
              <span data-way-note="" style={s("font-size: 15.5px; line-height: 1.5")}>
                {row.note}
              </span>
              <span data-way-arrow="">
                <Arrow size="clamp(30px, 4vw, 52px)" />
              </span>
            </a>
          ))}
        </div>
      </section>

      <footer
        style={s(
          `background: ${NIGHT}; color: ${MUTED_NIGHT}; border-top: 1px solid ${RULE_NIGHT}`,
        )}
      >
        <div
          style={s(
            `${WRAP}; padding-top: 32px; padding-bottom: 36px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 22px 36px; font-size: 14px`,
          )}
        >
          <a href="#top" style={s("display: flex; align-items: center; gap: 11px")}>
            <img src="/assets/mark-paper.png" alt="Mavna" style={s("width: 22px; height: 22px")} />
            <span
              style={s(
                `font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; letter-spacing: 0.36em; text-transform: uppercase; color: ${ON_NIGHT}`,
              )}
            >
              Mavna
            </span>
          </a>
          <span style={s("display: flex; align-items: center; gap: 10px")}>
            <span data-pulse="" />
            Running on Stellar testnet
          </span>
          <nav aria-label="Footer" style={s("display: flex; flex-wrap: wrap; gap: 24px")}>
            <a data-footlink="" href={APP}>
              App
            </a>
            <a data-footlink="" href={PLAYGROUND}>
              Playground
            </a>
            <a data-footlink="" href={DOCS}>
              Docs
            </a>
            <a data-footlink="" href={GITHUB} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </nav>
          <span>© 2026 Mavna. Open source and non-custodial.</span>
        </div>
      </footer>
    </div>
  );
}
