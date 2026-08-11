/*
 * Motion primitives for the app, ported from the design.
 *
 * The design lazy-imported `motion` from a CDN and stored it on `this.m`. Here it
 * is a static import of the installed `motion` package, exposed as `mo` with the
 * same `animate`/`stagger` shape the ported methods call. Everything else about
 * the choreography (the FLIP height/position morph, the routes-panel
 * detach/merge, the figure roll, the quote sweep, the water animation) lives as
 * methods on the component, unchanged from the design.
 */
import { animate, stagger } from "motion";

export const mo = { animate, stagger };

/** One duration and one curve for every transition, as the design fixes them. */
export const DUR = 0.34;
export const EASE = [0.2, 0, 0, 1] as const;

interface Box {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly left: number;
}

/*
 * A rect in layout pixels, not device pixels.
 *
 * The page can be zoomed, so a measured rect comes back scaled while the styles
 * written back are in layout px. The ratio of painted width to layout width is
 * the zoom, so dividing by it converts every measurement back. Ported verbatim
 * from the design's `box`.
 */
export function box(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const s = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
  return { height: r.height / s, width: r.width / s, x: r.left / s, left: r.left / s };
}
