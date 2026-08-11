/*
 * A CSS-string to React style-object parser.
 *
 * The design carries every style as an inline CSS string. React needs a style
 * object, so rather than hand-transcribe each one (and risk changing a value),
 * the design's exact string is pasted into `s("...")` and parsed at runtime. That
 * keeps the port literally 1:1 with the design's styles. Dynamic values are
 * spliced in with template literals before parsing, exactly where the design
 * interpolated `{{ }}`.
 */
import type { CSSProperties } from "react";

const cache = new Map<string, CSSProperties>();

function camel(prop: string): string {
  const key = prop.trim();
  // Custom properties keep their name; everything else is camelCased.
  if (key.startsWith("--")) return key;
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Parse `"k:v;k:v"` into a React style object, preserving values verbatim. */
export function s(css: string): CSSProperties {
  const hit = cache.get(css);
  if (hit !== undefined) return hit;
  const out: Record<string, string | number> = {};
  for (const decl of css.split(";")) {
    const at = decl.indexOf(":");
    if (at === -1) continue;
    const prop = decl.slice(0, at).trim();
    const value = decl.slice(at + 1).trim();
    if (prop === "" || value === "") continue;
    out[camel(prop)] = value;
  }
  const style = out as CSSProperties;
  cache.set(css, style);
  return style;
}
