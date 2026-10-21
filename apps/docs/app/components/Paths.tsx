import Link from "fumadocs-core/link";
import type { ReactElement } from "react";

/*
 * The ways into the docs, each drawn at the depth it reaches: the draft scale
 * fills further the deeper a section goes into the system, from sending money
 * with the app down to how the rails prove delivery.
 */
const PATHS = [
  {
    href: "/send",
    title: "Send funds",
    text: "Move USDC or USDT0 to a Stellar address with the Mavna app.",
    depth: 1,
  },
  {
    href: "/widget",
    title: "Embed the widget",
    text: "Put the whole transfer flow in your React app as one component.",
    depth: 2,
  },
  {
    href: "/sdk",
    title: "Build with the SDK",
    text: "Quote routes, build unsigned transactions and track transfers in your own interface.",
    depth: 3,
  },
  {
    href: "/operate",
    title: "Run Mavna",
    text: "Run the sponsor service and the pages yourself, locally or in production.",
    depth: 3,
  },
  {
    href: "/how-it-works",
    title: "How it works",
    text: "The rails, the trust each one asks for, sponsorship, delivery proofs and security.",
    depth: 4,
  },
] as const;

export function Paths(): ReactElement {
  return (
    <ul className="mv-paths">
      {PATHS.map((path) => (
        <li key={path.href}>
          <Link className="mv-path" href={path.href}>
            <span className="mv-depth" aria-hidden="true">
              {[1, 2, 3, 4].map((bar) => (
                <span key={bar} data-on={bar <= path.depth ? "" : undefined} />
              ))}
            </span>
            <span>
              <span className="mv-path-title">{path.title}</span>
              <span className="mv-path-text">{path.text}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
