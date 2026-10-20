import type { NetworkId } from "@mavna/core";
import {
  type CSSProperties,
  type ForwardRefExoticComponent,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { type MavnaWidgetConfig, resolveConfig } from "./config.js";
import { DrawerChrome, hostWants } from "./Drawer.js";
import { createEngine } from "./engine.js";
import { engineKeyOf } from "./engine-key.js";
import { Flow } from "./flow.js";
import "./widget.css";

/**
 * The Mavna widget: one self-contained component that quotes, routes and (by
 * default) manages wallets itself, configured by a single object.
 *
 * It builds its own engine from the config and renders the whole flow inside a
 * scoped `.mv-root`. The `wide` variant is the full-page layout the Mavna app
 * uses; the `drawer` variant rises from the bottom to a full-page popup, opened by
 * its own trigger, by the `open` prop, or by the imperative handle on the ref.
 *
 * The engine is memoised on the config values that actually change it, so a stable
 * config keeps one engine (and one wallet session) for the widget's life.
 */
export interface MavnaWidgetProps {
  readonly config: MavnaWidgetConfig;
  /** Drawer only: drive the open state from the host instead of the trigger. */
  readonly open?: boolean;
  /** Drawer only: called once the close animation has finished. */
  readonly onClose?: () => void;
}

export interface MavnaWidgetRef {
  openDrawer(): void;
  closeDrawer(): void;
  toggleDrawer(): void;
  isOpen(): boolean;
}

// Matches the sheet's close animation in widget.css (--mv-slow), so the overlay
// leaves the DOM only after it has finished sliding out.
const CLOSE_MS = 420;

export const MavnaWidget: ForwardRefExoticComponent<
  MavnaWidgetProps & RefAttributes<MavnaWidgetRef>
> = forwardRef<MavnaWidgetRef, MavnaWidgetProps>(function MavnaWidget(
  { config, open, onClose },
  ref,
): ReactElement {
  // The network the user switched to, if any. A host that changes the
  // configured network starts the widget over on that one.
  const [active, setActive] = useState<NetworkId | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new configured network resets the choice.
  useEffect(() => setActive(undefined), [config.network]);
  const resolved = useMemo(() => resolveConfig(config, active), [config, active]);
  const ec = resolved.engineConfig;
  const engineKey = engineKeyOf(ec);
  // A running transfer keeps the engine and the flow it started with: a config
  // change rebuilds both only once it has ended, never under it.
  const running = useRef(false);
  const [, setEnded] = useState(0);
  const held = useRef<{ key: string; engine: ReturnType<typeof createEngine> } | null>(null);
  if (held.current === null || (held.current.key !== engineKey && !running.current)) {
    held.current = { key: engineKey, engine: createEngine(ec) };
  }
  const { engine, key: flowKey } = held.current;

  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);

  const doOpen = useCallback(() => {
    setClosing(false);
    setMounted(true);
  }, []);
  // Closing is refused only while the user's wallet is mid-prompt. At any other
  // point the flight says closing is safe, and it is: the flow stops watching,
  // the transfer ends as still moving, and Activity finishes it.
  const [waitingOnUser, setWaitingOnUser] = useState(false);
  const doClose = useCallback(() => {
    if (waitingOnUser) return;
    setClosing(true);
    window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      onClose?.();
    }, CLOSE_MS);
  }, [onClose, waitingOnUser]);

  // When a host drives `open`, mirror it into the same open/close transitions the
  // trigger and the ref use, so the animation runs either way.
  useEffect(() => {
    const wants = hostWants({ open, mounted, closing, waitingOnUser });
    if (wants === "open") doOpen();
    else if (wants === "close") doClose();
  }, [open, mounted, closing, waitingOnUser, doOpen, doClose]);

  useImperativeHandle(
    ref,
    () => ({
      openDrawer: doOpen,
      closeDrawer: doClose,
      toggleDrawer: () => (mounted && !closing ? doClose() : doOpen()),
      isOpen: () => mounted && !closing,
    }),
    [doOpen, doClose, mounted, closing],
  );

  const themeAttr = resolved.appearance === "system" ? undefined : resolved.appearance;
  const t = resolved.theme;
  // Token overrides first, then the named ones, applied as CSS variables on the
  // root so they cascade into everything the flow renders.
  const style: Record<string, string> = { ...t?.tokens };
  if (t?.font !== undefined) style["--mv-font"] = t.font;
  if (t?.fontMono !== undefined) style["--mv-font-mono"] = t.fontMono;
  if (t?.radius !== undefined) style["--mv-radius"] = t.radius;
  if (t?.radiusLg !== undefined) style["--mv-radius-lg"] = t.radiusLg;
  const themeStyle = style as CSSProperties;

  const flowProps = {
    engine,
    init: {
      chainId: resolved.init.fromChain,
      wanted: resolved.init.wanted,
      amount: resolved.init.fromAmount,
      destination: resolved.init.toAddress,
      send: resolved.init.fromAsset,
    },
    rails: resolved.rails,
    hiddenUI: resolved.hiddenUI,
    requiredUI: resolved.requiredUI,
    menuLinks: resolved.menuLinks,
    walletConfig: resolved.walletConfig,
    emit: resolved.onEvent,
    networks: resolved.networks,
    onNetworkChange: setActive,
    onAwaitingUser: setWaitingOnUser,
    onTransferChange: (now: boolean) => {
      running.current = now;
      // pick up any config change that waited for the transfer
      if (!now) setEnded((n) => n + 1);
    },
  } as const;

  if (resolved.variant === "drawer") {
    return (
      <DrawerChrome
        mounted={mounted}
        closing={closing}
        showTrigger={open === undefined}
        triggerLabel="Bring funds to Stellar"
        onOpen={doOpen}
        onClose={doClose}
        themeAttr={themeAttr}
        themeStyle={themeStyle}
      >
        <Flow key={flowKey} {...flowProps} variant="compact" />
      </DrawerChrome>
    );
  }

  return (
    <div className="mv-root" data-mv-theme={themeAttr} style={themeStyle}>
      <Flow
        key={flowKey}
        {...flowProps}
        variant={resolved.variant === "compact" ? "compact" : "wide"}
      />
    </div>
  );
});
