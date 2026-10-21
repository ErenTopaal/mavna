import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// every text token in the stylesheet against every surface text sits on, in each
// theme block, at the WCAG AA ratio for body text. surface-4 is left out: it is
// only the route-detail button's hover, where its glyph turns full ink.
const css = readFileSync(new URL("./widget.css", import.meta.url), "utf8");
const TEXT = [
  "ink",
  "ink-strong",
  "ink-2",
  "ink-3",
  "muted",
  "muted-b",
  "muted-2",
  "faint",
  "faint-2",
  "faintest",
];
const SURFACES = ["ground", "surface", "surface-2", "surface-3"];

function tokens(from: string): Record<string, number> {
  const start = css.indexOf(from);
  const block = css.slice(start, css.indexOf("}", start));
  const out: Record<string, number> = {};
  for (const m of block.matchAll(/--mv-([a-z0-9-]+):\s*oklch\(([\d.]+) 0 0\);/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = Number(m[2]);
  }
  return out;
}

// a grey's oklch lightness is the cube root of its relative luminance
function ratio(a: number, b: number): number {
  const [hi, lo] = [a ** 3, b ** 3].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(".mv-root {");
const themes = {
  light,
  "dark, from the system": { ...light, ...tokens('.mv-root:not([data-mv-theme="light"]) {') },
  "dark, when asked": { ...light, ...tokens('.mv-root[data-mv-theme="dark"] {') },
};

describe("text contrast", () => {
  for (const [name, t] of Object.entries(themes)) {
    it(`keeps every text token at 4.5:1 or more on every surface, ${name}`, () => {
      const short: string[] = [];
      for (const text of TEXT) {
        for (const surface of SURFACES) {
          const [fg, bg] = [t[text], t[surface]];
          if (fg === undefined || bg === undefined)
            throw new Error(`no --mv-${text} or --mv-${surface}`);
          if (ratio(fg, bg) < 4.5) short.push(`${text} on ${surface}: ${ratio(fg, bg).toFixed(2)}`);
        }
      }
      expect(short).toEqual([]);
    });

    it(`keeps the muted steps in order, none merged, ${name}`, () => {
      const steps = ["muted", "muted-b", "muted-2", "faint", "faint-2", "faintest"].map(
        (k) => t[k],
      );
      const toward = (t.ink ?? 0) > (t.ground ?? 0) ? -1 : 1;
      for (let i = 1; i < steps.length; i++) {
        expect(Math.sign((steps[i] ?? 0) - (steps[i - 1] ?? 0))).toBe(toward);
      }
    });
  }
});
