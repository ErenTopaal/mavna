import type { ReactElement, ReactNode } from "react";

/*
 * Sidebar icons.
 *
 * One monochrome line vocabulary, drawn on a 24 unit grid at 1.7 stroke and
 * rendered at 16px in currentColor, so an icon carries the same weight as the
 * label beside it and inherits the active/hover colour without its own rule. The
 * set stays achromatic on purpose: colour on this site belongs to the product.
 */
const PATHS: Record<string, ReactNode> = {
  "guide-start": (
    <>
      <path d="M5 21V4" />
      <path d="M5 4.5h11l-2 3 2 3H5" />
    </>
  ),
  send: (
    <>
      <path d="M7 17 17 7" />
      <path d="M8.5 7H17v8.5" />
    </>
  ),
  receive: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 11 4.5 4.5L16.5 11" />
      <path d="M5 20h14" />
    </>
  ),
  "new-account": (
    <>
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4.5 19.5a5.5 5.5 0 0 1 9-4.3" />
      <path d="M17 13.5v6" />
      <path d="M20 16.5h-6" />
    </>
  ),
  track: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  finish: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.4 2.4L15.5 9.5" />
    </>
  ),
  wallets: (
    <>
      <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h11.5" />
      <rect x="3.5" y="8.5" width="17" height="10.5" rx="2.2" />
      <circle cx="16" cy="14" r="1.2" />
    </>
  ),
  costs: (
    <>
      <path d="M4 4.5h6.5L20 14l-6.5 6.5L4 11V4.5Z" />
      <circle cx="8" cy="8" r="1.2" />
    </>
  ),
  overview: (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8l8.5-4.5Z" />
      <path d="m3.5 13 8.5 4.5L20.5 13" />
    </>
  ),
  install: (
    <>
      <path d="M12 3.5v9.5" />
      <path d="m8 9.5 4 4 4-4" />
      <rect x="4" y="17" width="16" height="3.2" rx="1.4" />
    </>
  ),
  bolt: <path d="M13.5 3 5.5 13.5H11l-1.5 7.5 8-10.5H12l1.5-7.5Z" />,
  concepts: (
    <>
      <path d="M9.5 18.5h5" />
      <path d="M10.5 21h3" />
      <path d="M12 3.5A5.5 5.5 0 0 0 8.3 13c.8.8 1.2 1.3 1.2 2.5h5c0-1.2.4-1.7 1.2-2.5A5.5 5.5 0 0 0 12 3.5Z" />
    </>
  ),
  rails: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="8.5" r="2" />
      <path d="M7 8v8" />
      <path d="M17 10.5v.5a4 4 0 0 1-4 4H7" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" />
      <path d="M6.5 7.5h.01" />
      <path d="M6.5 16.5h.01" />
    </>
  ),
  braces: (
    <>
      <path d="M8.5 4.5C6.8 4.5 6 5.3 6 7v1.8c0 1.1-.7 1.9-2 1.9 1.3 0 2 .8 2 1.9V15c0 1.7.8 2.5 2.5 2.5" />
      <path d="M15.5 4.5C17.2 4.5 18 5.3 18 7v1.8c0 1.1.7 1.9 2 1.9-1.3 0-2 .8-2 1.9V15c0 1.7-.8 2.5-2.5 2.5" />
    </>
  ),
  shield: (
    <path d="M12 3.5 5.5 6v5c0 4.3 2.9 7.2 6.5 8.5 3.6-1.3 6.5-4.2 6.5-8.5V6L12 3.5Z" />
  ),
  model: (
    <>
      <circle cx="9.5" cy="9.5" r="5.5" />
      <path d="M14.8 6.2a5.5 5.5 0 1 1-.6 10.8" />
    </>
  ),
  trust: (
    <>
      <path d="M12 3.5 5.5 6v5c0 4.3 2.9 7.2 6.5 8.5 3.6-1.3 6.5-4.2 6.5-8.5V6L12 3.5Z" />
      <path d="m9.2 11 2.1 2.1L15 9.3" />
    </>
  ),
  signing: (
    <>
      <path d="M4 20s2.8-.8 4.5-2.5l9-9a2.1 2.1 0 0 0-3-3l-9 9C3.8 16.2 4 20 4 20Z" />
      <path d="m14 6 3 3" />
    </>
  ),
  sponsorship: (
    <>
      <rect x="4" y="8.5" width="16" height="4" rx="1" />
      <path d="M5.2 12.5v7h13.6v-7" />
      <path d="M12 8.5v11" />
      <path d="M12 8.5C10.5 8.5 9 8 9 6.7 9 5.9 9.8 5.6 10.5 6c1 .7 1.5 1.6 1.5 2.5Z" />
      <path d="M12 8.5c1.5 0 3-.5 3-1.8 0-.8-.8-1.1-1.5-.7-1 .7-1.5 1.6-1.5 2.5Z" />
    </>
  ),
  delivery: (
    <>
      <path d="M3.5 6.5h9v9h-9z" />
      <path d="M12.5 9.5H17l3 3v3h-7.5" />
      <circle cx="7" cy="17.5" r="1.7" />
      <circle cx="16.5" cy="17.5" r="1.7" />
    </>
  ),
  status: <path d="M3 12h4l2.5 7 5-14L17 12h4" />,
  swap: (
    <>
      <path d="M7.5 4v13" />
      <path d="m4.5 7 3-3 3 3" />
      <path d="M16.5 20V7" />
      <path d="m13.5 17 3 3 3-3" />
    </>
  ),
  circle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  hexagon: <path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" />,
  layerzero: (
    <>
      <path d="m12 3.5 8.5 15h-17l8.5-15Z" />
      <path d="m12 10 4.7 8.5H7.3L12 10Z" />
    </>
  ),
  api: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m7.5 10 2.3 2-2.3 2" />
      <path d="M12.5 14h4" />
    </>
  ),
  packages: (
    <>
      <path d="m12 3.5 8 4.4v8.2L12 20.5 4 16.1V7.9l8-4.4Z" />
      <path d="M4 8l8 4.4L20 8" />
      <path d="M12 12.4v8" />
    </>
  ),
  types: (
    <>
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </>
  ),
  adapter: (
    <>
      <path d="M9 3.5v4" />
      <path d="M15 3.5v4" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0v-3Z" />
      <path d="M12 16v4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <circle cx="12" cy="15" r="1.1" />
    </>
  ),
  bug: (
    <>
      <rect x="8" y="8" width="8" height="9" rx="4" />
      <path d="M9 8a3 3 0 0 1 6 0" />
      <path d="M5 11h3M16 11h3M4.5 15.5h3.5M16 15.5h3.5M12 8v9" />
    </>
  ),
  integrators: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </>
  ),
  config: (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  variants: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17" />
      <path d="M9 9.5v10" />
    </>
  ),
  theming: <path d="M12 3.5c3.5 3.8 6 6.9 6 10a6 6 0 0 1-12 0c0-3.1 2.5-6.2 6-10Z" />,
  playground: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.2 8.5 15 12l-4.8 3.5v-7Z" />
    </>
  ),
};

/** A sidebar title: an icon and its label, side by side. */
export function nav(icon: string, label: string): ReactElement {
  return (
    <span className="mv-nav">
      <svg
        className="mv-nav-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {PATHS[icon]}
      </svg>
      <span className="mv-nav-label">{label}</span>
    </span>
  );
}
