/*
 * Hover / active / focus styling, kept as real CSS pseudo-class rules.
 *
 * The design's template carries `style-hover`, `style-active`, `style-focus` and
 * `style-focus-within` attributes, and its runtime turns each into a generated
 * scoped stylesheet rule rather than a JS mouse handler. This does the same: a
 * declaration block is hashed into a stable class name and its rule is injected
 * once, so the pseudo styles compose over the element's inline base style exactly
 * as the browser does, with no flicker and no re-render on hover.
 *
 * Inputs are the raw CSS declaration strings the design already writes, e.g.
 * "background:oklch(0.245 0 0)". A React style object is also accepted for
 * convenience and converted to the same declaration text.
 */

type Decls = string | Readonly<Record<string, string | number>>;

interface Pseudo {
  readonly hover?: Decls;
  readonly active?: Decls;
  readonly focus?: Decls;
  readonly focusWithin?: Decls;
}

const inserted = new Set<string>();
let sheet: HTMLStyleElement | undefined;

function styleSheet(): HTMLStyleElement | undefined {
  if (typeof document === "undefined") return undefined;
  if (sheet === undefined) {
    sheet = document.createElement("style");
    sheet.setAttribute("data-mv-pseudo", "");
    document.head.appendChild(sheet);
  }
  return sheet;
}

/** Turn a style object into a CSS declaration string; pass strings through. */
function toDecls(input: Decls): string {
  if (typeof input === "string") return input.trim().replace(/;$/, "");
  return Object.entries(input)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(";");
}

/** A short stable hash of the rule text, so identical rules share one class. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

const SELECTORS: Readonly<Record<keyof Pseudo, string>> = {
  hover: ":hover",
  active: ":active",
  focus: ":focus",
  focusWithin: ":focus-within",
};

/**
 * Register the given pseudo-state styles and return the class name that carries
 * them. Call it in render: it is idempotent, keyed on the rule text.
 */
export function pseudo(spec: Pseudo): string {
  const parts: string[] = [];
  for (const key of Object.keys(SELECTORS) as (keyof Pseudo)[]) {
    const decls = spec[key];
    if (decls !== undefined) parts.push(`${SELECTORS[key]}{${toDecls(decls)}}`);
  }
  if (parts.length === 0) return "";
  const className = `mv-p${hash(parts.join("|"))}`;
  if (!inserted.has(className)) {
    inserted.add(className);
    const el = styleSheet();
    if (el !== undefined) {
      // Doubled class raises specificity over the inline-adjacent base rules,
      // matching how the design's own generated sheet outranks defaults.
      el.appendChild(
        document.createTextNode(parts.map((p) => `.${className}.${className}${p}`).join("")),
      );
    }
  }
  return className;
}
