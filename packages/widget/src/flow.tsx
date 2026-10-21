/*
 * The widget's flow: the whole transfer interface, ported 1:1 from the design
 * (resources/mavna_design.zip → Mavna App v2.dc.html) and driven by the real
 * engine. This is what the Mavna app renders, and what any integrator embeds.
 *
 * The design's structure, screens, inline styles and motion choreography are kept
 * verbatim. What is replaced is every demo internal: the fake route builder, the
 * fake XLM rate and balance, the setTimeout step simulation, the fake wallet and
 * the seeded history. Those come from the `Engine` passed in as a prop. Colours
 * are `--mv-*` tokens so a host can retheme; styles are pasted through `s(...)`;
 * hover/active/focus go through `pseudo(...)`; the FLIP and panel choreography are
 * the design's own methods, unchanged.
 */
import { ERC20_ABI } from "@mavna/adapter-cctp";
import { escalateIfOverdue, parseLookupKey, toHandle } from "@mavna/status";
import { stroopsToXlm } from "@mavna/stellar";
import React, { type ReactNode } from "react";
import type { Address } from "viem";
import type {
  HiddenUIElement,
  MavnaMenuLink,
  MavnaWidgetEvent,
  RequiredUIElement,
  WalletConfig,
} from "./config";
import type { Engine, SourceDetail } from "./engine";
import { fromBaseUnits, toBaseUnits } from "./format";
import { type FoundState, foundFor } from "./found";
import { msg, shortAddr } from "./helpers";
import { forgetHistory, readHistory, type TransferRecord } from "./history";
import { MAVNA_MARK_PATH, MAVNA_MARK_VIEWBOX } from "./mark";
import { box, DUR, EASE, mo } from "./motion";
import { type FinishAnswer, finishCompose } from "./own-compose";
import { pseudo } from "./pseudo";
import {
  type Priority,
  type QuoteRun,
  type RailName,
  type RouteRejection,
  type RouteSet,
  type RouteView,
  railDisplay,
  runQuote as realQuote,
  type SendAsset,
  toRouteView,
  type Wanted,
} from "./quote";
import { lookupAcross } from "./rails";
import {
  onPrimary,
  onPrimaryCompact,
  primaryLabel,
  renderActivity,
  renderAddress,
  renderChains,
  renderFlight,
  renderNetworkToggle,
  renderPriority,
  renderRails,
  renderReview,
  renderRoutes,
  renderSend,
  renderSettings,
} from "./screens";
import { s } from "./style";
import {
  buildSteps,
  burnDomain,
  DeliveredAsCame,
  DeliveredUnverified,
  type FlightRow,
  type FlightStep,
  finishDelivery,
  runTransfer,
  StillMoving,
  tooCostly,
} from "./transfer";
import { connect, type DiscoveredWallet, switchChain, watchWallets } from "./wallet";

type Screen =
  | "send"
  | "chains"
  | "priority"
  | "address"
  | "settings"
  | "rails"
  | "routes"
  | "review"
  | "flight"
  | "activity";

interface WalletInfo {
  readonly connection: Awaited<ReturnType<typeof connect>>;
  readonly name: string;
  /** The wallet's own icon, a data URI announced over EIP-6963. */
  readonly icon: string;
  readonly short: string;
}

interface State {
  screen: Screen;
  cameFrom: Screen | null;
  dir: "push" | "pop";
  chainId: string;
  /** What the user is sending. The chain list and the receive side follow it. */
  send: SendAsset;
  wanted: Wanted;
  amount: string;
  destination: string;
  routes: RouteView[];
  rejected: RouteRejection[];
  complete: boolean;
  selected: string | null;
  picked: boolean;
  quoting: boolean;
  routesMounted: boolean;
  priority: Priority;
  rails: Record<RailName, boolean>;
  showDeclined: boolean;
  /** "ended": the transfer stopped without arriving (failed, still moving, unproven). */
  phase: "quote" | "sending" | "arrived" | "ended";
  steps: FlightStep[];
  chainQuery: string;
  expanded: string | null;
  wallet: WalletInfo | null;
  walletOpen: boolean;
  menuOpen: boolean;
  balance: number | null;
  discovered: DiscoveredWallet[];
  /** The network the engine runs on. Switching rebuilds the engine and this flow. */
  network: "testnet" | "mainnet";
  /**
   * Who pays a new account's reserve, as the sponsor said at the last quote.
   * Undefined until it has answered; a route that sets an account up is only
   * offered once it has.
   */
  reserveFunding: "sponsor" | "self" | undefined;
  /** The connected Stellar address, once the wallet kit has returned one. */
  stellarAddress: string | null;
  /** The uuid of a wallet mid-connect, or "stellar" for the kit, else null. */
  connecting: string | null;
  walletError: string | null;
  note: string | null;
  noteKind: "quiet" | "fault";
  lookup: string;
  lookupNote: string | null;
  lookupNoteKind: "quiet" | "fault";
  found: FoundState | null;
  finishTries: number;
  history: readonly TransferRecord[];
  /** What arrived when a transfer landed unconverted, for the flight's headline. */
  arrivedAs: { readonly amount: number; readonly symbol: string } | null;
  /** The route the flight is for. The form's own routes are gone once it ends. */
  flying: RouteView | null;
  /** A new send repeats one that may still arrive; it waits for an explicit yes. */
  askAgain: boolean;
}

export interface FlowProps {
  /* The SDK, sponsor and Stellar wallet, assembled from the widget's config. The
     flow reads it through a getter so the initial state can pull its defaults. */
  readonly engine: Engine;
  /* "wide" is the app's two-panel page; "compact" is the one card the widget
     embeds and the drawer opens. Defaults to wide. */
  readonly variant?: "wide" | "compact";
  /** Form initial values, from config. */
  readonly init?: {
    readonly chainId?: string | undefined;
    readonly wanted?: Wanted | undefined;
    readonly send?: SendAsset | undefined;
    readonly amount?: string | undefined;
    readonly destination?: string | undefined;
  };
  /** The rails on offer, from config. Defaults to all four. */
  readonly rails?: readonly RailName[];
  readonly hiddenUI?: readonly HiddenUIElement[];
  readonly requiredUI?: readonly RequiredUIElement[];
  /** Links for the header overflow menu, from config. Empty hides it. */
  readonly menuLinks?: readonly MavnaMenuLink[];
  /** Opt out of internal wallet management with host-provided signers. */
  readonly walletConfig?: WalletConfig | undefined;
  /** Report flow events back to the host. */
  readonly emit?: ((event: MavnaWidgetEvent) => void) | undefined;
  /** The networks the toggle offers. Defaults to the engine's own only. */
  readonly networks?: readonly ("testnet" | "mainnet")[];
  /** Asked to switch network; the host rebuilds the engine for it. */
  readonly onNetworkChange?: ((network: "testnet" | "mainnet") => void) | undefined;
  /** Told when a transfer starts running and when it has ended, so the host keeps it mounted. */
  readonly onTransferChange?: ((running: boolean) => void) | undefined;
  /**
   * Told when a step starts and stops waiting on the user's wallet. Only then is
   * closing unsafe: a prompt would be left open with nothing behind it. Any other
   * time the page can go, the transfer ending as still moving, finished under Activity.
   */
  readonly onAwaitingUser?: ((waiting: boolean) => void) | undefined;
}

/**
 * How long after a transfer that may still arrive a repeat of it is asked about:
 * the hour a relayed rail is watched for.
 */
const SEND_AGAIN_WINDOW_MS = 60 * 60_000;

/** What is sent, by asset and base units, for telling a repeat apart. */
function sendsKey(view: RouteView): string {
  return `${view.route.sends.asset.id}:${view.route.sends.baseUnits}`;
}

const ALL_RAILS: readonly RailName[] = ["Circle", "Axelar", "LayerZero", "NEAR Intents"];

export class Flow extends React.Component<FlowProps, State> {
  get engine(): Engine {
    return this.props.engine;
  }

  /** The rails on offer, from config. */
  availableRails(): readonly RailName[] {
    return this.props.rails ?? ALL_RAILS;
  }
  hidden(el: HiddenUIElement): boolean {
    return this.props.hiddenUI?.includes(el) ?? false;
  }
  required(el: RequiredUIElement): boolean {
    return this.props.requiredUI?.includes(el) ?? false;
  }
  menuLinks(): readonly MavnaMenuLink[] {
    return this.props.menuLinks ?? [];
  }
  /** Report an event to the host, if it is listening. */
  emit(event: MavnaWidgetEvent): void {
    this.props.emit?.(event);
  }

