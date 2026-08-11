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

export function DrawerChrome(props: DrawerChromeProps): ReactNode {
  const { mounted, closing, showTrigger, onOpen, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
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
    };
  }, [mounted, onClose]);

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
