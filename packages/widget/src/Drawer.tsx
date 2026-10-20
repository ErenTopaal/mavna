import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * The drawer chrome: an optional trigger, and the lightbox the card floats into.
 * Presentational, so `MavnaWidget` owns the open/closing state and the timing;
 * this just renders the current state and reports the three ways a person
 * dismisses it (the dimmed backdrop, the close button, or Escape).
 *
 * The opened state is a modal, not a page takeover: the page behind stays visible
 * but dimmed and blurred, and the one compact card floats centred over it with its
 * own shadow. That keeps a reader in the docs they embedded the button into, rather
 * than replacing the page with a near-empty white sheet.
 *
 * The overlay is portalled to `document.body` so no host `transform`, `filter` or
 * container query can trap a fixed element or clip the card. It carries its own
 * `.mv-root`, so the tokens and theme apply inside the portal exactly as they do
 * inline.
 */
export interface DrawerChromeProps {
  readonly mounted: boolean;
  readonly closing: boolean;
  readonly showTrigger: boolean;
  readonly triggerLabel: string;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly themeAttr: "light" | "dark" | undefined;
  readonly themeStyle: CSSProperties;
  readonly children: ReactNode;
}

/**
 * Whether a key closes the drawer: Escape, pressed inside it. The wallet kit's
 * picker is appended to the page outside the drawer, and an Escape that
 * dismisses the picker must not take the drawer, and the transfer, with it.
 */
export function dismissesOnKey(
  e: { readonly key: string; readonly target: unknown },
  overlay: { contains(node: never): boolean } | null,
): boolean {
  return e.key === "Escape" && overlay !== null && overlay.contains(e.target as never);
}

/**
 * Where Tab should move focus to keep it inside the dialog, or undefined to let
 * it move on its own: past the last element it wraps to the first, before the
 * first to the last, and focus found outside comes back in.
 */
export function nextFocus<T>(
  focusables: readonly T[],
  current: unknown,
  back: boolean,
): T | undefined {
  const first = focusables[0];
  const last = focusables.at(-1);
  if (first === undefined || last === undefined) return undefined;
  if (!focusables.includes(current as T)) return back ? last : first;
  if (!back && current === last) return first;
  if (back && current === first) return last;
  return undefined;
}

/**
 * What a host's `open` prop asks of the drawer now. A close waits while the
 * user's wallet is mid-prompt, and is taken up once it is not, so the drawer
 * never stays open against the prop.
 */
export function hostWants(state: {
  readonly open: boolean | undefined;
  readonly mounted: boolean;
  readonly closing: boolean;
  readonly waitingOnUser: boolean;
}): "open" | "close" | "none" {
  if (state.open === undefined) return "none";
  if (state.open) return state.mounted && !state.closing ? "none" : "open";
  if (!state.mounted || state.closing || state.waitingOnUser) return "none";
  return "close";
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function DrawerChrome(props: DrawerChromeProps): ReactNode {
  const { mounted, closing, showTrigger, onOpen, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // read through a ref, so a host passing a new callback each render does not
  // re-run the open effect and pull focus back to the dialog mid-typing
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!mounted) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent): void => {
      if (dismissesOnKey(e, overlayRef.current)) {
        closeRef.current();
        return;
      }
      const overlay = overlayRef.current;
      if (e.key !== "Tab" || overlay === null) return;
      const focusables = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE));
      const to = nextFocus(focusables, document.activeElement, e.shiftKey);
      if (to !== undefined) {
        e.preventDefault();
        to.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // The page behind a modal must not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the dialog so Escape and the keyboard land here, and screen
    // readers announce it, rather than leaving focus back on the page trigger.
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      // back to whatever opened it, so keyboard users are not left at the top of the page
      opener?.focus();
    };
  }, [mounted]);

  return (
    <>
      {showTrigger ? (
        <div className="mv-root" data-mv-theme={props.themeAttr} style={props.themeStyle}>
          <button type="button" className="mv-launch" onClick={onOpen}>
            {props.triggerLabel}
          </button>
        </div>
      ) : null}
      {mounted
        ? createPortal(
            <div
              ref={overlayRef}
              className="mv-root mv-overlay"
              data-mv-theme={props.themeAttr}
              data-mv-closing={closing ? "true" : undefined}
              style={props.themeStyle}
            >
              <button
                type="button"
                className="mv-overlay-scrim"
                aria-label="Close"
                onClick={onClose}
              />
              <button
                type="button"
                className="mv-overlay-close"
                aria-label="Close"
                onClick={onClose}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <div
                className="mv-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Bring funds to Stellar"
                tabIndex={-1}
                ref={dialogRef}
              >
                {props.children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