  override state: State = {
    screen: "send",
    cameFrom: null,
    dir: "push",
    chainId: this.props.init?.chainId ?? this.engine.defaultSourceChain,
    send: this.props.init?.send ?? "USDC",
    // a USDT0 send lands as USDT0 unless the config asks for USDC or XLM from it
    wanted: this.props.init?.wanted ?? (this.props.init?.send === "USDT0" ? "USDT0" : "USDC"),
    amount: this.props.init?.amount ?? "",
    destination: this.props.init?.destination ?? "",
    routes: [],
    rejected: [],
    complete: false,
    selected: null,
    picked: false,
    quoting: false,
    routesMounted: true,
    // From config.routePriority via the engine; the user can still toggle it.
    priority: this.engine.ranking === "fastest" ? "fast" : "best",
    // On by default, but only the rails config offers.
    rails: {
      Circle: (this.props.rails ?? ALL_RAILS).includes("Circle"),
      Axelar: (this.props.rails ?? ALL_RAILS).includes("Axelar"),
      LayerZero: (this.props.rails ?? ALL_RAILS).includes("LayerZero"),
      "NEAR Intents": (this.props.rails ?? ALL_RAILS).includes("NEAR Intents"),
    },
    showDeclined: true,
    phase: "quote",
    steps: [],
    chainQuery: "",
    expanded: null,
    // A host can inject an already-connected EVM wallet; otherwise none yet.
    wallet: ((): WalletInfo | null => {
      const evm = this.props.walletConfig?.evm;
      return evm === null || evm === undefined
        ? null
        : {
            connection: evm,
            name: evm.info.name,
            icon: evm.info.icon,
            short: shortAddr(evm.address),
          };
    })(),
    walletOpen: false,
    menuOpen: false,
    balance: null,
    discovered: [],
    network: this.engine.network,
    reserveFunding: undefined,
    stellarAddress: null,
    connecting: null,
    walletError: null,
    note: null,
    noteKind: "quiet",
    lookup: "",
    lookupNote: null,
    lookupNoteKind: "quiet",
    found: null,
    finishTries: 0,
    history: [],
    arrivedAs: null,
    flying: null,
    askAgain: false,
  };

  /** The widget's own outermost element; nothing outside it is the widget's to touch. */
  rootRef = React.createRef<HTMLDivElement>();
  rowRef = React.createRef<HTMLDivElement>();
  cardRef = React.createRef<HTMLDivElement>();
  bodyRef = React.createRef<HTMLDivElement>();
  paneRef = React.createRef<HTMLDivElement>();
  figureRef = React.createRef<HTMLSpanElement>();
  sweepRef = React.createRef<HTMLDivElement>();
  pivotRef = React.createRef<HTMLDivElement>();
  stepRef = React.createRef<HTMLDivElement>();
  routesRef = React.createRef<HTMLDivElement>();
  walletPopRef = React.createRef<HTMLDivElement>();
  menuPopRef = React.createRef<HTMLDivElement>();
  destRef = React.createRef<HTMLInputElement>();

  rows: (HTMLElement | null)[] = [];
  timers: ReturnType<typeof setTimeout>[] = [];
  m = mo;
  reduced = false;
  DUR = DUR;
  EASE = EASE;

  private currentQuote: QuoteRun | undefined;
  /** True from the press that starts a transfer until that transfer has ended. */
  private transferring = false;
  /**
   * Aborted on unmount so a relayed delivery stops being polled for a page that
   * is gone. Replaced on mount, because a remount reuses the instance.
   */
  private unmounted = new AbortController();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWallets: (() => void) | undefined;
  private lastFigure: string | undefined;
  private cardDx: number | undefined;
  private morphAnims: { stop: () => void }[] | undefined;
  private morphSeq: Record<string, number> | undefined;
  private lastNext: Record<string, ReturnType<typeof box>> | undefined;
  private onDown = (_e: MouseEvent): void => {};
  private onKey = (_e: KeyboardEvent): void => {};

  // ---------------------------------------------------------------- helpers ---

