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
import { DrawerChrome } from "./Drawer.js";
import { createEngine } from "./engine.js";
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
  const engineKey = [
    ec.network,
    ec.rpcUrl,
    ec.sponsorUrl,
    ec.disabledSources ?? "",
    ec.ranking,
    ec.integratorFee ? `${ec.integratorFee.bps}:${ec.integratorFee.recipient}` : "",
    ec.arrivalContract ?? "",
  ].join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: engineKey captures every field of ec that changes the engine.
  const engine = useMemo(() => createEngine(ec), [engineKey]);

  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);

  const doOpen = useCallback(() => {
    setClosing(false);
    setMounted(true);
  }, []);
  // A running transfer still asks for signatures and still offers a conversion,
  // and an unmounted flow could do neither visibly, so the drawer stays open
  // until it has ended.
  const running = useRef(false);
  const doClose = useCallback(() => {
    if (running.current) return;
    setClosing(true);
    window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      onClose?.();
    }, CLOSE_MS);
  }, [onClose]);

  // When a host drives `open`, mirror it into the same open/close transitions the
  // trigger and the ref use, so the animation runs either way.
  useEffect(() => {
    if (open === undefined) return;
    if (open) doOpen();
    else if (mounted && !closing) doClose();
  }, [open, mounted, closing, doOpen, doClose]);

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
  const style: Record<string, string> = { ...(t?.tokens ?? {}) };
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
    onTransferChange: (now: boolean) => {
      running.current = now;
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
        <Flow key={engine.network} {...flowProps} variant="compact" />
      </DrawerChrome>
    );
  }

  return (
    <div className="mv-root" data-mv-theme={themeAttr} style={themeStyle}>
      <Flow
        key={engine.network}
        {...flowProps}
        variant={resolved.variant === "compact" ? "compact" : "wide"}
      />
    </div>
  );
});
