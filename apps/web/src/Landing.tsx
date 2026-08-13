import { MavnaWidget, type MavnaWidgetConfig } from "@mavna/widget";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

/*
 * The Mavna landing page. Ported from the design as faithfully as possible: every
 * element keeps its original inline styles (parsed from a CSS string by `s`), the
 * design's `style-hover` becomes the `Hover` wrapper, and the hero shader, the
 * scroll chrome and the reveal-on-scroll all live in one effect. The only edits to
 * the design are the links, which now point at the real Mavna domains.
 */

const APP = "https://mavna.app";
const DOCS = "https://docs.mavna.app";
const PLAYGROUND = "https://playground.mavna.app";
const GITHUB = "https://github.com/ErenTopaal/mavna";

/** Parse an inline CSS declaration string into a React style object, verbatim. */
function s(css: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    if (prop === "") continue;
    const key = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = decl.slice(i + 1).trim();
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

/** A documentation topic link: dark text that warms to the accent on hover. */
function DocLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <Hover
      as="a"
      href={href}
      base="font-size: 15.5px; color: oklch(0.42 0.012 250); transition: color .4s ease"
      hover="color: oklch(0.60 0.075 45)"
    >
      {children}
    </Hover>
  );
}

/** A footer link: light-on-dark text that brightens on hover. */
function FootLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <Hover
      as="a"
      href={href}
      base="font-size: 14.5px; color: oklch(0.80 0.012 250); transition: color .4s ease"
      hover="color: oklch(0.96 0.008 85)"
    >
      {children}
    </Hover>
  );
}

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
      {show ? <MavnaWidget config={config} /> : null}
    </div>
  );
}

const CODE_HTML =
  '<span style="color: oklch(0.66 0.05 245);">import</span> { raceAdapters } <span style="color: oklch(0.66 0.05 245);">from</span> <span style="color: oklch(0.76 0.07 45);">"@mavna/routing"</span>;\n\n' +
  '<span style="color: oklch(0.66 0.05 245);">const</span> { routes, rejected } = <span style="color: oklch(0.66 0.05 245);">await</span> raceAdapters(adapters, request, {\n' +
  '  ranking: <span style="color: oklch(0.76 0.07 45);">"best-received"</span>,\n' +
  "  onUpdate: (partial) => render(partial),\n" +
  "});\n\n" +
  'routes[<span style="color: oklch(0.74 0.03 145);">0</span>].receives             <span style="color: oklch(0.58 0.012 250);">// what actually lands</span>\n' +
  'routes[<span style="color: oklch(0.74 0.03 145);">0</span>].signaturesRequired   <span style="color: oklch(0.58 0.012 250);">// how many prompts</span>\n' +
  'rejected[<span style="color: oklch(0.74 0.03 145);">0</span>].explanation       <span style="color: oklch(0.58 0.012 250);">// why that one said no</span>\n' +
  'rejected[<span style="color: oklch(0.74 0.03 145);">0</span>].retryable         <span style="color: oklch(0.58 0.012 250);">// worth asking again?</span>';