  list(): ReadonlyArray<{ id: string; name: string }> {
    return this.state.send === "USDT0" ? this.engine.usdt0Chains : this.engine.sourceChains;
  }
  /** Whether USDT0 can be offered at all: only LayerZero carries it. */
  usdt0Offered(): boolean {
    return this.engine.adapters.some((a) => a.id === "layerzero");
  }
  /**
   * Switch what is being sent. The chain stays when the new asset can leave from
   * it, and otherwise moves to the first chain that can, so the form never sits
   * on a chain the picker would not offer.
   */
  setSend(send: SendAsset): void {
    if (send === this.state.send) return;
    const chains = send === "USDT0" ? this.engine.usdt0Chains : this.engine.sourceChains;
    const preferred = this.engine.network === "mainnet" ? "ethereum" : "ethereum-sepolia";
    const chainId = chains.some((c) => c.id === this.state.chainId)
      ? this.state.chainId
      : chains.some((c) => c.id === preferred)
        ? preferred
        : (chains[0]?.id ?? "");
    this.setState(
      {
        send,
        chainId,
        // each send lands as itself by default; a choice of XLM holds across both
        wanted: this.state.wanted === "XLM" ? "XLM" : send,
        balance: null,
      },
      () => {
        this.runQuote();
        void this.refreshBalance({ align: true });
      },
    );
  }
  chain(): { id: string; name: string } {
    return (
      this.list().find((c) => c.id === this.state.chainId) ?? this.list()[0] ?? { id: "", name: "" }
    );
  }
  amountNumber(): number {
    const n = Number.parseFloat(String(this.state.amount).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  chosen(): RouteView | undefined {
    return this.state.routes.find((x) => x.id === this.state.selected) ?? this.state.routes[0];
  }
  /**
   * What the routes panel waits on before any rail is asked, in the order the
   * quote needs them. Undefined once both are there.
   */
  resting(): "amount" | "recipient" | undefined {
    if (this.amountNumber() <= 0) return "amount";
    if (this.state.destination.trim() === "") return "recipient";
    return undefined;
  }
  destValid(): boolean {
    return /^G[A-Z2-7]{55}$/.test(this.state.destination.trim());
  }
  sym(): string {
    return this.state.wanted;
  }

  // ------------------------------------------------------------- lifecycle ---

  override componentDidMount(): void {
    this.unmounted = new AbortController();
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.onDown = (e) => {
      if (
        this.state.walletOpen &&
        this.walletPopRef.current !== null &&
        !this.walletPopRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest("[aria-expanded]")
      )
        this.closeWallet();
      if (
        this.state.menuOpen &&
        this.menuPopRef.current !== null &&
        !this.menuPopRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest("[aria-expanded]")
      )
        this.setState({ menuOpen: false });
    };
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener("mousedown", this.onDown);
    document.addEventListener("keydown", this.onKey);
    this.stopWallets = watchWallets((wallets) => this.setState({ discovered: [...wallets] }));
    this.setState({ history: readHistory(this.engine.historyKey) });
    this.followStellar();
    this.entrance();
    this.runQuote();
  }

  /** Escape closes a popover or goes back, but only when it was pressed in the widget. */
  handleKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (this.rootRef.current === null || !this.rootRef.current.contains(e.target as Node)) return;
    if (this.state.menuOpen) {
      this.setState({ menuOpen: false });
      return;
    }
    if (this.state.walletOpen) {
      this.closeWallet();
      return;
    }
    if (this.state.screen !== "send" && this.state.phase !== "sending") this.back();
  }

  private stopStellar: (() => void) | undefined;

  /** Keep the header's Stellar address to what the wallet says now, not what it said once. */
  followStellar(): void {
    this.stopStellar?.();
    this.stopStellar = this.engine.stellar.onChange?.((address) =>
      this.setState({ stellarAddress: address ?? null }),
    );
  }

  override componentWillUnmount(): void {
    this.unmounted.abort();
    this.stopStellar?.();
    document.removeEventListener("mousedown", this.onDown);
    document.removeEventListener("keydown", this.onKey);
    this.timers.forEach(clearTimeout);
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.currentQuote?.cancel();
    this.stopWallets?.();
  }

  override componentDidUpdate(_prev: FlowProps, prevState: State): void {
    const fig = this.figureRef.current;
    if (fig !== null && fig.textContent !== this.lastFigure) {
      const first = this.lastFigure === undefined;
      this.lastFigure = fig.textContent ?? "";
      if (!first) this.rollFigure();
    }
    if (prevState.walletOpen !== this.state.walletOpen && this.state.walletOpen)
      this.pop(this.walletPopRef.current);
    if (prevState.menuOpen !== this.state.menuOpen && this.state.menuOpen)
      this.pop(this.menuPopRef.current);
  }

  // ----------------------------------------------------------------- motion ---
  // Ported verbatim from the design's methods.

  anim(
    el: Element | Element[] | null,
    keys: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): { finished: Promise<unknown>; stop: () => void } | null {
    if (el === null || el === undefined || !this.m || this.reduced) return null;
    try {
      return this.m.animate(
        el as never,
        keys as never,
        Object.assign({ duration: this.DUR, ease: this.EASE }, opts ?? {}) as never,
      ) as never;
    } catch {
      Object.keys(keys).forEach((k) => {
        try {
          (el as HTMLElement).style[k as never] = "" as never;
        } catch {
          /* not a style key */
        }
      });
      return null;
    }
  }

  pop(node: HTMLElement | null): void {
    this.anim(node, { opacity: [0, 1], y: [-5, 0], scale: [0.985, 1] });
  }

  entrance(): void {
    if (!this.m || this.reduced) return;
    const root = this.rootRef.current;
    if (root === null) return;
    // the widget's own parts only: a host page's header is not ours to animate
    const nodes = Array.from(root.querySelectorAll("header, main > div, footer"));
    this.anim(
      nodes,
      { opacity: [0, 1], y: [12, 0] },
      { delay: this.m.stagger(0.07), duration: 0.55 },
    );
  }

  closeWallet(after?: { wallet: WalletInfo | null }): void {
    const node = this.walletPopRef.current;
    const finish = (): void => {
      const cap = this.lockHeight();
      this.setState(
        (prev) => ({
          ...prev,
          walletOpen: false,
          ...(after === undefined ? {} : { wallet: after.wallet, note: null }),
        }),
        () => this.animateHeight(cap),
      );
    };
    if (node === null || !this.m || this.reduced) {
      finish();
      return;
    }
    node.style.pointerEvents = "none";
    this.anim(node, { opacity: [1, 0], y: [0, -5], scale: [1, 0.985] });
    this.timers.push(setTimeout(finish, this.DUR * 1000));
  }

  detachPanel(): void {
    const node = this.routesRef.current;
    if (node === null) return;
    const row = node.parentElement;
    const rowBefore = row === null ? 0 : row.getBoundingClientRect().left;
    const x = node.offsetLeft;
    node.style.left = `${x}px`;
    node.style.top = `${node.offsetTop}px`;
    node.style.width = `${node.offsetWidth}px`;
    node.style.height = `${node.offsetHeight}px`;
    node.style.position = "absolute";
    node.style.pointerEvents = "none";
    node.style.zIndex = "0";
    if (row !== null) {
      const shift = rowBefore - row.getBoundingClientRect().left;
      if (Math.abs(shift) > 0.5) node.style.left = `${x + shift}px`;
    }
  }

  pace(dx: number): number {
    const ref = this.cardDx === undefined || this.cardDx < 40 ? 198 : this.cardDx;
    const ratio = Math.abs(dx) / ref;
    return this.DUR * Math.max(1, Math.min(2, ratio));
  }

  mergePanel(): void {
    const node = this.routesRef.current;
    const card = this.cardRef.current;
    if (node === null || card === null || node.style.position !== "absolute") return;
    if (!this.m || this.reduced) return;
    const landing =
      this.lastNext !== undefined && this.lastNext.card !== undefined
        ? this.lastNext.card
        : box(card);
    const from = box(node);
    const dx = landing.x - from.x;
    this.anim(node, { x: [0, dx] }, { duration: this.pace(dx) });
  }

  reattachPanel(node: HTMLElement): void {
    (
      [
        "position",
        "pointerEvents",
        "left",
        "top",
        "width",
        "height",
        "opacity",
        "transform",
        "zIndex",
      ] as const
    ).forEach((k) => {
      node.style[k as never] = "" as never;
    });
  }

  showRoutesPanel(fromCardX?: number | null): void {
    const node = this.routesRef.current;
    if (node === null || !this.m || this.reduced) return;
    node.style.opacity = "";
    node.style.transform = "";
    const here = box(node);
    const dx = fromCardX === null || fromCardX === undefined ? -24 : fromCardX - here.x;
    node.style.zIndex = "0";
    const run = this.anim(node, { x: [dx, 0] }, { duration: this.pace(dx) });
    const clear = (): void => {
      if (this.routesRef.current === node) node.style.zIndex = "";
    };
    if (run === null) clear();
    else run.finished.then(clear).catch(clear);
  }

  lockHeight(): Record<string, { x: number }> {
    if (this.morphAnims !== undefined)
      this.morphAnims.forEach((a) => {
        try {
          a.stop();
        } catch {
          /* already finished */
        }
      });
    this.morphAnims = [];
    const cap: Record<string, { x: number }> = {};
    (
      [
        ["card", this.cardRef.current],
        ["panel", this.routesRef.current],
      ] as const
    ).forEach((pair) => {
      const el = pair[1];
      if (el === null || el.style.position === "absolute") return;
      cap[pair[0]] = { x: box(el).left };
    });
    return cap;
  }

  animateHeight(cap: Record<string, { x: number }> | null | undefined): void {
    const panel = this.routesRef.current;
    const nodes: [string, HTMLElement | null][] = [
      ["card", this.cardRef.current],
      ["panel", panel !== null && panel.style.position === "absolute" ? null : panel],
    ];
    const settle = (el: HTMLElement | null): void => {
      if (el !== null) el.style.transform = "";
    };
    if (cap === null || cap === undefined) {
      nodes.forEach(([, el]) => {
        settle(el);
      });
      return;
    }
    nodes.forEach(([, el]) => {
      if (el !== null) el.style.transform = "";
    });
    const next: Record<string, ReturnType<typeof box>> = {};
    nodes.forEach(([k, el]) => {
      if (el !== null) next[k] = box(el);
    });
    this.lastNext = next;
    if (!this.m || this.reduced) {
      nodes.forEach(([, el]) => {
        settle(el);
      });
      return;
    }
    nodes.forEach(([k, el]) => {
      const from = cap[k];
      const to = next[k];
      if (el === null || from === undefined || to === undefined) {
        settle(el);
        return;
      }
      const dx = from.x - to.left;
      if (Math.abs(dx) < 2) {
        settle(el);
        return;
      }
      if (k === "card") this.cardDx = Math.abs(dx);
      const run = this.anim(el, { x: [dx, 0] });
      if (run === null) {
        settle(el);
        return;
      }
      this.morphAnims ??= [];
      this.morphAnims.push(run);
      this.morphSeq ??= {};
      this.morphSeq[k] = (this.morphSeq[k] ?? 0) + 1;
      const mine = this.morphSeq[k];
      const release = (): void => {
        if (this.morphSeq?.[k] === mine) settle(el);
      };
      run.finished.then(release).catch(release);
    });
  }

  go(screen: Screen, dir?: "push" | "pop"): void {
    // The running transfer owns the flight: the form behind it would re-quote and
    // wipe its progress while the transfer keeps asking for signatures.
    if (this.transferring && screen !== "flight" && screen !== "activity") return;
    const way = dir ?? "push";
    const wantPanel = screen === "send";
    const node = this.routesRef.current;
    let showing = false;
    if (wantPanel) {
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      if (node !== null && node.style.position === "absolute") {
        this.reattachPanel(node);
        showing = true;
      } else if (!this.state.routesMounted) showing = true;
    }
    const cap = this.lockHeight();
    if (!wantPanel && this.state.routesMounted) {
      this.detachPanel();
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        this.setState({ routesMounted: false });
      }, this.DUR * 2000);
    }
    const cameFrom = way === "pop" ? null : this.state.screen;
    const next = wantPanel
      ? { screen, dir: way, note: null, routesMounted: true, cameFrom }
      : { screen, dir: way, note: null, cameFrom };
    this.setState(
      next as Pick<State, "screen" | "dir" | "note" | "cameFrom" | "routesMounted">,
      () => {
        this.animateHeight(cap);
        this.mergePanel();
        if (showing) this.showRoutesPanel(cap.card === undefined ? null : cap.card.x);
        const pane = this.paneRef.current;
        if (pane === null || !this.m || this.reduced) return;
        pane.style.opacity = "";
        pane.style.transform = "";
        this.anim(pane, { opacity: [0, 1], x: [way === "pop" ? -14 : 14, 0] });
      },
    );
  }

  /** The logo: the form, quoting afresh when a transfer has just ended. */
  home(): void {
    if (this.state.phase === "ended" || this.state.phase === "arrived") {
      this.sendAnother();
      return;
    }
    this.go("send", "pop");
  }

  back(): void {
    // an ended transfer's review is its spent quote: back is the form, quoting afresh
    if (this.state.phase === "ended" || this.state.phase === "arrived") {
      this.sendAnother();
      return;
    }
    const from = this.state.cameFrom;
    this.go(from ?? "send", "pop");
  }

  sweep(): void {
    if (!this.m || this.reduced) return;
    this.anim(
      this.sweepRef.current,
      { scaleX: [0, 1], opacity: [1, 0] },
      { duration: 0.85, ease: [0.35, 0, 0.2, 1] },
    );
    this.anim(this.pivotRef.current, { scale: [1, 1.12, 1] }, { duration: 0.5 });
  }

  rollFigure(): void {
    this.anim(this.figureRef.current, { opacity: [0.35, 1], y: [6, 0] });
  }

  enterRow(i: number): void {
    const el = this.rows[i];
    if (el === null || el === undefined) return;
    el.style.opacity = "";
    el.style.transform = "";
    this.anim(el, { opacity: [0, 1], y: [9, 0] });
  }

  advanceStep(): void {
    const el = this.stepRef.current;
    if (el === null) return;
    el.style.opacity = "";
    el.style.transform = "";
    this.anim(el, { opacity: [0, 1], y: [8, 0] });
  }

  // ------------------------------------------------------------ real quote ---

  requote(): void {
    // only a transfer still running owns the form; one that ended does not
    if (this.transferring) return;
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.runQuote(), 430);
  }

  pickDefault(views: RouteView[], priority: Priority): string | null {
    if (views.length === 0) return null;
    const best = views.reduce((a, b) =>
      priority === "fast" ? (b.minutes < a.minutes ? b : a) : b.receives > a.receives ? b : a,
    );
    return best.id;
  }

  applyQuote(set: RouteSet, done: boolean): void {
    const views = set.routes.map(toRouteView);
    const cap = this.lockHeight();
    this.setState(
      (st) => {
        const pick = this.pickDefault(views, st.priority);
        const selected = st.picked && views.some((v) => v.id === st.selected) ? st.selected : pick;
        return {
          routes: views,
          rejected: [...set.rejected],
          complete: set.complete || done,
          quoting: done ? false : st.quoting,
          selected,
        };
      },
      () => {
        this.animateHeight(cap);
        if (views.length > 0) this.enterRow(views.length - 1);
        if (done)
          this.emit({
            type: "routesAvailable",
            count: views.length,
            declined: set.rejected.length,
          });
      },
    );
  }

  runQuote(): void {
    if (this.transferring) return;
    this.againConfirmed = false;
    this.currentQuote?.cancel();
    this.rows = [];
    const cap = this.lockHeight();
    this.setState(
      {
        routes: [],
        rejected: [],
        complete: false,
        quoting: true,
        phase: "quote",
        steps: [],
        arrivedAs: null,
        // a yes to sending again was for the quote it was asked on
        askAgain: false,
      },
      () => this.animateHeight(cap),
    );
    this.sweep();
    this.currentQuote = realQuote(
      this.engine,
      {
        chainId: this.state.chainId,
        wanted: this.state.wanted,
        amount: this.state.amount,
        destination: this.state.destination,
        priority: this.state.priority,
        rails: this.state.rails,
        send: this.state.send,
      },
      (partial) => this.applyQuote(partial, false),
      (final) => this.applyQuote(final, true),
      (check) => {
        // An unreachable sponsor is not dropped here: the quote turns it into
        // declines with the reason, on every route that needs the sponsor.
        if (!(check.terms instanceof Error)) {
          this.setState({ reserveFunding: check.terms.reserveFunding });
        }
      },
    );
  }

  // ------------------------------------------------------------ real wallet ---

  /** The networks the toggle offers, the engine's own among them. */
  offeredNetworks(): readonly ("testnet" | "mainnet")[] {
    return this.props.networks ?? [this.engine.network];
  }

  /**
   * Switch network. The host owns the engine, so it is asked to rebuild one
   * for the other network; nothing of this network's flow carries over. Not
   * while a transfer runs, which belongs to the network it started on.
   */
  setNetwork(network: "testnet" | "mainnet"): void {
    if (network === this.engine.network || this.transferring) return;
    if (!this.offeredNetworks().includes(network)) return;
    this.props.onNetworkChange?.(network);
  }

  /** Open the Stellar Wallets Kit's own modal and remember the address it returns. */
  async connectStellar(): Promise<void> {
    this.setState({ connecting: "stellar", walletError: null });
    try {
      const address = await this.engine.stellar.connect();
      this.emit({ type: "walletConnected", ecosystem: "stellar", address });
      // The common case is receiving to yourself, so an empty recipient is filled
      // with the connected address and the quote runs. A recipient already typed
      // is left alone.
      const fill = this.state.destination.trim() === "";
      this.setState(
        (prev) => ({
          connecting: null,
          stellarAddress: address,
          destination: fill ? address : prev.destination,
        }),
        () => {
          this.closeWallet();
          if (fill) this.runQuote();
        },
      );
    } catch (e) {
      this.setState({ connecting: null, walletError: msg(e) });
    }
  }

  async connectWallet(discovered: DiscoveredWallet): Promise<void> {
    this.setState({ connecting: discovered.info.uuid, walletError: null });
    try {
      const connection = await connect(discovered);
      const info: WalletInfo = {
        connection,
        name: discovered.info.name,
        icon: discovered.info.icon,
        short: shortAddr(connection.address),
      };
      this.emit({ type: "walletConnected", ecosystem: "evm", address: connection.address });
      this.setState({ connecting: null });
      this.closeWallet({ wallet: info });
      void this.refreshBalance({ info, align: true });
    } catch (e) {
      // Kept open with the reason shown, so a failed connect is visible rather
      // than a silent nothing.
      this.setState({ connecting: null, walletError: msg(e) });
    }
  }

  disconnect(): void {
    this.setState({ wallet: null, balance: null, walletError: null });
  }

  disconnectStellar(): void {
    void this.engine.stellar.disconnect();
    this.setState({ stellarAddress: null, walletError: null });
  }

  /**
   * Read the connected wallet's balance of what it is sending, on the selected chain.
   *
   * The app ships no RPC of its own, so the balance is read through the wallet's
   * own node, which means the wallet has to be on the selected chain. With
   * `align`, the wallet is asked to switch there first (one prompt, declined
   * gracefully), which is the same network the send will need anyway.
   */
  async refreshBalance(opts?: { info?: WalletInfo | null; align?: boolean }): Promise<void> {
    const w = opts?.info ?? this.state.wallet;
    if (w === null || w === undefined) {
      this.setState({ balance: null });
      return;
    }
    const send = this.state.send;
    const chainId = this.state.chainId;
    const detail = this.engine.sourceChainDetail(chainId);
    if (detail.kind !== "evm") {
      this.setState({ balance: null });
      return;
    }
    try {
      // USDT0's address is whatever the chain's OFT moves, so it is asked for
      // rather than looked up; a chain with no route simply shows no balance.
      const token =
        send === "USDT0"
          ? (await this.engine.usdt0Assets(chainId)).from
          : { id: this.engine.sourceUsdc(chainId), decimals: 6 };
      if (token.id === undefined) {
        this.setState({ balance: null });
        return;
      }
      let current = Number(await w.connection.provider.request({ method: "eth_chainId" }));
      if (opts?.align === true && current !== detail.evmChainId) {
        try {
          await switchChain(w.connection.provider, detail.evmChainId, detail.name);
          current = Number(await w.connection.provider.request({ method: "eth_chainId" }));
        } catch {
          // Declined, or the chain is not in the wallet. Nothing to show.
        }
      }
      if (current !== detail.evmChainId) {
        this.setState({ balance: null });
        return;
      }
      const raw = (await w.connection.reader.readContract({
        address: token.id as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [w.connection.address],
      })) as bigint;
      // the picker may have moved on while this was being read
      if (this.state.send !== send || this.state.chainId !== chainId) return;
      const cap = this.lockHeight();
      this.setState({ balance: Number(raw) / 10 ** token.decimals }, () => this.animateHeight(cap));
    } catch {
      this.setState({ balance: null });
    }
  }

  // ---------------------------------------------------------- real transfer ---

  setStep(id: string, patch: Partial<FlightStep>): void {
    if (patch.phase !== undefined) {
      this.emit({ type: "transferStepUpdated", id, phase: patch.phase });
    }
    this.setState(
      (st) => ({ steps: st.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) }),
      () => {
        if (patch.phase === "blocked" || patch.phase === "pending") this.advanceStep();
        this.tellWaiting(this.state.steps.some((step) => step.phase === "blocked"));
      },
    );
  }

  /**
   * Change the recipient. The routes on screen were quoted for the old one and
   * would still sign for it, so they go at once and a fresh quote follows.
   */
  setDestination(destination: string): void {
    if (this.transferring) return;
    this.currentQuote?.cancel();
    this.setState({ destination, routes: [], complete: false, quoting: true }, () =>
      this.requote(),
    );
  }

  /** Change the amount. As with the recipient, the old routes are dropped at once. */
  setAmount(amount: string): void {
    if (this.transferring) return;
    this.currentQuote?.cancel();
    this.setState({ amount, routes: [], complete: false, quoting: true }, () => this.requote());
  }

  /**
   * Why a route can no longer be sent as the form now reads, or undefined. A
   * route carries the recipient, amount and chain it was quoted for, and those
   * are what get signed, so they must be what review showed.
   */
  staleFor(view: RouteView): string | undefined {
    const route = view.route;
    if (route.destination !== this.state.destination.trim()) return "recipient";
    if (route.fromChain.id !== this.state.chainId) return "chain";
    if (route.sends.baseUnits !== toBaseUnits(this.state.amount, route.sends.asset.decimals))
      return "amount";
    return undefined;
  }

  private waitingOnUser = false;

  /** Pass on a change in whether the wallet is waiting on the user. */
  private tellWaiting(waiting: boolean): void {
    if (waiting === this.waitingOnUser) return;
    this.waitingOnUser = waiting;
    this.props.onAwaitingUser?.(waiting);
  }

  /** Back to the form for a new transfer; the one that ended stays under Activity. */
  sendAnother(): void {
    this.setState(
      {
        phase: "quote",
        steps: [],
        note: null,
        arrivedAs: null,
        history: readHistory(this.engine.historyKey),
      },
      () => {
        this.go("send", "pop");
        this.runQuote();
      },
    );
  }

  /** Quotes already sent, by the quote itself: a fresh quote is a new object. */
  private spent = new WeakSet<RouteView>();
  /** The last transfer whose money moved before the page stopped following it. */
  private moved:
    | { readonly destination: string; readonly sends: string; readonly at: number }
    | undefined;
  private againConfirmed = false;

  /** The user has read that the last transfer may still arrive, and sends again anyway. */
  confirmSendAgain(): void {
    this.againConfirmed = true;
    this.start();
  }

  start(): void {
    // Set here and not through setState, which only lands on the next render:
    // a second press before then would otherwise start a second transfer.
    if (this.transferring) return;
    const view = this.chosen();
    if (view === undefined) return;
    if (this.spent.has(view)) {
      this.setState({
        note: "This quote was already sent. Quoting again; review the new figures before starting.",
        noteKind: "fault",
      });
      this.runQuote();
      return;
    }
    // the same money to the same place, soon after a transfer that may still
    // land, is asked about first: it would be a second payment, not a retry
    const repeat = this.moved;
    if (
      !this.againConfirmed &&
      repeat !== undefined &&
      Date.now() - repeat.at < SEND_AGAIN_WINDOW_MS &&
      repeat.destination === view.route.destination &&
      repeat.sends === sendsKey(view)
    ) {
      this.setState({ askAgain: true });
      return;
    }
    this.againConfirmed = false;
    const stale = this.staleFor(view);
    if (stale !== undefined) {
      this.setState({
        note: `The ${stale} changed after this quote. Quoting again; review the new figures before starting.`,
        noteKind: "fault",
      });
      this.runQuote();
      return;
    }
    this.transferring = true;
    this.spent.add(view);
    this.props.onTransferChange?.(true);
    const chain = this.engine.sourceChainDetail(this.state.chainId);
    // Undefined only when the sponsor never answered, and then no route that
    // sets an account up was offered, which is the only kind it changes.
    const steps = buildSteps(view, this.state.reserveFunding);
    this.emit({ type: "transferStarted" });
    this.setState({ phase: "sending", steps, flying: view, askAgain: false }, () => {
      this.go("flight", "push");
      this.timers.push(setTimeout(() => void this.runTransfer(view, chain), this.DUR * 1000 + 20));
    });
  }

  async runTransfer(view: RouteView, chain: SourceDetail): Promise<void> {
    try {
      await this.runTransferOnce(view, chain);
    } finally {
      this.runEnded();
    }
  }

  /** The transfer's run is over, however it ended: the form is free again. */
  runEnded(): void {
    this.transferring = false;
    this.tellWaiting(false);
    this.props.onTransferChange?.(false);
  }

  private async runTransferOnce(view: RouteView, chain: SourceDetail): Promise<void> {
    if (chain.kind !== "evm") {
      this.failFlight(`Sending from ${chain.name} needs a ${chain.family} wallet.`);
      return;
    }
    if (this.state.wallet === null) {
      this.failFlight("Connect a wallet first.");
      return;
    }
    try {
      await runTransfer({
        engine: this.engine,
        view,
        chainId: this.state.chainId,
        chainName: chain.name,
        evmChainId: chain.evmChainId,
        nativeCurrency: chain.nativeCurrency,
        connection: this.state.wallet.connection,
        wanted: this.state.wanted,
        patch: (id, p) => this.setStep(id, p),
        onEvmEvent: () => {},
        signal: this.unmounted.signal,
      });
      this.arrive();
    } catch (e) {
      this.endWith(e);
    }
  }

  /** End the flight on an error: still moving is not a failure, anything else is. */
  endWith(error: unknown): void {
    if (error instanceof StillMoving) {
      this.rememberMoved();
      this.stillMoving(error.message);
      return;
    }
    if (error instanceof DeliveredUnverified) {
      this.rememberMoved();
      this.emit({
        type: "transferDeliveredUnverified",
        reason: error.message,
        stellarTxHash: error.txHash,
        explorerUrl: error.explorerUrl,
      });
      // ended, shown with its note on the step it ended on, never as failed
      this.setState(
        (st) => ({
          steps: st.steps.map((step) =>
            step.phase === "blocked" || step.phase === "pending"
              ? { ...step, phase: "done" as const, note: error.message }
              : step,
          ),
          note: error.message,
          noteKind: "quiet" as const,
          phase: "ended" as const,
          ...this.afterEnding(),
          history: readHistory(this.engine.historyKey),
        }),
        () => this.advanceStep(),
      );
      return;
    }
    if (error instanceof DeliveredAsCame) {
      // the money arrived, unconverted: told apart from a lost transfer
      this.emit({
        type: "transferDeliveredAsCame",
        reason: error.message,
        asset: error.asset,
        baseUnits: error.baseUnits,
      });
      // it arrived, so the flight ends arrived, headlined with what it arrived as
      this.setState(
        (st) => ({
          phase: "arrived" as const,
          ...this.afterEnding(),
          arrivedAs: {
            amount: fromBaseUnits(error.baseUnits, error.decimals),
            symbol: error.asset,
          },
          steps: st.steps.map((step) =>
            step.phase === "blocked" || step.phase === "pending"
              ? { ...step, phase: "done" as const, note: error.message }
              : step,
          ),
          note: error.message,
          noteKind: "quiet" as const,
          history: readHistory(this.engine.historyKey),
        }),
        () => this.advanceStep(),
      );
      return;
    }
    this.failFlight(msg(error, "The transfer did not go through."));
  }

  /**
   * The page stopped watching a transfer that is still on its way. The step
   * it was on stays in progress with the reason, and the host hears that it
   * is still moving, never that it failed.
   */
  stillMoving(message: string): void {
    this.emit({ type: "transferStillMoving", reason: message });
    this.setState(
      (st) => {
        const i = st.steps.findIndex((s) => s.phase === "blocked" || s.phase === "pending");
        const steps =
          i < 0
            ? st.steps
            : st.steps.map((step, j) =>
                j === i ? { ...step, phase: "pending" as const, note: message } : step,
              );
        return {
          steps,
          note: message,
          noteKind: "quiet" as const,
          phase: "ended" as const,
          ...this.afterEnding(),
          history: readHistory(this.engine.historyKey),
        };
      },
      () => this.advanceStep(),
    );
  }

  failFlight(message: string, emitFailed = true): void {
    if (emitFailed) this.emit({ type: "transferFailed", reason: message });
    this.setState(
      (st) => {
        const i = st.steps.findIndex((s) => s.phase === "blocked" || s.phase === "pending");
        const steps =
          i < 0
            ? st.steps
            : st.steps.map((step, j) =>
                j === i ? { ...step, phase: "failed" as const, note: message } : step,
              );
        return {
          steps,
          note: message,
          noteKind: "fault" as const,
          phase: "ended" as const,
          ...this.afterEnding(),
          history: readHistory(this.engine.historyKey),
        };
      },
      () => this.advanceStep(),
    );
  }

  arrive(): void {
    this.emit({ type: "transferCompleted" });
    this.setState(
      { phase: "arrived", ...this.afterEnding(), history: readHistory(this.engine.historyKey) },
      () => this.advanceStep(),
    );
  }

  /**
   * What every ending clears: the quote that was sent is spent, so the form's
   * routes go and nothing leads back to its review.
   */
  private afterEnding(): Pick<State, "routes" | "selected" | "picked" | "complete" | "cameFrom"> {
    return { routes: [], selected: null, picked: false, complete: false, cameFrom: null };
  }

  /** Remember a transfer whose money moved, so sending it again is asked about first. */
  private rememberMoved(): void {
    const view = this.state.flying;
    if (view === null) return;
    this.moved = { destination: view.route.destination, sends: sendsKey(view), at: Date.now() };
  }

  clearHistory(): void {
    forgetHistory(this.engine.historyKey);
    this.setState({ history: [] });
  }

  /** The design's flightVals, over the real steps. */
  flightVals(arrived: boolean): {
    stepEyebrow: string;
    stepCount: string;
    stepRows: FlightRow[];
  } {
    const steps = this.state.steps;
    if (steps.length === 0) return { stepRows: [], stepEyebrow: "", stepCount: "" };
    // a failed ending's step is where it stopped, so it counts as the current one
    let i = steps.findIndex(
      (step) => step.phase === "pending" || step.phase === "blocked" || step.phase === "failed",
    );
    if (i < 0)
      i = arrived
        ? steps.length - 1
        : Math.max(0, steps.filter((step) => step.phase === "done").length - 1);
    const cur = steps[i];
    if (cur === undefined) return { stepRows: [], stepEyebrow: "", stepCount: "" };
    const blocked = cur.phase === "blocked";
    const done = steps.filter((step) => step.phase === "done").length;
    return {
      // an ended flight is no longer working: it is on its way still, or stopped
      stepEyebrow: arrived
        ? "Complete"
        : this.state.phase === "ended"
          ? cur.phase === "pending"
            ? "Still on its way"
            : cur.phase === "failed"
              ? "Stopped"
              : "Ended"
          : blocked
            ? "Waiting for you"
            : "Working",
      stepCount: `${done} of ${steps.length} done`,
      stepRows: steps.map((step, j) => {
        const isDone = step.phase === "done";
        const active = j === i && !isDone;
        const last = j === steps.length - 1;
        return {
          key: step.id,
          label: step.label,
          // The actor (Your wallet / Circle / Mavna) is shown only on the step
          // that is currently happening, so the column is a pointer to who acts
          // now rather than a wall of repeated labels down every row.
          meta: active ? step.actor : "",
          metaInk: active ? "var(--mv-muted)" : "var(--mv-faintest)",
          // The active dot breathes so a waiting step reads as working, not
          // frozen. Done and idle dots are still.
          dotAnim: active ? "mv-pulse 1500ms cubic-bezier(0.4,0,0.6,1) infinite" : "none",
          hasLine: !last,
          lineStyle: isDone ? "solid" : "dashed",
          lineColor: isDone ? "var(--mv-line)" : "var(--mv-fill-dim)",
          mark: isDone ? "✓" : "",
          markInk: isDone ? "var(--mv-on-light)" : "var(--mv-ink)",
          dotBg: isDone ? "var(--mv-white)" : active ? "var(--mv-fill-dim)" : "transparent",
          dotBorder: isDone ? "var(--mv-line)" : active ? "var(--mv-line)" : "var(--mv-rule-2)",
          ink: isDone ? "var(--mv-ink-strong)" : active ? "var(--mv-ink)" : "var(--mv-faint-2)",
          weight: active ? 600 : 400,
          hasNote: active && step.note !== undefined,
          note: step.note ?? "",
          noteInk: blocked && active ? "var(--mv-ink-strong)" : "var(--mv-muted-2)",
          hasRef: isDone && step.ref !== undefined,
          refText: step.ref ?? "",
          refUrl: step.refUrl ?? "",
          gap: last ? "0px" : "18px",
        };
      }),
    };
  }

  // ------------------------------------------------------------ real lookup ---

  /** Counts lookups, so an older one that lands late does not overwrite a newer one. */
  private lookupSeq = 0;
  /** True while a Finish runs: a second press must not sign a second delivery. */
  private finishing = false;

  async onFind(): Promise<void> {
    const seq = ++this.lookupSeq;
    // whatever was priced belonged to the transfer shown before this lookup
    this.pricedFinish = undefined;
    const v = this.state.lookup.trim();
    let key: ReturnType<typeof parseLookupKey>;
    try {
      key = parseLookupKey(v);
    } catch (e) {
      this.setState({ found: null, lookupNote: msg(e), lookupNoteKind: "fault" });
      return;
    }
    this.setState({ lookupNote: null, finishTries: 0 });
    try {
      const rec = this.state.history.find((h) => h.sourceTxHash.toLowerCase() === v.toLowerCase());
      // The chain is known only for a transfer this browser sent. Without it
      // every rail is asked, which is slower and still finds it.
      const answer = await lookupAcross(this.engine.adapters, toHandle(key, rec?.sourceChainId));
      if (seq !== this.lookupSeq) return;
      let phase = answer.phase;
      if (rec !== undefined && phase.phase === "pending") {
        phase = escalateIfOverdue(
          {
            id: "bridge",
            label: "",
            phase,
            expectedSeconds: 2400,
            startedAtUnix: rec.startedAtUnix,
          },
          Math.floor(Date.now() / 1000),
          () => ({
            kind: "retry",
            because:
              "This has taken far longer than the path usually does. Finishing the delivery is safe to try.",
          }),
        ).phase;
      }
      this.setState({
        found: foundFor(phase, key.kind, answer.rails),
        // A rail that could not be asked is said, so its silence is not read as
        // the transfer not being there.
        lookupNote:
          answer.errors.length === 0
            ? null
            : `Not every rail answered: ${answer.errors
                .map((e) => `${railDisplay(e.source)} (${e.message})`)
                .join(", ")}.`,
        lookupNoteKind: "quiet",
      });
    } catch (e) {
      if (seq !== this.lookupSeq) return;
      this.setState({ found: null, lookupNote: msg(e), lookupNoteKind: "fault" });
    }
  }

  /** A finish the user was shown the price of, waiting for their second press. */
  private pricedFinish:
    | {
        readonly guid: string;
        readonly run: Extract<FinishAnswer, { kind: "priced" }>["finish"];
      }
    | undefined;

  async onFinish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    try {
      await this.finishOnce();
    } finally {
      this.finishing = false;
    }
  }

  private async finishOnce(): Promise<void> {
    const compose = this.state.found?.compose;
    if (compose !== undefined) {
      try {
        // A run the user already saw priced is signed now; otherwise the sponsor
        // runs it, or, with self-funded reserves, it is priced for the user first.
        // only a run priced for this very message is signed
        const pending = this.pricedFinish?.guid === compose.guid ? this.pricedFinish : undefined;
        this.pricedFinish = undefined;
        const outcome =
          pending === undefined ? await finishCompose(this.engine, compose) : await pending.run();
        if (outcome.kind === "priced") {
          this.pricedFinish = { guid: compose.guid, run: outcome.finish };
          this.setState({
            lookupNote:
              `Finishing it costs up to ${stroopsToXlm(outcome.feeStroops)} XLM from this ` +
              "account, simulated just now. Press Finish the delivery again to approve it in " +
              "your Stellar wallet.",
            lookupNoteKind: "quiet",
          });
          return;
        }
        if (outcome.kind === "not-queued") {
          this.setState({
            lookupNote: "Stellar holds nothing waiting for this transfer yet. Try again shortly.",
            lookupNoteKind: "quiet",
          });
          return;
        }
        // read back from the chain, which is the only thing that says how it ended
        await this.onFind();
      } catch (e) {
        this.setState({ lookupNote: msg(e), lookupNoteKind: "fault" });
      }
      return;
    }
    const hash = this.state.lookup.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) {
      this.setState({
        lookupNote: "Finishing a delivery needs the transaction you sent. Paste it above.",
        lookupNoteKind: "fault",
      });
      return;
    }
    const known = this.state.history.find(
      (r) => r.sourceTxHash.toLowerCase() === hash.toLowerCase(),
    );
    try {
      // a burn this browser did not send is looked for on every chain Circle serves
      const domain =
        known === undefined
          ? await burnDomain(this.engine, hash.startsWith("0x") ? hash : `0x${hash}`)
          : this.engine.sourceDomain(known.sourceChainId);
      if (domain === undefined) {
        this.setState({
          lookupNote:
            "Circle has no record of this transaction on any chain this page sends from. " +
            "If it was sent moments ago, try again in a minute.",
          lookupNoteKind: "quiet",
          finishTries: this.state.finishTries + 1,
        });
        return;
      }
      const outcome = await finishDelivery(
        this.engine,
        hash.startsWith("0x") ? hash : `0x${hash}`,
        domain,
        known?.sourceChainId,
      );
      if (outcome.kind === "too-costly") {
        this.setState({ lookupNote: tooCostly(outcome.feeStroops), lookupNoteKind: "fault" });
      } else if (outcome.kind === "delivered" || outcome.kind === "already-delivered") {
        this.setState({
          lookupNote: "Delivered. The funds are on Stellar.",
          lookupNoteKind: "quiet",
          found: { tone: "ok", note: "Delivered on Stellar.", canFinish: false },
        });
      } else if (outcome.kind === "not-attested-yet") {
        this.setState({
          lookupNote: "Circle has not attested it yet. Nothing is wrong; try again in a minute.",
          lookupNoteKind: "quiet",
          finishTries: this.state.finishTries + 1,
        });
      } else {
        this.setState({ lookupNote: outcome.detail, lookupNoteKind: "fault" });
      }
    } catch (e) {
      this.setState({ lookupNote: msg(e), lookupNoteKind: "fault" });
    }
  }

  // ----------------------------------------------------------------- render ---

  override render(): ReactNode {
    return this.props.variant === "compact" ? renderCompact(this) : renderApp(this);
  }
}

/* The render is a free function so the class stays about behaviour. It reads the
   same instance the methods write, exactly like the design's renderVals/render
   split. Every inline style below is the design's, passed verbatim through s(). */
function renderApp(c: Flow): ReactNode {
  const st = c.state;
  const arrived = st.phase === "arrived";
  const ended = st.phase === "ended";
  const sending = st.phase === "sending";
  const xlm = st.wanted === "XLM";
  const sym = c.sym();
  const chain = c.chain();
  const chainDetail = c.engine.sourceChainDetail(st.chainId);
  // the flight shows what was sent, which the form no longer holds once it ends
  const r = st.screen === "flight" ? (st.flying ?? c.chosen()) : c.chosen();
  const resting = c.amountNumber() <= 0;

  const titles: Record<Screen, string> = {
    send: "Send to Stellar",
    chains: "Send from",
    address: "Recipient",
    settings: "Settings",
    rails: "Rails",
    priority: "Route priority",
    routes: "Select a route",
    review: "Review transfer",
    flight: arrived ? "Arrived" : ended ? "Transfer ended" : "In flight",
    activity: "Activity",
  };

  return (
    <div
      ref={c.rootRef}
      style={s(
        "position:relative;isolation:isolate;min-height:100dvh;background:var(--mv-ground);display:flex;flex-direction:column",
      )}
    >
      {/* Grain layer, behind everything via a negative z-index in this root's
          own stacking context (isolation:isolate above). */}
      <div className="mv-grain" aria-hidden="true" />
      <header
        style={s(
          "flex:0 0 auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px",
        )}
      >
        <button
          type="button"
          onClick={() => c.home()}
          aria-label="Mavna home"
          className={pseudo({ hover: "opacity:0.75", active: "transform:translateY(1px)" })}
          style={s(
            "display:flex;align-items:center;gap:13px;min-width:0;padding:0;background:transparent;border:0;cursor:pointer;color:var(--mv-ink)",
          )}
        >
          <svg
            viewBox={MAVNA_MARK_VIEWBOX}
            aria-hidden="true"
            fill="currentColor"
            style={s("width:22px;height:22px;display:block")}
          >
            <path d={MAVNA_MARK_PATH} />
          </svg>
          <span
            style={s(
              "font-family:var(--mv-font-mono);font-size:13px;font-weight:500;letter-spacing:0.26em;color:var(--mv-ink)",
            )}
          >
            MAVNA
          </span>
        </button>

        <div style={s("display:flex;align-items:center;gap:12px;flex:0 0 auto")}>
          {c.hidden("networkToggle") ? null : renderNetworkToggle(c)}
          {renderWallet(c)}
          {renderMenu(c)}
        </div>
      </header>

      <main
        style={s(
          "flex:1 1 auto;display:flex;align-items:flex-start;justify-content:center;padding:72px 20px 56px",
        )}
      >
        <div
          ref={c.rowRef}
          style={s(
            "position:relative;display:flex;flex-wrap:wrap;align-items:stretch;justify-content:center;gap:16px;max-width:100%",
          )}
        >
          <div
            ref={c.cardRef}
            style={s(
              "position:relative;z-index:2;flex:0 0 auto;width:460px;height:624px;max-width:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--mv-surface);border:1px solid var(--mv-rule-hair);border-radius:18px;padding:18px",
            )}
          >
            <div
              style={s("flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:0 4px 4px")}
            >
              {st.screen !== "send" && !sending ? (
                <button
                  type="button"
                  onClick={() => c.back()}
                  aria-label="Back"
                  className={pseudo({
                    hover: "background:var(--mv-surface-2)",
                    active: "transform:translateY(1px)",
                  })}
                  style={s(
                    "width:30px;height:30px;flex:0 0 auto;display:grid;place-items:center;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font-mono);font-size:13px;color:var(--mv-ink)",
                  )}
                >
                  ←
                </button>
              ) : null}
              <h1 style={s("margin:0;font-size:15px;font-weight:600;letter-spacing:-0.01em")}>
                {titles[st.screen]}
              </h1>
              {st.screen === "send" ? (
                <div style={s("margin-left:auto;display:flex;align-items:center;gap:4px")}>
                  {renderCardActions(c)}
                </div>
              ) : null}
            </div>

            <div
              ref={c.bodyRef}
              style={s(
                `flex:1 1 auto;min-height:0;overflow-x:hidden;padding-right:9px;margin-right:-13px;scrollbar-gutter:stable;overflow-y:${st.screen === "flight" ? "hidden" : "auto"}`,
              )}
            >
              <div
                ref={c.paneRef}
                style={s(`padding-top:10px;height:${st.screen === "flight" ? "100%" : "auto"}`)}
              >
                {st.screen === "send" ? renderSend(c, { r, chain, sym, xlm, resting }) : null}
                {st.screen === "chains" ? renderChains(c) : null}
                {st.screen === "priority" ? renderPriority(c, sym) : null}
                {st.screen === "address" ? renderAddress(c) : null}
                {st.screen === "settings" ? renderSettings(c) : null}
                {st.screen === "rails" ? renderRails(c) : null}
                {st.screen === "review" ? renderReview(c, { r, chain, sym }) : null}
                {st.screen === "flight" ? renderFlight(c, { r, chain, sym, arrived }) : null}
                {st.screen === "activity" ? renderActivity(c) : null}
              </div>
            </div>

            {st.screen === "send" ? (
              <div style={s("flex:0 0 auto;padding-top:12px")}>
                {/* always there, so a note that appears is announced */}
                <div role="status" aria-live="polite">
                  {st.note !== null ? (
                    <p
                      style={s(
                        `margin:0 2px 10px;font-size:12.5px;line-height:1.5;color:${st.noteKind === "fault" ? "var(--mv-signal)" : "var(--mv-muted-2)"};text-wrap:pretty`,
                      )}
                    >
                      {st.note}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onPrimary(c, { r, chain: chainDetail })}
                  className={pseudo({
                    hover: "background:var(--mv-cta-hover)",
                    active: "transform:translateY(1px)",
                  })}
                  style={s(
                    "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
                  )}
                >
                  {primaryLabel(c, "Review transfer")}
                </button>
              </div>
            ) : null}

            {(arrived || ended) && st.screen === "flight" ? (
              <div style={s("flex:0 0 auto;padding-top:12px")}>
                <button
                  type="button"
                  onClick={() => c.sendAnother()}
                  className={pseudo({
                    hover: "background:var(--mv-cta-hover)",
                    active: "transform:translateY(1px)",
                  })}
                  style={s(
                    "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
                  )}
                >
                  Send another
                </button>
              </div>
            ) : null}
          </div>

          {st.routesMounted ? renderRoutes(c, { sym, resting: c.resting() }) : null}
        </div>
      </main>

      <footer style={s("flex:0 0 auto;height:26px")} />
    </div>
  );
}

/* The wallet control: the connect button and its two-section popover (the EVM
   source wallet and the Stellar receiving wallet). Shared by the wide page
   header and the compact card header, so both open the same menu. */
/* The header overflow ("...") menu. Renders only when the integrator gave it
   links; the dropdown closes on select, on outside click, and on Escape. */
function renderMenu(c: Flow): ReactNode {
  const links = c.menuLinks();
  if (links.length === 0) return null;
  const st = c.state;
  return (
    <div style={s("position:relative;flex:0 0 auto")}>
      <button
        type="button"
        onClick={() => c.setState({ menuOpen: !st.menuOpen })}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={st.menuOpen}
        className={pseudo({
          hover: "background:var(--mv-surface-2)",
          active: "transform:translateY(1px)",
        })}
        style={s(
          "width:36px;height:36px;flex:0 0 auto;display:grid;place-items:center;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;color:var(--mv-ink)",
        )}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          fill="currentColor"
          style={s("display:block")}
        >
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>

      {st.menuOpen ? (
        <div
          ref={c.menuPopRef}
          role="menu"
          style={s(
            "position:absolute;top:calc(100% + 9px);right:0;z-index:60;min-width:184px;padding:6px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:14px;box-shadow:0 24px 60px -24px var(--mv-scrim)",
          )}
        >
          {links.map((l) => (
            <a
              key={`${l.href}:${l.label}`}
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noopener noreferrer" : undefined}
              role="menuitem"
              onClick={() => c.setState({ menuOpen: false })}
              className={pseudo({ hover: "background:var(--mv-surface-2)" })}
              style={s(
                "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;border-radius:9px;font-size:13.5px;color:var(--mv-ink);text-decoration:none",
              )}
            >
              {l.label}
              {l.external ? (
                <span
                  style={s(
                    "font-family:var(--mv-font-mono);font-size:11px;color:var(--mv-muted-b)",
                  )}
                >
                  ↗
                </span>
              ) : null}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderWallet(c: Flow): ReactNode {
  const st = c.state;
  return (
    <div style={s("position:relative;flex:0 0 auto")}>
      <button
        type="button"
        onClick={() => {
          // Opt-out: if the host handles connection and none is connected yet, hand
          // off to it instead of opening the built-in menu.
          const onConnect = c.props.walletConfig?.onConnect;
          if (onConnect !== undefined && st.wallet === null) {
            onConnect();
            return;
          }
          if (st.walletOpen) c.closeWallet();
          else c.setState({ walletOpen: true });
        }}
        aria-expanded={st.walletOpen}
        className={pseudo({
          hover: "background:var(--mv-surface-2)",
          active: "transform:translateY(1px)",
        })}
        style={s(
          "display:flex;align-items:center;gap:9px;padding:8px 14px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font:inherit;color:var(--mv-ink)",
        )}
      >
        {st.wallet === null ? (
          <span
            style={s(
              "font-family:var(--mv-font-mono);font-size:9.5px;letter-spacing:0.1em;color:var(--mv-muted-b)",
            )}
          >
            ○
          </span>
        ) : (
          <img
            src={st.wallet.icon}
            alt=""
            aria-hidden="true"
            style={s("width:16px;height:16px;flex:0 0 auto;border-radius:999px;object-fit:contain")}
          />
        )}
        <span style={s("font-size:13px;font-weight:500;white-space:nowrap")}>
          {st.wallet === null ? "Connect" : st.wallet.short}
        </span>
      </button>

      {st.walletOpen ? (
        <div
          ref={c.walletPopRef}
          style={s(
            "position:absolute;top:calc(100% + 9px);right:0;z-index:60;width:264px;background:var(--mv-surface);border:1px solid var(--mv-rule);border-radius:14px;box-shadow:0 24px 60px -24px var(--mv-scrim);overflow:hidden",
          )}
        >
          {st.walletError !== null ? (
            <p
              style={s(
                "margin:0;padding:12px 16px;border-bottom:1px solid var(--mv-rule-hair);font-size:12px;line-height:1.45;color:var(--mv-signal);text-wrap:pretty",
              )}
            >
              {st.walletError}
            </p>
          ) : null}

          {/* Source wallet: the EVM chain the transfer is sent from. */}
          <p
            style={s(
              "margin:0;padding:12px 16px 8px;font-family:var(--mv-font-mono);font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--mv-muted-2)",
            )}
          >
            Source wallet
          </p>
          {st.wallet === null ? (
            st.discovered.length === 0 ? (
              <p
                style={s("margin:0;padding:2px 16px 12px;font-size:12.5px;color:var(--mv-muted-2)")}
              >
                No wallet found in this browser.
              </p>
            ) : (
              st.discovered.map((d) => (
                <button
                  key={d.info.uuid}
                  type="button"
                  onClick={() => void c.connectWallet(d)}
                  className={pseudo({ hover: "background:var(--mv-surface-2)" })}
                  style={s(
                    "width:100%;display:flex;align-items:center;gap:11px;padding:10px 16px;background:transparent;border:0;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
                  )}
                >
                  <span
                    style={s(
                      "width:22px;height:22px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--mv-rule);border-radius:999px;overflow:hidden",
                    )}
                  >
                    <img
                      src={d.info.icon}
                      alt=""
                      aria-hidden="true"
                      style={s("width:16px;height:16px;object-fit:contain")}
                    />
                  </span>
                  <span style={s("font-size:13px;font-weight:500")}>{d.info.name}</span>
                  <span
                    style={s(
                      "margin-left:auto;font-family:var(--mv-font-mono);font-size:9px;letter-spacing:0.12em;color:var(--mv-faint-2)",
                    )}
                  >
                    {st.connecting === d.info.uuid ? "Connecting…" : "EVM"}
                  </span>
                </button>
              ))
            )
          ) : (
            <div
              style={s(
                "display:flex;align-items:center;gap:11px;padding:6px 16px 12px;color:var(--mv-ink)",
              )}
            >
              <span
                style={s(
                  "width:22px;height:22px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--mv-rule);border-radius:999px;overflow:hidden",
                )}
              >
                <img
                  src={st.wallet.icon}
                  alt=""
                  aria-hidden="true"
                  style={s("width:16px;height:16px;object-fit:contain")}
                />
              </span>
              <span
                style={s("font-family:var(--mv-font-mono);font-size:12px;letter-spacing:0.02em")}
              >
                {st.wallet.short}
              </span>
              <button
                type="button"
                onClick={() => c.disconnect()}
                className={pseudo({
                  hover: "color:var(--mv-ink);border-color:var(--mv-rule-hover)",
                })}
                style={s(
                  "margin-left:auto;padding:4px 10px;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font-mono);font-size:8.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mv-muted)",
                )}
              >
                Disconnect
              </button>
            </div>
          )}

          {/* Stellar wallet: the receiving side, used to set up a new
                    account and to convert to XLM. Separate from the source. */}
          <p
            style={s(
              "margin:0;padding:12px 16px 8px;border-top:1px solid var(--mv-rule-hair);font-family:var(--mv-font-mono);font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--mv-muted-2)",
            )}
          >
            Stellar wallet
          </p>
          {st.stellarAddress === null ? (
            <button
              type="button"
              onClick={() => void c.connectStellar()}
              className={pseudo({ hover: "background:var(--mv-surface-2)" })}
              style={s(
                "width:100%;display:flex;align-items:center;gap:11px;padding:10px 16px 12px;background:transparent;border:0;cursor:pointer;font:inherit;color:var(--mv-ink);text-align:left",
              )}
            >
              <span
                style={s(
                  "width:22px;height:22px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--mv-rule);border-radius:999px;font-family:var(--mv-font-mono);font-size:11px;color:var(--mv-muted)",
                )}
              >
                ✦
              </span>
              <span style={s("font-size:13px;font-weight:500")}>
                {st.connecting === "stellar" ? "Connecting…" : "Connect"}
              </span>
              <span
                style={s(
                  "margin-left:auto;font-family:var(--mv-font-mono);font-size:9px;letter-spacing:0.12em;color:var(--mv-faint-2)",
                )}
              >
                Stellar
              </span>
            </button>
          ) : (
            <div
              style={s(
                "display:flex;align-items:center;gap:11px;padding:6px 16px 12px;color:var(--mv-ink)",
              )}
            >
              <span
                style={s(
                  "width:22px;height:22px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--mv-rule);border-radius:999px;font-family:var(--mv-font-mono);font-size:11px;color:var(--mv-muted)",
                )}
              >
                ✦
              </span>
              <span
                style={s("font-family:var(--mv-font-mono);font-size:12px;letter-spacing:0.02em")}
              >
                {shortAddr(st.stellarAddress)}
              </span>
              <button
                type="button"
                onClick={() => c.disconnectStellar()}
                className={pseudo({
                  hover: "color:var(--mv-ink);border-color:var(--mv-rule-hover)",
                })}
                style={s(
                  "margin-left:auto;padding:4px 10px;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font-mono);font-size:8.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mv-muted)",
                )}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/*
 * The compact variant: the whole flow in one card.
 *
 * The route comparison the wide layout puts in a side panel is embedded in the
 * card body under the form (renderRoutes with embed), and the wallet and network
 * controls the wide layout keeps in the page header move into the card's own
 * header (network reached through settings). This is the single panel the widget
 * embeds and the drawer opens. The card does not clip, so the wallet popover can
 * drop over the body; the body scrolls itself.
 */
function renderCompact(c: Flow): ReactNode {
  const st = c.state;
  const arrived = st.phase === "arrived";
  const ended = st.phase === "ended";
  const sending = st.phase === "sending";
  const xlm = st.wanted === "XLM";
  const sym = c.sym();
  const chain = c.chain();
  const chainDetail = c.engine.sourceChainDetail(st.chainId);
  // the flight shows what was sent, which the form no longer holds once it ends
  const r = st.screen === "flight" ? (st.flying ?? c.chosen()) : c.chosen();
  const resting = c.amountNumber() <= 0;

  const titles: Record<Screen, string> = {
    send: "Send to Stellar",
    chains: "Send from",
    address: "Recipient",
    settings: "Settings",
    rails: "Rails",
    priority: "Route priority",
    routes: "Select a route",
    review: "Review transfer",
    flight: arrived ? "Arrived" : ended ? "Transfer ended" : "In flight",
    activity: "Activity",
  };

  return (
    <div
      ref={c.rootRef}
      style={s(
        // 650 = the app card's 624 content height plus the 26px "Powered by Mavna"
        // strip below it, so the body keeps the full height and never scrolls for it.
        "position:relative;isolation:isolate;width:100%;max-width:440px;margin:0 auto;height:min(650px,calc(100dvh - 48px));display:flex;flex-direction:column;background:var(--mv-surface);border:1px solid var(--mv-rule-hair);border-radius:18px",
      )}
    >
      <div
        style={s(
          "flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:14px 16px 12px;border-bottom:1px solid var(--mv-rule-hair)",
        )}
      >
        {st.screen !== "send" && !sending ? (
          <button
            type="button"
            onClick={() => c.back()}
            aria-label="Back"
            className={pseudo({
              hover: "background:var(--mv-surface-2)",
              active: "transform:translateY(1px)",
            })}
            style={s(
              "width:30px;height:30px;flex:0 0 auto;display:grid;place-items:center;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;font-family:var(--mv-font-mono);font-size:13px;color:var(--mv-ink)",
            )}
          >
            ←
          </button>
        ) : null}
        <h1 style={s("margin:0;font-size:15px;font-weight:600;letter-spacing:-0.01em")}>
          {titles[st.screen]}
        </h1>
        <div style={s("margin-left:auto;display:flex;align-items:center;gap:7px;flex:0 0 auto")}>
          {st.screen === "send" ? renderCardActions(c) : null}
          {renderWallet(c)}
          {renderMenu(c)}
        </div>
      </div>

      <div
        ref={c.bodyRef}
        style={s(
          `flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:${st.screen === "flight" ? "hidden" : "auto"};padding:12px 16px 4px`,
        )}
      >
        <div ref={c.paneRef} style={s(`height:${st.screen === "flight" ? "100%" : "auto"}`)}>
          {st.screen === "send" ? renderSend(c, { r, chain, sym, xlm, resting }) : null}
          {st.screen === "routes"
            ? renderRoutes(c, { sym, resting: undefined, embed: true, pick: true })
            : null}
          {st.screen === "chains" ? renderChains(c) : null}
          {st.screen === "priority" ? renderPriority(c, sym) : null}
          {st.screen === "address" ? renderAddress(c) : null}
          {st.screen === "settings" ? renderSettings(c) : null}
          {st.screen === "rails" ? renderRails(c) : null}
          {st.screen === "review" ? renderReview(c, { r, chain, sym }) : null}
          {st.screen === "flight" ? renderFlight(c, { r, chain, sym, arrived }) : null}
          {st.screen === "activity" ? renderActivity(c) : null}
        </div>
      </div>

      {st.screen === "send" ? (
        <div style={s("flex:0 0 auto;padding:10px 16px 16px")}>
          {/* always there, so a note that appears is announced */}
          <div role="status" aria-live="polite">
            {st.note !== null ? (
              <p
                style={s(
                  `margin:0 2px 10px;font-size:12.5px;line-height:1.5;color:${st.noteKind === "fault" ? "var(--mv-signal)" : "var(--mv-muted-2)"};text-wrap:pretty`,
                )}
              >
                {st.note}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onPrimaryCompact(c, { chain: chainDetail })}
            className={pseudo({
              hover: "background:var(--mv-cta-hover)",
              active: "transform:translateY(1px)",
            })}
            style={s(
              "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
            )}
          >
            {primaryLabel(c, "Select a route")}
          </button>
        </div>
      ) : null}

      {st.screen === "routes" ? (
        <div style={s("flex:0 0 auto;padding:10px 16px 16px")}>
          <button
            type="button"
            onClick={() => c.go("review", "push")}
            className={pseudo({
              hover: "background:var(--mv-cta-hover)",
              active: "transform:translateY(1px)",
            })}
            style={s(
              "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
            )}
          >
            Review transfer
          </button>
        </div>
      ) : null}

      {(arrived || ended) && st.screen === "flight" ? (
        <div style={s("flex:0 0 auto;padding:10px 16px 16px")}>
          <button
            type="button"
            onClick={() => c.sendAnother()}
            className={pseudo({
              hover: "background:var(--mv-cta-hover)",
              active: "transform:translateY(1px)",
            })}
            style={s(
              "width:100%;padding:15px 20px;background:var(--mv-white);color:var(--mv-on-light);border:0;border-radius:999px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600",
            )}
          >
            Send another
          </button>
        </div>
      ) : null}

      {c.hidden("poweredBy") ? null : (
        <a
          href="https://mavna.app"
          target="_blank"
          rel="noopener noreferrer"
          className={pseudo({ hover: "color:var(--mv-faint)" })}
          style={s(
            "flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 16px 14px;font-family:var(--mv-font-mono);font-size:8.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--mv-faint-2);text-decoration:none;transition:color var(--mv-fast) var(--mv-ease)",
          )}
        >
          <svg
            viewBox={MAVNA_MARK_VIEWBOX}
            aria-hidden="true"
            fill="currentColor"
            style={s("width:11px;height:11px;display:block")}
          >
            <path d={MAVNA_MARK_PATH} />
          </svg>
          Powered by Mavna
        </a>
      )}
    </div>
  );
}

/* The activity and settings icon buttons in the card header, each removable via
   hiddenUI. Shared by the wide and compact layouts. */
function renderCardActions(c: Flow): ReactNode {
  return (
    <>
      {c.hidden("activity") ? null : (
        <button
          type="button"
          onClick={() => c.go("activity", "push")}
          aria-label="Activity"
          title="Activity"
          className={pseudo({
            hover: "background:var(--mv-surface-2);color:var(--mv-ink)",
            active: "transform:translateY(1px)",
          })}
          style={s(
            "width:32px;height:32px;display:grid;place-items:center;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;color:var(--mv-ink-2)",
          )}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </button>
      )}
      {c.hidden("settings") ? null : (
        <button
          type="button"
          onClick={() => c.go("settings", "push")}
          aria-label="Settings"
          title="Settings"
          className={pseudo({
            hover: "background:var(--mv-surface-2);color:var(--mv-ink)",
            active: "transform:translateY(1px)",
          })}
          style={s(
            "width:32px;height:32px;display:grid;place-items:center;background:transparent;border:1px solid var(--mv-rule);border-radius:999px;cursor:pointer;color:var(--mv-ink-2)",
          )}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
            <circle cx="16" cy="8" r="2" />
            <circle cx="10" cy="16" r="2" />
          </svg>
        </button>
      )}
    </>
  );
}