export function Landing(): ReactNode {
  const shaderRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- Hero shader: a warm plate refracted through vertical glass slats. ---
    let plate: HTMLCanvasElement | null = null;
    let markImg: HTMLImageElement | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;

    const drawPlate = (w: number, h: number): HTMLCanvasElement => {
      if (plate === null) plate = document.createElement("canvas");
      const c = plate;
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      if (x === null) return c;
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#faf9f6");
      g.addColorStop(0.55, "#f2f0eb");
      g.addColorStop(1, "#eae7e0");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      const band = x.createLinearGradient(w * 0.35, 0, w, h);
      band.addColorStop(0, "rgba(150,120,100,0)");
      band.addColorStop(0.6, "rgba(150,120,100,0.10)");
      band.addColorStop(1, "rgba(110,120,135,0.16)");
      x.fillStyle = band;
      x.fillRect(0, 0, w, h);
      if (markImg?.complete && markImg.naturalWidth > 0) {
        const sz = Math.min(w, h) * 1.15;
        x.globalAlpha = 0.13;
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
          "uniform vec2 u_res; uniform float u_t; uniform sampler2D u_tex;",
          "float hash(float n){ return fract(sin(n * 127.1) * 43758.5453); }",
          "void main(){",
          "  vec2 uv = gl_FragCoord.xy / u_res.xy;",
          "  vec2 tuv = vec2(uv.x, 1.0 - uv.y);",
          "  float ar = u_res.x / max(u_res.y, 1.0);",
          "  float ang = 0.5236;",
          "  vec2 dir = vec2(cos(ang), sin(ang));",
          "  vec2 perp = vec2(-dir.y, dir.x);",
          "  float across = dot(vec2(uv.x * ar, uv.y), dir);",
          "  float k = across / 0.052;",
          "  float kk = k + (hash(floor(k)) - 0.5) * 0.55;",
          "  float ii = floor(kk);",
          "  float c = fract(kk) * 2.0 - 1.0;",
          "  float lens = c * (0.78 + 0.5 * hash(ii + 3.0));",
          "  float amt = 0.030 * lens + 0.0035 * sin(u_t * 0.12 + ii * 1.7);",
          "  vec2 offs = dir * amt / vec2(ar, 1.0);",
          "  vec3 col = vec3(0.0);",
          "  for (int i = -2; i <= 2; i++) {",
          "    vec2 o = perp * float(i) * 0.0022 / vec2(ar, 1.0);",
          "    col += texture2D(u_tex, tuv + offs + o).rgb;",
          "  }",
          "  col /= 5.0;",
          "  float hi = smoothstep(0.55, 1.0, 1.0 - abs(c + 0.52)) * (0.6 + 0.4 * hash(ii + 9.0));",
          "  col += hi * 0.045;",
          "  col -= smoothstep(0.82, 1.0, abs(c)) * 0.045;",
          "  col += (hash(dot(gl_FragCoord.xy, vec2(0.63, 1.31)) + fract(u_t) * 7.0) - 0.5) * 0.012;",
          "  gl_FragColor = vec4(col, 1.0);",
          "}",
        ].join("\n");
        const mk = (type: number, src: string): WebGLShader | null => {
          const sh = gl.createShader(type);
          if (sh === null) return null;
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
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
            const t0 = performance.now();
            const frame = (now: number): void => {
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
    // stray hover) would clear. ---
    const revealEls: HTMLElement[] = [];
    if (!reduce) {
      Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).forEach((el) => {
        el.style.transition =
          "opacity 1s cubic-bezier(.2,.7,.2,1), transform 1.1s cubic-bezier(.2,.7,.2,1)";
        if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
        el.style.willChange = "opacity, transform";
        el.style.opacity = "0";
        el.style.transform = "translateY(24px)";
        revealEls.push(el);
      });
    }
    const revealVisible = (): void => {
      for (let i = revealEls.length - 1; i >= 0; i -= 1) {
        const el = revealEls[i];
        if (el.getBoundingClientRect().top >= window.innerHeight * 0.9) continue;
        el.style.opacity = "1";
        el.style.transform = "none";
        window.setTimeout(() => {
          el.style.willChange = "auto";
        }, 1300);
        revealEls.splice(i, 1);
      }
    };

    // --- Chrome: header border after scroll, and the active section in the nav. ---
    const header = document.querySelector("header");
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('header nav a[href^="#"]'),
    ).filter((a) => ["#app", "#sdk", "#widget"].includes(a.getAttribute("href") ?? ""));
    const ids = ["app", "sdk", "widget"];
    const onScroll = (): void => {
      revealVisible();
      if (header instanceof HTMLElement) {
        header.style.borderBottomColor =
          window.scrollY > 40 ? "oklch(0.885 0.006 85)" : "transparent";
      }
      const mid = window.scrollY + 130;
      let active: string | null = null;
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= mid) active = id;
      });
      links.forEach((a) => {
        a.setAttribute("data-active", String(a.getAttribute("href") === `#${active}`));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div style={s("background: oklch(0.972 0.004 85)")}>
      <header
        style={s(
          "position: sticky; top: 0; z-index: 50; backdrop-filter: blur(14px); background: oklch(0.972 0.004 85 / 0.8); border-bottom: 1px solid transparent; transition: border-color .5s ease",
        )}
      >
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 48px); height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 24px",
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
              "display: flex; align-items: center; gap: clamp(18px, 3vw, 34px); font-size: 14px; color: oklch(0.52 0.012 250)",
            )}
          >
            <a href="#app" style={s("transition: color .4s ease")}>
              App
            </a>
            <a href="#sdk" style={s("transition: color .4s ease")}>
              SDK
            </a>
            <a href="#widget" style={s("transition: color .4s ease")}>
              Widget
            </a>
            <a
              href={GITHUB}
              target="_blank"
              rel="noopener noreferrer"
              style={s("transition: color .4s ease")}
            >
              GitHub
            </a>
            <Hover
              as="a"
              href={APP}
              external
              base="border: 1px solid oklch(0.80 0.01 85); border-radius: 999px; padding: 8px 18px; color: oklch(0.24 0.012 250); transition: background .45s ease, color .45s ease, border-color .45s ease"
              hover="background: oklch(0.24 0.012 250); color: oklch(0.972 0.004 85); border-color: oklch(0.24 0.012 250)"
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
            "position: relative; width: 100%; max-width: 1180px; margin: 0 auto; padding: clamp(52px, 10vh, 120px) clamp(20px, 4vw, 48px) clamp(56px, 8vh, 92px)",
          )}
        >
          <h1
            style={s(
              "margin: 0; font-weight: 300; font-size: clamp(42px, 7.6vw, 112px); line-height: 0.96; letter-spacing: -0.038em; max-width: 20ch; animation: riseIn 1.5s cubic-bezier(.16,.84,.24,1) .15s both",
            )}
          >
            Ask every rail at once.
            <br />
            Bring it ashore in one flow.
          </h1>
          <div
            style={s(
              "margin-top: clamp(34px, 6vh, 72px); display: flex; flex-wrap: wrap; align-items: baseline; gap: clamp(22px, 4vw, 52px); animation: riseIn 1.5s cubic-bezier(.16,.84,.24,1) .4s both",
            )}
          >
            <p
              style={s(
                "margin: 0; font-size: clamp(16px, 1.3vw, 18.5px); line-height: 1.6; color: oklch(0.42 0.012 250); max-width: 40ch",
              )}
            >
              Move money from another chain onto Stellar, and see exactly what arrives before you
              send it.
            </p>
          </div>
        </div>
      </section>

      <section
        id="paths"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(48px, 7vh, 92px) clamp(20px, 4vw, 48px)",
        )}
      >
        <div
          data-row2=""
          style={s(
            "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: oklch(0.885 0.006 85); border: 1px solid oklch(0.885 0.006 85)",
          )}
        >
          {[
            {
              href: "#app",
              tag: "Send",
              title: "Move money onto Stellar",
              note: "Paste an address, see what lands.",
            },
            {
              href: "#sdk",
              tag: "Build",
              title: "Build it into your app",
              note: "Quotes in, unsigned transactions out.",
            },
            {
              href: "#widget",
              tag: "Embed",
              title: "Drop in the widget",
              note: "The whole transfer, inside your product.",
            },
          ].map((p) => (
            <Hover
              key={p.tag}
              as="a"
              href={p.href}
              base="background: oklch(0.972 0.004 85); padding: clamp(26px, 3vw, 40px) clamp(22px, 2.4vw, 32px); display: grid; gap: 12px; align-content: start; transition: background .5s ease, padding-left .5s cubic-bezier(.2,.7,.2,1)"
              hover="background: oklch(0.99 0.003 85); padding-left: clamp(30px, 3vw, 44px)"
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
                )}
              >
                {p.tag}
              </span>
              <span
                style={s(
                  "font-size: clamp(20px, 2vw, 25px); font-weight: 300; letter-spacing: -0.02em",
                )}
              >
                {p.title}
              </span>
              <span style={s("font-size: 14.5px; line-height: 1.5; color: oklch(0.48 0.012 250)")}>
                {p.note}
              </span>
              <span
                style={s(
                  "margin-top: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: oklch(0.52 0.012 250)",
                )}
              >
                →
              </span>
            </Hover>
          ))}
        </div>
      </section>

      <section
        id="docs"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(24px, 5vw, 70px); align-items: end; padding-bottom: clamp(30px, 4vw, 48px)",
          )}
        >
          <h2
            style={s(
              "margin: 0; font-weight: 300; font-size: clamp(28px, 3.6vw, 46px); letter-spacing: -0.03em; line-height: 1.04",
            )}
          >
            Documentation
          </h2>
          <p
            style={s(
              "margin: 0; font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 44ch",
            )}
          >
            Grouped by how you use Mavna. Every page is generated from the source, so it always
            matches the code.
          </p>
        </div>
        <div
          data-row2=""
          style={s(
            "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: oklch(0.885 0.006 85); border: 1px solid oklch(0.885 0.006 85)",
          )}
        >
          {[
            {
              tag: "App",
              items: [
                "Your first transfer",
                "Send to a new address",
                "Track a transfer",
                "What a transfer costs",
              ],
            },
            {
              tag: "SDK",
              items: ["Quickstart", "Concepts", "Rails & networks", "Package reference"],
            },
            {
              tag: "Widget",
              items: ["Quickstart", "Components", "Theming & config", "Security model"],
            },
          ].map((col) => (
            <div
              key={col.tag}
              style={s(
                "background: oklch(0.972 0.004 85); padding: clamp(24px, 3vw, 38px) clamp(22px, 2.4vw, 32px); display: grid; gap: 15px; align-content: start",
              )}
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
                )}
              >
                {col.tag}
              </span>
              {col.items.map((item) => (
                <DocLink key={item} href={DOCS}>
                  {item}
                </DocLink>
              ))}
            </div>
          ))}
        </div>
        <Hover
          as="a"
          href={PLAYGROUND}
          base="margin-top: 1px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; background: oklch(0.24 0.012 250); color: oklch(0.955 0.004 85); padding: clamp(22px, 2.8vw, 32px) clamp(24px, 3vw, 38px); transition: padding-left .55s cubic-bezier(.2,.7,.2,1)"
          hover="padding-left: clamp(34px, 4vw, 52px)"
        >
          <span style={s("display: grid; gap: 6px")}>
            <span
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase; color: oklch(0.72 0.075 45)",
              )}
            >
              Widget playground
            </span>
            <span
              style={s(
                "font-size: clamp(18px, 2vw, 23px); font-weight: 300; letter-spacing: -0.02em",
              )}
            >
              Try the real component against live quotes.
            </span>
          </span>
          <span style={s("font-weight: 300; font-size: clamp(24px, 3vw, 34px); line-height: 1")}>
            →
          </span>
        </Hover>
      </section>

      <section id="screen" style={s("background: #171717; color: oklch(0.955 0.004 85)")}>
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
          )}
        >
          <div
            data-reveal=""
            style={s(
              "max-width: 26ch; font-weight: 300; font-size: clamp(26px, 3.2vw, 42px); line-height: 1.1; letter-spacing: -0.032em",
            )}
          >
            One transfer. Every bridge answers at the same time.
          </div>
          <div
            data-row=""
            style={s(
              "display: grid; grid-template-columns: 1.55fr 1fr; gap: clamp(28px, 5vw, 64px); align-items: center; margin-top: clamp(36px, 5vw, 64px)",
            )}
          >
            <div
              data-reveal=""
              style={s(
                "border: 1px solid oklch(0.32 0.012 250); border-radius: 20px; padding: clamp(16px, 2.2vw, 28px); background: oklch(0.185 0.008 264); display: grid; justify-items: center",
              )}
            >
              <Live
                hold={540}
                style={{ width: "100%", maxWidth: 440 }}
                config={{
                  integrator: "web.mavna.app",
                  network: "testnet",
                  variant: "compact",
                  appearance: "dark",
                }}
              />
            </div>
            <div
              data-reveal=""
              style={s("display: grid; gap: clamp(18px, 2.2vw, 24px); align-content: center")}
            >
              <p
                style={s(
                  "margin: 0; font-size: 17px; line-height: 1.6; color: oklch(0.86 0.008 85); max-width: 34ch",
                )}
              >
                The Mavna App is a web interface for moving money from another chain onto Stellar.
                You pick where your money is now and type the Stellar address it should land in, and
                every rail is asked at once. You see each route ranked by what actually arrives, and
                a plain reason for any that could not serve you, before you commit to anything.
              </p>
              <p
                style={s(
                  "margin: 0; font-size: 17px; line-height: 1.6; color: oklch(0.74 0.012 250); max-width: 34ch",
                )}
              >
                There is no sign-up and no account. You connect the wallet you already use, confirm
                exactly what you are sending, and it lands on Stellar.
              </p>
              <Hover
                as="a"
                href={APP}
                external
                base="justify-self: start; margin-top: 6px; font-size: 15.5px; color: oklch(0.92 0.008 85); border-bottom: 1px solid oklch(0.44 0.02 250); padding-bottom: 3px; transition: border-color .45s ease"
                hover="border-color: oklch(0.92 0.008 85)"
              >
                Open mavna.app
              </Hover>
            </div>
          </div>
        </div>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1.35fr; gap: clamp(24px, 5vw, 70px); align-items: end; padding-bottom: 26px",
          )}
        >
          <h2
            style={s(
              "margin: 0; font-weight: 300; font-size: clamp(28px, 3.4vw, 46px); letter-spacing: -0.03em; line-height: 1.04; max-width: 20ch",
            )}
          >
            Mavna isn’t a bridge. It is every bridge at once.
          </h2>
        </div>
        <div>
          {[
            { name: "Circle CCTP", asset: "USDC", who: "Circle itself" },
            { name: "LayerZero OFT", asset: "USDT0", who: "The verifiers the token trusts" },
            { name: "Axelar ITS", asset: "Interchain assets", who: "A named group of validators" },
            { name: "Allbridge Core", asset: "Pooled stablecoins", who: "A pool of money" },
            { name: "NEAR Intents", asset: "Native assets, BTC to XLM", who: "Traders bid for it" },
          ].map((rail, i, arr) => (
            <Hover
              key={rail.name}
              row2
              base={`display: grid; grid-template-columns: 1fr 1.1fr 0.9fr; gap: clamp(10px, 2vw, 30px); align-items: baseline; padding: clamp(19px, 2.2vw, 26px) 0; border-top: 1px solid oklch(0.885 0.006 85);${i === arr.length - 1 ? " border-bottom: 1px solid oklch(0.885 0.006 85);" : ""} transition: padding-left .5s cubic-bezier(.2,.7,.2,1)`}
              hover="padding-left: 10px"
            >
              <span style={s("font-size: clamp(19px, 2vw, 23px); font-weight: 300")}>
                {rail.name}
              </span>
              <span style={s("font-size: 15px; color: oklch(0.45 0.012 250)")}>{rail.asset}</span>
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: oklch(0.55 0.012 250)",
                )}
              >
                {rail.who}
              </span>
            </Hover>
          ))}
        </div>
      </section>

      <section
        id="app"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1.15fr; gap: clamp(30px, 6vw, 90px); align-items: start",
          )}
        >
          <div>
            <h2
              style={s(
                "margin: 0; font-weight: 300; font-size: clamp(28px, 3.8vw, 52px); line-height: 1.04; letter-spacing: -0.034em; max-width: 15ch",
              )}
            >
              The address does not have to exist yet.
            </h2>
            <div
              style={s(
                "margin-top: clamp(14px, 1.8vw, 20px); font-family: 'IBM Plex Mono', monospace; font-size: 15px; letter-spacing: 0.12em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              We put up the reserve
            </div>
            <p
              style={s(
                "margin: clamp(20px, 2.6vw, 28px) 0 0; font-size: 16.5px; line-height: 1.62; color: oklch(0.42 0.012 250); max-width: 36ch",
              )}
            >
              A new Stellar account has to lock up 1.5 XLM before it can hold a coin like USDC.
              Someone arriving from another chain has no XLM yet, and most products stop right here
              and tell them to go and buy some first.
            </p>
            <p
              style={s(
                "margin: 18px 0 0; font-size: 16.5px; line-height: 1.62; color: oklch(0.42 0.012 250); max-width: 36ch",
              )}
            >
              We put it up for you, and the money coming in pays us back inside the same transfer.
              The 1.5 XLM stays locked in your own account. It is not a fee anyone keeps, and it is
              released back to you if you ever close the account.
            </p>
          </div>
          <div>
            {[
              {
                title: "You agree to pay it back",
                note: "You sign this with the wallet that will receive the funds, before we put anything up. The signature can only spend money that has not arrived yet, so it cannot move anything on its own.",
                tag: "Signed",
                accent: false,
              },
              {
                title: "You send",
                note: "Your money starts moving. Nothing has been put up yet.",
                tag: "Nothing lent",
                accent: false,
              },
              {
                title: "We open the account, as late as we can",
                note: "Only once your money is certain to arrive, so the account is ready the moment it lands.",
                tag: "1.50 XLM lent",
                accent: true,
              },
              {
                title: "It arrives and pays us back",
                note: "The moment it is delivered, the repayment goes through with it. Nobody owes anyone anything, and the account is yours.",
                tag: "Repaid",
                accent: false,
                last: true,
              },
            ].map((row) => (
              <div
                key={row.title}
                style={s(
                  `display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: baseline; padding: clamp(17px, 2vw, 23px) 0; border-top: 1px solid oklch(0.885 0.006 85);${row.last ? " border-bottom: 1px solid oklch(0.885 0.006 85)" : ""}`,
                )}
              >
                <div>
                  <div style={s("font-size: 16.5px")}>{row.title}</div>
                  <div
                    style={s(
                      "margin-top: 5px; font-size: 14.5px; line-height: 1.5; color: oklch(0.50 0.012 250); max-width: 40ch",
                    )}
                  >
                    {row.note}
                  </div>
                </div>
                <span
                  style={s(
                    `font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: ${row.accent ? "oklch(0.60 0.075 45)" : "oklch(0.55 0.012 250)"}; white-space: nowrap`,
                  )}
                >
                  {row.tag}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="trustlines"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <h2
          style={s(
            "margin: clamp(18px, 2.4vw, 26px) 0 0; font-weight: 300; font-size: clamp(30px, 4.6vw, 68px); line-height: 1.01; letter-spacing: -0.036em; max-width: 17ch",
          )}
        >
          Nobody has to know what a trustline is.
        </h2>
        <p
          style={s(
            "margin: clamp(20px, 2.6vw, 30px) 0 0; font-size: 16.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 52ch",
          )}
        >
          On Stellar, an account has to say yes to a coin before it can hold it. That yes costs a
          little XLM, and it is what turns a simple deposit into a chore.
        </p>
        <div
          data-row=""
          style={s(
            "margin-top: clamp(40px, 6vw, 72px); display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 76px); align-items: start",
          )}
        >
          <div>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.58 0.012 250); padding-bottom: 16px; border-bottom: 1px solid oklch(0.885 0.006 85)",
              )}
            >
              Everywhere else
            </div>
            <div
              style={s(
                "display: grid; gap: 14px; padding-top: 18px; color: oklch(0.52 0.012 250); font-size: 15.5px; line-height: 1.5",
              )}
            >
              {[
                "Find some XLM somewhere",
                "Send it to the new address to open the account",
                "Work out which wallet screen adds a trustline",
                "Add one for the exact coin you are about to receive",
                "Go back and start the transfer",
              ].map((step, i) => (
                <div
                  key={step}
                  style={s("display: grid; grid-template-columns: 26px 1fr; gap: 10px")}
                >
                  <span
                    style={s(
                      "font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: oklch(0.66 0.01 85)",
                    )}
                  >
                    {`0${i + 1}`}
                  </span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45); padding-bottom: 16px; border-bottom: 1px solid oklch(0.60 0.075 45)",
              )}
            >
              Here
            </div>
            <div
              style={s(
                "padding-top: 18px; font-weight: 300; font-size: clamp(22px, 2.6vw, 32px); line-height: 1.25; letter-spacing: -0.026em; max-width: 18ch",
              )}
            >
              Paste the address and send.
            </div>
            <p
              style={s(
                "margin: clamp(16px, 2vw, 22px) 0 0; font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 34ch",
              )}
            >
              We say yes to the coin for you, inside the transfer, whether the account is brand new
              or has simply never held that coin before. Your users never see the word, and it is
              never a step they can get wrong.
            </p>
          </div>
        </div>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <h2
          style={s(
            "margin: 0 0 clamp(36px, 5vw, 60px); font-weight: 300; font-size: clamp(30px, 4.6vw, 68px); line-height: 1.01; letter-spacing: -0.036em; max-width: 18ch",
          )}
        >
          Arrive on Stellar without the hassle.
        </h2>
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(30px, 6vw, 90px); align-items: center",
          )}
        >
          <div
            style={s(
              "display: grid; gap: clamp(6px, 0.9vw, 12px); font-weight: 300; font-size: clamp(22px, 2.8vw, 36px); line-height: 1.16; letter-spacing: -0.028em",
            )}
          >
            {[
              "Buy XLM before you can start",
              "Open a trustline for the coin",
              "Fund and create the account",
              "Work out which bridge to use",
              "Bridge first, then swap by hand",
            ].map((t) => (
              <span
                key={t}
                style={s(
                  "color: oklch(0.66 0.012 250); text-decoration: line-through; text-decoration-color: oklch(0.60 0.075 45 / 0.55); text-decoration-thickness: 2px",
                )}
              >
                {t}
              </span>
            ))}
          </div>
          <div
            style={s(
              "border-left: 1px solid oklch(0.885 0.006 85); padding-left: clamp(24px, 4vw, 48px)",
            )}
          >
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              You
            </div>
            <p
              style={s(
                "margin: 14px 0 0; font-weight: 300; font-size: clamp(26px, 3.4vw, 46px); line-height: 1.1; letter-spacing: -0.03em; color: oklch(0.24 0.012 250)",
              )}
            >
              Paste an address and send, even with nothing on Stellar yet.
            </p>
          </div>
        </div>
      </section>

      <section style={s("background: #171717; color: oklch(0.955 0.004 85)")}>
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
          )}
        >
          <div
            data-row=""
            data-reveal=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1.2fr; gap: clamp(28px, 5vw, 80px); align-items: end; padding-bottom: clamp(34px, 5vw, 56px)",
            )}
          >
            <h2
              style={s(
                "margin: 0; font-weight: 300; font-size: clamp(28px, 3.6vw, 48px); line-height: 1.04; letter-spacing: -0.034em; max-width: 14ch",
              )}
            >
              Mavna delivers what you want
            </h2>
            <p
              style={s(
                "margin: 0; font-size: 16px; line-height: 1.62; color: oklch(0.74 0.012 250); max-width: 46ch",
              )}
            >
              A bridge hands over whatever it happens to carry, which is often not the coin you
              wanted. Mavna keeps going: it trades that for the one you asked for on Stellar’s own
              exchanges, in the same transfer, and puts it in the account.
            </p>
          </div>
          <div
            data-reveal=""
            data-flow=""
            style={s(
              "display: flex; align-items: stretch; gap: clamp(8px, 1.5vw, 22px); border-top: 1px solid oklch(0.30 0.008 250); padding-top: clamp(30px, 4vw, 48px)",
            )}
          >
            <div
              data-conn=""
              style={s("flex: 1 1 0; min-width: 0; display: grid; gap: 12px; align-content: start")}
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
                )}
              >
                You have
              </span>
              <span
                style={s(
                  "font-weight: 300; font-size: clamp(20px, 2.3vw, 31px); line-height: 1.12; letter-spacing: -0.026em; color: oklch(0.88 0.008 85)",
                )}
              >
                A coin on another chain
              </span>
            </div>
            <div
              data-conn=""
              style={s(
                "flex: 0 0 auto; width: clamp(104px, 13vw, 164px); display: grid; gap: 12px; justify-items: center; align-content: center; text-align: center",
              )}
            >
              <span
                data-arrow=""
                style={s(
                  "font-weight: 300; font-size: 30px; line-height: 1; color: oklch(0.58 0.05 45)",
                )}
              >
                →
              </span>
            </div>
            <div
              data-conn=""
              style={s("flex: 1 1 0; min-width: 0; display: grid; gap: 12px; align-content: start")}
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
                )}
              >
                It lands
              </span>
              <span
                style={s(
                  "font-weight: 300; font-size: clamp(20px, 2.3vw, 31px); line-height: 1.12; letter-spacing: -0.026em; color: oklch(0.88 0.008 85)",
                )}
              >
                Whatever that bridge carries
              </span>
            </div>
            <div
              data-conn=""
              style={s(
                "flex: 0 0 auto; width: clamp(104px, 13vw, 164px); display: grid; gap: 12px; justify-items: center; align-content: center; text-align: center",
              )}
            >
              <span
                data-arrow=""
                style={s(
                  "font-weight: 300; font-size: 30px; line-height: 1; color: oklch(0.58 0.05 45)",
                )}
              >
                →
              </span>
            </div>
            <div
              data-conn=""
              style={s("flex: 1 1 0; min-width: 0; display: grid; gap: 12px; align-content: start")}
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
                )}
              >
                You get
              </span>
              <span
                style={s(
                  "font-weight: 300; font-size: clamp(20px, 2.3vw, 31px); line-height: 1.12; letter-spacing: -0.026em; color: oklch(0.96 0.008 85)",
                )}
              >
                The coin you actually asked for
              </span>
            </div>
          </div>
        </div>
      </section>

      <section
        id="swap"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(30px, 6vw, 90px); align-items: start",
          )}
        >
          <div>
            <h2
              style={s(
                "margin: clamp(18px, 2.4vw, 26px) 0 0; font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.03; letter-spacing: -0.034em; max-width: 17ch",
              )}
            >
              A bridge can only hand over what it carries.
            </h2>
            <p
              style={s(
                "margin: clamp(20px, 2.6vw, 30px) 0 0; font-size: 16.5px; line-height: 1.62; color: oklch(0.42 0.012 250); max-width: 38ch",
              )}
            >
              If that is not the coin you asked for, Mavna adds one more step on Stellar and trades
              it for you. It is part of the same transfer and the same quote, so the amount you were
              shown at the start already includes it.
            </p>
          </div>
          <div>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.55 0.012 250); padding-bottom: 16px",
              )}
            >
              Where the trade happens
            </div>
            {[
              {
                name: "Stellar's own order book",
                note: "Built into the network. No third party, and it is always there.",
              },
              {
                name: "Soroswap",
                note: "Looks across Stellar’s pools at once and takes the best of them.",
              },
              {
                name: "Aquarius",
                note: "Its own pools, as a second opinion on every price.",
                last: true,
              },
            ].map((v) => (
              <div
                key={v.name}
                style={s(
                  `display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: clamp(16px, 2vw, 22px) 0; border-top: 1px solid oklch(0.885 0.006 85);${v.last ? " border-bottom: 1px solid oklch(0.885 0.006 85)" : ""}`,
                )}
              >
                <div style={s("font-size: 17px")}>{v.name}</div>
                <div
                  style={s(
                    "font-size: 15px; line-height: 1.55; color: oklch(0.48 0.012 250); max-width: 40ch",
                  )}
                >
                  {v.note}
                </div>
              </div>
            ))}
            <p
              style={s(
                "margin: clamp(18px, 2.2vw, 24px) 0 0; font-size: 15px; line-height: 1.6; color: oklch(0.48 0.012 250); max-width: 40ch",
              )}
            >
              We check which of them can actually serve your pair, then use the one that leaves you
              with more.
            </p>
          </div>
        </div>
        <div
          data-row2=""
          style={s(
            "margin-top: clamp(44px, 6vw, 76px); display: grid; grid-template-columns: repeat(3, 1fr); gap: clamp(24px, 4vw, 56px)",
          )}
        >
          {[
            {
              title: "Priced at the last second",
              note: "We ask for the price again right before trading. Never the one from when you started.",
            },
            {
              title: "Your floor goes with it",
              note: "You set the least you will accept. If the market moves past it, the trade does not happen.",
            },
            {
              title: "Never a substitute",
              note: "If no venue can trade that pair, you are told before you send anything, and never handed something else instead.",
            },
          ].map((f) => (
            <div
              key={f.title}
              style={s(
                "padding-top: clamp(18px, 2.2vw, 24px); border-top: 1px solid oklch(0.24 0.012 250)",
              )}
            >
              <div
                style={s(
                  "font-size: clamp(17px, 1.8vw, 20px); font-weight: 300; letter-spacing: -0.018em",
                )}
              >
                {f.title}
              </div>
              <p
                style={s(
                  "margin: 10px 0 0; font-size: 15px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 30ch",
                )}
              >
                {f.note}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section
        id="open"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <Hover
          as="a"
          href={APP}
          external
          base="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 20px; padding: clamp(26px, 4vw, 52px) 0; border-top: 1px solid oklch(0.24 0.012 250); border-bottom: 1px solid oklch(0.24 0.012 250); transition: padding-left .6s cubic-bezier(.2,.7,.2,1), color .4s ease"
          hover="padding-left: 18px; color: oklch(0.60 0.075 45)"
        >
          <span
            style={s(
              "font-weight: 300; font-size: clamp(38px, 7vw, 104px); line-height: 0.98; letter-spacing: -0.04em",
            )}
          >
            Open mavna.app
          </span>
          <span style={s("font-weight: 300; font-size: clamp(30px, 5vw, 72px); line-height: 1")}>
            →
          </span>
        </Hover>
      </section>

      <section id="sdk" style={s("background: #171717; color: oklch(0.955 0.004 85)")}>
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
          )}
        >
          <div
            data-row=""
            data-reveal=""
            style={s(
              "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(30px, 6vw, 90px); align-items: end",
            )}
          >
            <h2
              style={s(
                "margin: 0; font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.02; letter-spacing: -0.036em; max-width: 15ch",
              )}
            >
              Mavna, as code you build on.
            </h2>
            <p
              style={s(
                "margin: 0; font-size: 16px; line-height: 1.62; color: oklch(0.74 0.012 250); max-width: 42ch",
              )}
            >
              The SDK is the same engine our own app runs on, opened up as a small set of packages
              you build your own interface on. You bring the wallet and the screens; it moves value
              into Stellar behind one interface, so you never have to learn a single bridge’s own
              toolkit.
            </p>
          </div>

          <div
            data-row=""
            data-reveal=""
            style={s(
              "margin-top: clamp(40px, 6vw, 72px); display: grid; grid-template-columns: 1.1fr 1fr; gap: clamp(30px, 6vw, 90px); align-items: start",
            )}
          >
            <pre
              style={s(
                "margin: 0; overflow-x: auto; font-family: 'IBM Plex Mono', monospace; font-size: clamp(12px, 1.05vw, 13.5px); line-height: 1.95; color: oklch(0.88 0.008 85)",
              )}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: a static, author-written syntax-highlighted snippet, no user input.
              dangerouslySetInnerHTML={{ __html: CODE_HTML }}
            />
            <div>
              <p
                style={s(
                  "margin: 0; font-size: 16px; line-height: 1.62; color: oklch(0.74 0.012 250); max-width: 36ch",
                )}
              >
                You ask once and work with the answer. What happens underneath, which bridges exist,
                how each one is reached, what network you are on, is Mavna’s problem, not something
                your code has to know.
              </p>
              <p
                style={s(
                  "margin: 18px 0 0; font-size: 16px; line-height: 1.62; color: oklch(0.74 0.012 250); max-width: 36ch",
                )}
              >
                It builds; you sign. No package can hold a key, so custody stays with your users
                from first call to last.
              </p>
            </div>
          </div>
          <div
            data-reveal=""
            data-row2=""
            style={s(
              "margin-top: clamp(44px, 7vw, 84px); display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: oklch(0.30 0.008 250); border: 1px solid oklch(0.30 0.008 250)",
            )}
          >
            {[
              { pkg: "@mavna/core", note: "The words everything else uses." },
              {
                pkg: "@mavna/routing",
                note: "Asks the bridges, ranks the answers, adds the swap.",
              },
              { pkg: "@mavna/stellar", note: "Reads Stellar and does the account math." },
              { pkg: "@mavna/status", note: "Follows a transfer, and finds it again later." },
              { pkg: "@mavna/swap", note: "Stellar's exchanges, in one place." },
              {
                pkg: "@mavna/adapter-*",
                note: "One per bridge. Add a rail by adding a file, not by touching the rest.",
              },
            ].map((p) => (
              <div key={p.pkg} style={s("background: #171717; padding: clamp(20px, 2.4vw, 30px)")}>
                <div
                  style={s(
                    "font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: oklch(0.90 0.008 85); word-break: break-word",
                  )}
                >
                  {p.pkg}
                </div>
                <div
                  style={s(
                    "margin-top: 9px; font-size: 14.5px; line-height: 1.55; color: oklch(0.66 0.012 250)",
                  )}
                >
                  {p.note}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="whole"
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <h2
          style={s(
            "margin: clamp(18px, 2.4vw, 26px) 0 clamp(34px, 5vw, 54px); font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.02; letter-spacing: -0.036em; max-width: 20ch",
          )}
        >
          The whole transfer, not just the crossing.
        </h2>

        <div style={s("position: relative")}>
          <div
            data-crossbrace=""
            style={s(
              "position: absolute; top: -30px; left: 40%; width: 20%; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none",
            )}
          >
            <span
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: oklch(0.60 0.075 45); white-space: nowrap",
              )}
            >
              Where most tools stop
            </span>
            <span
              style={s(
                "width: 100%; height: 6px; border: 1px solid oklch(0.60 0.075 45 / 0.5); border-bottom: none",
              )}
            />
          </div>
          <div data-bar="" style={s("display: flex; border: 1px solid oklch(0.885 0.006 85)")}>
            <div
              data-seg=""
              style={s(
                "flex: 1 1 0; min-width: 0; padding: clamp(20px, 2.4vw, 30px) clamp(16px, 1.8vw, 24px)",
              )}
            >
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; color: oklch(0.62 0.012 250)",
                )}
              >
                01
              </div>
              <div
                style={s("margin-top: 12px; font-size: clamp(16px, 1.5vw, 18px); font-weight: 400")}
              >
                Ask & route
              </div>
              <div
                style={s(
                  "margin-top: 7px; font-size: 13.5px; line-height: 1.5; color: oklch(0.50 0.012 250)",
                )}
              >
                Every bridge is asked at once and ranked by what lands.
              </div>
            </div>
            <div
              data-seg=""
              style={s(
                "flex: 1 1 0; min-width: 0; padding: clamp(20px, 2.4vw, 30px) clamp(16px, 1.8vw, 24px); border-left: 1px solid oklch(0.885 0.006 85)",
              )}
            >
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; color: oklch(0.62 0.012 250)",
                )}
              >
                02
              </div>
              <div
                style={s("margin-top: 12px; font-size: clamp(16px, 1.5vw, 18px); font-weight: 400")}
              >
                Set up
              </div>
              <div
                style={s(
                  "margin-top: 7px; font-size: 13.5px; line-height: 1.5; color: oklch(0.50 0.012 250)",
                )}
              >
                The receiving account is opened and made able to hold the coin.
              </div>
            </div>
            <div
              data-seg=""
              style={s(
                "flex: 0.85 1 0; min-width: 0; padding: clamp(20px, 2.4vw, 30px) clamp(16px, 1.8vw, 24px); background: oklch(0.60 0.075 45 / 0.09); border-left: 1px solid oklch(0.60 0.075 45 / 0.4); border-right: 1px solid oklch(0.60 0.075 45 / 0.4)",
              )}
            >
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; color: oklch(0.55 0.075 45)",
                )}
              >
                03
              </div>
              <div
                style={s(
                  "margin-top: 12px; font-size: clamp(16px, 1.5vw, 18px); font-weight: 400; color: oklch(0.42 0.055 40)",
                )}
              >
                The crossing
              </div>
              <div
                style={s(
                  "margin-top: 7px; font-size: 13.5px; line-height: 1.5; color: oklch(0.52 0.05 45)",
                )}
              >
                A bridge moves the value. This is the only part it does.
              </div>
            </div>
            <div
              data-seg=""
              style={s(
                "flex: 1 1 0; min-width: 0; padding: clamp(20px, 2.4vw, 30px) clamp(16px, 1.8vw, 24px); border-left: 1px solid oklch(0.885 0.006 85)",
              )}
            >
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; color: oklch(0.62 0.012 250)",
                )}
              >
                04
              </div>
              <div
                style={s("margin-top: 12px; font-size: clamp(16px, 1.5vw, 18px); font-weight: 400")}
              >
                Swap
              </div>
              <div
                style={s(
                  "margin-top: 7px; font-size: 13.5px; line-height: 1.5; color: oklch(0.50 0.012 250)",
                )}
              >
                Traded on Stellar into the coin you actually asked for.
              </div>
            </div>
            <div
              data-seg=""
              style={s(
                "flex: 1 1 0; min-width: 0; padding: clamp(20px, 2.4vw, 30px) clamp(16px, 1.8vw, 24px); border-left: 1px solid oklch(0.885 0.006 85)",
              )}
            >
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; color: oklch(0.62 0.012 250)",
                )}
              >
                05
              </div>
              <div
                style={s("margin-top: 12px; font-size: clamp(16px, 1.5vw, 18px); font-weight: 400")}
              >
                Deliver & track
              </div>
              <div
                style={s(
                  "margin-top: 7px; font-size: 13.5px; line-height: 1.5; color: oklch(0.50 0.012 250)",
                )}
              >
                Put in the account, and followable until it lands or is refunded.
              </div>
            </div>
          </div>
          <div
            data-crossbrace=""
            style={s(
              "margin-top: 8px; display: flex; flex-direction: column; align-items: center; gap: 8px",
            )}
          >
            <span
              style={s(
                "width: 100%; height: 8px; border: 1px solid oklch(0.60 0.075 45 / 0.45); border-top: none",
              )}
            />
            <span
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              Mavna does all five
            </span>
          </div>
        </div>

        <p
          style={s(
            "margin: clamp(30px, 4vw, 48px) auto 0; text-align: center; font-size: 16px; line-height: 1.62; color: oklch(0.45 0.012 250); max-width: 58ch",
          )}
        >
          Everything else hands you the middle box and calls it done. The SDK gives you the whole
          row, so you wire in one thing instead of stitching a bridge, an exchange, an account-setup
          step and a tracker together yourself.
        </p>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <Hover
          as="a"
          href={DOCS}
          base="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 20px; padding: clamp(26px, 4vw, 52px) 0; border-top: 1px solid oklch(0.24 0.012 250); border-bottom: 1px solid oklch(0.24 0.012 250); transition: padding-left .6s cubic-bezier(.2,.7,.2,1), color .4s ease"
          hover="padding-left: 18px; color: oklch(0.60 0.075 45)"
        >
          <span
            style={s(
              "font-weight: 300; font-size: clamp(38px, 7vw, 104px); line-height: 0.98; letter-spacing: -0.04em",
            )}
          >
            Build on the SDK
          </span>
          <span style={s("font-weight: 300; font-size: clamp(30px, 5vw, 72px); line-height: 1")}>
            →
          </span>
        </Hover>
      </section>

      <section
        id="widget"
        data-reveal=""
        style={s("background: #171717; color: oklch(0.955 0.004 85)")}
      >
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
          )}
        >
          <h2
            style={s(
              "margin: clamp(18px, 2.4vw, 26px) 0 0; font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.02; letter-spacing: -0.036em; max-width: 20ch",
            )}
          >
            Everything a cross-chain deposit needs, in one drop-in.
          </h2>
          <p
            style={s(
              "margin: clamp(18px, 2.4vw, 24px) 0 0; font-size: 16.5px; line-height: 1.62; color: oklch(0.74 0.012 250); max-width: 56ch",
            )}
          >
            Run a wallet, an exchange, or anything whose users hold money on other chains, and this
            is how they bring it onto Stellar from inside your product. The same flow our own app
            runs.
          </p>
          <div
            data-row=""
            style={s(
              "margin-top: clamp(46px, 7vw, 84px); display: grid; grid-template-columns: 1fr auto 1fr; gap: clamp(18px, 3vw, 44px); align-items: center",
            )}
          >
            <div style={s("display: grid; gap: 10px")}>
              <div
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: oklch(0.55 0.012 250); padding-bottom: 4px",
                )}
              >
                What you would build yourself
              </div>
              {[
                "Routing across every bridge",
                "Live quotes, kept ranked",
                "Tracking a transfer in flight",
                "Recovering the ones that stall",
                "Wallet prompts, in plain words",
              ].map((t) => (
                <div
                  key={t}
                  style={s(
                    "display: flex; align-items: center; gap: 11px; padding: 12px 15px; border: 1px dashed oklch(0.34 0.01 250); border-radius: 10px",
                  )}
                >
                  <span
                    style={s(
                      "width: 5px; height: 5px; border-radius: 50%; background: oklch(0.44 0.01 250); flex: none",
                    )}
                  />
                  <span style={s("font-size: 14.5px; color: oklch(0.64 0.012 250)")}>{t}</span>
                </div>
              ))}
            </div>
            <div
              data-arrow=""
              style={s(
                "font-weight: 300; font-size: clamp(28px, 3.5vw, 48px); line-height: 1; color: oklch(0.62 0.075 45); justify-self: center",
              )}
            >
              →
            </div>
            <div
              style={s(
                "border: 1px solid oklch(0.34 0.012 250); border-radius: 18px; padding: clamp(22px, 3vw, 38px); background: oklch(0.185 0.008 264); display: grid; gap: clamp(18px, 2.2vw, 26px)",
              )}
            >
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: oklch(0.82 0.06 55)",
                )}
              >
                @mavna/widget
              </span>
              <div
                style={s(
                  "border: 1px solid oklch(0.34 0.012 250); border-radius: 12px; padding: clamp(14px, 1.8vw, 18px); background: oklch(0.20 0.008 264); display: grid; gap: 10px",
                )}
              >
                <span
                  style={s(
                    "font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: oklch(0.66 0.06 50)",
                  )}
                >
                  Transfer
                </span>
                <span
                  style={s(
                    "height: 8px; border-radius: 999px; background: oklch(0.32 0.01 250); width: 72%",
                  )}
                />
                <span
                  style={s(
                    "height: 8px; border-radius: 999px; background: oklch(0.32 0.01 250); width: 50%",
                  )}
                />
                <span
                  style={s(
                    "height: 30px; border-radius: 999px; background: oklch(0.62 0.085 48); width: 100%; margin-top: 2px",
                  )}
                />
              </div>
              <div style={s("display: grid; gap: 10px")}>
                <span
                  style={s(
                    "font-weight: 300; font-size: clamp(20px, 2.6vw, 32px); line-height: 1.1; letter-spacing: -0.024em; color: oklch(0.96 0.008 85)",
                  )}
                >
                  One component you drop in.
                </span>
                <span
                  style={s("font-size: 14.5px; line-height: 1.5; color: oklch(0.74 0.012 250)")}
                >
                  The quote, the confirmation and the wait, all inside it.
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <h2
          style={s(
            "margin: 0; font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.02; letter-spacing: -0.036em; max-width: 18ch",
          )}
        >
          Inline in the page, or a tap away.
        </h2>
        <p
          style={s(
            "margin: clamp(18px, 2.4vw, 24px) 0 clamp(44px, 6vw, 72px); font-size: 16.5px; line-height: 1.62; color: oklch(0.45 0.012 250); max-width: 56ch",
          )}
        >
          Two ways to place the same flow, and both are the real widget, live against the test
          network right here.
        </p>
        <div
          data-row=""
          style={s(
            "display: grid; grid-template-columns: 1fr 1fr; gap: clamp(30px, 5vw, 72px); align-items: start",
          )}
        >
          <div>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              Compact
            </div>
            <p
              style={s(
                "margin: clamp(14px, 1.8vw, 20px) 0 0; font-weight: 300; font-size: clamp(21px, 2.4vw, 31px); line-height: 1.14; letter-spacing: -0.026em; color: oklch(0.24 0.012 250); max-width: 18ch",
              )}
            >
              A card that lives in your page.
            </p>
            <p
              style={s(
                "margin: clamp(14px, 1.8vw, 20px) 0 clamp(26px, 3vw, 36px); font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 40ch",
              )}
            >
              Drop it into a sidebar, a checkout, or a panel. It takes the width you give it and sits
              on your own surface, with no overlay and no takeover.
            </p>
            <div
              style={s(
                "border: 1px solid oklch(0.885 0.006 85); border-radius: 20px; padding: clamp(16px, 2vw, 26px); background: oklch(0.99 0.003 85); display: grid; justify-items: center",
              )}
            >
              <Live
                hold={520}
                style={{ width: "100%", maxWidth: 420 }}
                config={{
                  integrator: "web.mavna.app",
                  network: "testnet",
                  variant: "compact",
                  appearance: "light",
                }}
              />
            </div>
          </div>
          <div>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              Drawer
            </div>
            <p
              style={s(
                "margin: clamp(14px, 1.8vw, 20px) 0 0; font-weight: 300; font-size: clamp(21px, 2.4vw, 31px); line-height: 1.14; letter-spacing: -0.026em; color: oklch(0.24 0.012 250); max-width: 18ch",
              )}
            >
              A button, and the flow on demand.
            </p>
            <p
              style={s(
                "margin: clamp(14px, 1.8vw, 20px) 0 clamp(26px, 3vw, 36px); font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 40ch",
              )}
            >
              Place one trigger anywhere. It rises from the bottom over your page, and closes on its
              own button or the Escape key the moment they are done.
            </p>
            <div
              style={s(
                "border: 1px solid oklch(0.885 0.006 85); border-radius: 20px; padding: clamp(22px, 3vw, 40px); background: oklch(0.99 0.003 85); display: grid; justify-items: center; align-content: center; min-height: 260px",
              )}
            >
              <Live
                hold={120}
                style={{ display: "grid", justifyItems: "center" }}
                config={{
                  integrator: "web.mavna.app",
                  network: "testnet",
                  variant: "drawer",
                  appearance: "light",
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <h2
          style={s(
            "margin: 0; font-weight: 300; font-size: clamp(28px, 4vw, 56px); line-height: 1.02; letter-spacing: -0.036em; max-width: 16ch",
          )}
        >
          Yours to style, yours to steer.
        </h2>
        <p
          style={s(
            "margin: clamp(18px, 2.4vw, 24px) 0 clamp(44px, 6vw, 72px); font-size: 16.5px; line-height: 1.62; color: oklch(0.45 0.012 250); max-width: 56ch",
          )}
        >
          You never touch how it works. You decide how it looks and what it offers, and both are
          settings you change whenever you like, not a rebuild.
        </p>
        <div
          data-row=""
          style={s("display: grid; grid-template-columns: 1fr 1fr; gap: clamp(30px, 5vw, 72px)")}
        >
          <div style={s("padding-right: clamp(4px, 2vw, 24px)")}>
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              Looks like you
            </div>
            <p
              style={s(
                "margin: clamp(16px, 2vw, 22px) 0 0; font-weight: 300; font-size: clamp(22px, 2.6vw, 34px); line-height: 1.14; letter-spacing: -0.028em; color: oklch(0.24 0.012 250); max-width: 18ch",
              )}
            >
              It takes your colours, your type and your shape.
            </p>
            <p
              style={s(
                "margin: clamp(16px, 2vw, 22px) 0 0; font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 40ch",
              )}
            >
              Match it to your brand once and it stays matched. There is no design work, and nothing
              to keep in sync afterwards.
            </p>
          </div>
          <div
            style={s(
              "border-left: 1px solid oklch(0.885 0.006 85); padding-left: clamp(28px, 4vw, 56px)",
            )}
          >
            <div
              style={s(
                "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.60 0.075 45)",
              )}
            >
              Shows what you choose
            </div>
            <p
              style={s(
                "margin: clamp(16px, 2vw, 22px) 0 0; font-weight: 300; font-size: clamp(22px, 2.6vw, 34px); line-height: 1.14; letter-spacing: -0.028em; color: oklch(0.24 0.012 250); max-width: 18ch",
              )}
            >
              You pick which routes appear, and what they cost.
            </p>
            <p
              style={s(
                "margin: clamp(16px, 2vw, 22px) 0 0; font-size: 15.5px; line-height: 1.6; color: oklch(0.45 0.012 250); max-width: 40ch",
              )}
            >
              Offer only the bridges you stand behind, add your own fee, or switch a provider off.
              Each one is a setting in config, not a rebuild of the flow.
            </p>
          </div>
        </div>
      </section>

      <section
        data-reveal=""
        style={s(
          "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px)",
        )}
      >
        <Hover
          as="a"
          href={PLAYGROUND}
          base="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 20px; padding: clamp(26px, 4vw, 52px) 0; border-top: 1px solid oklch(0.24 0.012 250); border-bottom: 1px solid oklch(0.24 0.012 250); transition: padding-left .6s cubic-bezier(.2,.7,.2,1), color .4s ease"
          hover="padding-left: 18px; color: oklch(0.60 0.075 45)"
        >
          <span
            style={s(
              "font-weight: 300; font-size: clamp(38px, 7vw, 104px); line-height: 0.98; letter-spacing: -0.04em",
            )}
          >
            Embed the widget
          </span>
          <span style={s("font-weight: 300; font-size: clamp(30px, 5vw, 72px); line-height: 1")}>
            →
          </span>
        </Hover>
      </section>

      <footer style={s("background: #171717; color: oklch(0.90 0.008 85)")}>
        <div
          style={s(
            "max-width: 1180px; margin: 0 auto; padding: clamp(58px, 8.5vh, 112px) clamp(20px, 4vw, 48px) 36px",
          )}
        >
          <div
            data-reveal=""
            data-row=""
            style={s(
              "display: grid; grid-template-columns: auto 1fr; gap: clamp(28px, 6vw, 80px); align-items: start; padding-bottom: clamp(48px, 7vw, 88px)",
            )}
          >
            <img
              src="/assets/mark-paper.png"
              alt=""
              style={s("width: clamp(48px, 5vw, 68px); height: clamp(48px, 5vw, 68px)")}
            />
            <div>
              <p
                style={s(
                  "margin: 0; font-family: 'Space Grotesk', 'DM Sans', sans-serif; font-weight: 300; font-size: clamp(24px, 3.2vw, 44px); line-height: 1.22; letter-spacing: -0.03em; max-width: 28ch; color: oklch(0.955 0.004 85)",
                )}
              >
                A mavna is the barge that carries cargo ashore when the ship cannot dock.
              </p>
              <p
                style={s(
                  "margin: clamp(20px, 2.4vw, 28px) 0 0; font-size: 16px; line-height: 1.62; color: oklch(0.72 0.012 250); max-width: 40ch",
                )}
              >
                Just like its name, Mavna does the last part of the trip, the part everyone else
                leaves to you.
              </p>
            </div>
          </div>
          <div
            data-reveal=""
            data-row2=""
            style={s(
              "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: oklch(0.30 0.008 250); border: 1px solid oklch(0.30 0.008 250)",
            )}
          >
            {[
              {
                href: APP,
                tag: "Send something",
                title: "mavna.app",
                note: "Move money onto Stellar in one go.",
              },
              {
                href: DOCS,
                tag: "Build on it",
                title: "SDK quickstart",
                note: "One file, one real quote, off the live network.",
              },
              {
                href: PLAYGROUND,
                tag: "Embed it",
                title: "Widget playground",
                note: "Try the real component, with real quotes.",
              },
            ].map((card) => (
              <Hover
                key={card.title}
                as="a"
                href={card.href}
                base="background: #171717; padding: clamp(26px, 3.4vw, 42px); display: grid; gap: 10px; align-content: start; transition: background .5s ease"
                hover="background: #1d1d1d"
              >
                <span
                  style={s(
                    "font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase; color: oklch(0.72 0.075 45)",
                  )}
                >
                  {card.tag}
                </span>
                <span style={s("font-size: clamp(19px, 2vw, 24px); font-weight: 300")}>
                  {card.title}
                </span>
                <span
                  style={s("font-size: 14.5px; line-height: 1.55; color: oklch(0.66 0.012 250)")}
                >
                  {card.note}
                </span>
              </Hover>
            ))}
          </div>
          <div
            data-reveal=""
            data-row2=""
            style={s(
              "margin-top: clamp(46px, 6vw, 84px); padding-top: clamp(40px, 5vw, 62px); border-top: 1px solid oklch(0.30 0.008 250); display: grid; grid-template-columns: 1.7fr 1fr 1fr; gap: clamp(26px, 4vw, 56px)",
            )}
          >
            <div style={s("display: grid; gap: 16px; align-content: start")}>
              <a href="#top" style={s("display: flex; align-items: center; gap: 11px")}>
                <img
                  src="/assets/mark-paper.png"
                  alt="Mavna"
                  style={s("width: 22px; height: 22px")}
                />
                <span
                  style={s(
                    "font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; letter-spacing: 0.36em; text-transform: uppercase; color: oklch(0.92 0.008 85)",
                  )}
                >
                  Mavna
                </span>
              </a>
              <span
                style={s(
                  "font-size: 14.5px; line-height: 1.55; color: oklch(0.58 0.012 250); max-width: 26ch",
                )}
              >
                Cross-chain delivery into Stellar. Open source and non-custodial.
              </span>
            </div>
            <div style={s("display: grid; gap: 13px; align-content: start")}>
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.52 0.012 250)",
                )}
              >
                Product
              </span>
              <FootLink href={APP}>The app</FootLink>
              <FootLink href={DOCS}>SDK</FootLink>
              <FootLink href={PLAYGROUND}>Widget</FootLink>
            </div>
            <div style={s("display: grid; gap: 13px; align-content: start")}>
              <span
                style={s(
                  "font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: oklch(0.52 0.012 250)",
                )}
              >
                Resources
              </span>
              <FootLink href={DOCS}>Documentation</FootLink>
              <Hover
                as="a"
                href={GITHUB}
                external
                base="font-size: 14.5px; color: oklch(0.80 0.012 250); transition: color .4s ease"
                hover="color: oklch(0.96 0.008 85)"
              >
                GitHub
              </Hover>
            </div>
          </div>
          <div
            style={s(
              "margin-top: clamp(40px, 6vw, 72px); padding-top: 22px; border-top: 1px solid oklch(0.30 0.008 250); display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: oklch(0.55 0.012 250)",
            )}
          >
            <span>© 2026 Mavna</span>
            <span>Running on Stellar testnet</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
