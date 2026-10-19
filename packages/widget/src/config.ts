import { ARRIVAL_CONTRACTS } from "@mavna/adapter-layerzero";
import type { NetworkId } from "@mavna/core";
import type { IntegratorFee } from "@mavna/routing";
import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL } from "@mavna/stellar";
import type { EngineConfig } from "./engine.js";
import type { RailName, SendAsset, Wanted } from "./quote.js";
import type { StellarWalletApi } from "./stellar-wallet.js";
import type { Connection } from "./wallet.js";
/** What an integrator sets. Whether it can be collected is decided by the engine. */
export type IntegratorFeeConfig = Omit<IntegratorFee, "collects">;

/**
 * The widget's public configuration, in the shape an integrator writes.
 *
 * Modelled on the LI.FI widget: one object, drop it on `<MavnaWidget>`, and the
 * widget quotes, routes and (by default) manages wallets itself. Every field maps
 * to a real capability of the engine or the flow underneath, so nothing here
 * promises something the code cannot honour.
 *
 * Kept JSON-serialisable except the event and wallet hooks, so a future iframe
 * build can pass the rest of the config over postMessage without a rewrite.
 */
export type Variant = "compact" | "wide" | "drawer";
export type Appearance = "light" | "dark" | "system";

export type { RailName, SendAsset };

/** UI the integrator can remove. Each maps to a real control in the flow. */
export type HiddenUIElement =
  | "activity"
  | "settings"
  | "networkToggle"
  | "railToggles"
  | "poweredBy";
/** UI the integrator can lock. `destination` fixes the recipient to `toAddress`. */
export type RequiredUIElement = "destination";

/**
 * What the widget reports back to the host. Every event is backed by a real signal
 * in the flow: a completed quote, a route the user picked, a wallet that connected,
 * a transfer moving through its steps, or one that finished or failed.
 */
export type MavnaWidgetEvent =
  | { readonly type: "routesAvailable"; readonly count: number; readonly declined: number }
  | { readonly type: "routeSelected"; readonly source: string; readonly receives: number }
  | {
      readonly type: "walletConnected";
      readonly ecosystem: "evm" | "stellar";
      readonly address: string;
    }
  | { readonly type: "transferStarted" }
  | { readonly type: "transferStepUpdated"; readonly id: string; readonly phase: string }
  | { readonly type: "transferCompleted" }
  | { readonly type: "transferFailed"; readonly reason: string }
  /**
   * The transfer is on its way and the widget stopped watching it: it outlived
   * the widget's patience, or the widget went away. Not a failure; the money is
   * in flight and can be checked on or finished from Activity.
   */
  | { readonly type: "transferStillMoving"; readonly reason: string };

/**
 * Opt out of the widget's own wallet management. Provide an already-connected EVM
 * `Connection` and/or a Stellar signer, and the widget uses them instead of
 * discovering wallets itself; `onConnect` replaces the built-in connect UI with
 * the host's own.
 */
export interface WalletConfig {
  readonly onConnect?: () => void;
  readonly evm?: Connection;
  readonly stellar?: StellarWalletApi;
}

/** Colour and type overrides, applied as CSS custom properties on the root. */
export interface WidgetTheme {
  readonly tokens?: Readonly<Record<string, string>>;
  readonly font?: string;
  readonly fontMono?: string;
  readonly radius?: string;
  readonly radiusLg?: string;
}

export interface MavnaWidgetConfig {
  /** Required. Identifies the integrator, and attributes an integrator fee. */
  readonly integrator: string;
  /**
   * The network the widget starts on. Default testnet. Mainnet's default node
   * is a public third-party one; set `rpcUrl` to your own provider.
   */
  readonly network?: NetworkId;
  /**
   * The networks the network toggle switches between, `network` among them.
   * Default only `network`. Every network besides `network` needs its own
   * `sponsorUrl` in `endpoints`, since a sponsor serves one network.
   */
  readonly networks?: readonly NetworkId[];
  /**
   * Endpoints per network. For `network` itself, `rpcUrl` and `sponsorUrl`
   * below work too; a value here wins.
   */
  readonly endpoints?: Partial<Record<NetworkId, NetworkEndpoints>>;
  readonly variant?: Variant;
  readonly appearance?: Appearance;
  readonly theme?: WidgetTheme;
  /** Stellar RPC endpoint. EVM reads go through the connected wallet, never here. */
  readonly rpcUrl?: string;
  /** A sponsor the integrator runs; defaults to Mavna's local dev sponsor. */
  readonly sponsorUrl?: string;
  /**
   * The Mavna Arrival Contract on `network`, which lets USDT0 routes convert on
   * arrival with one signature. Defaults to the deployed one (testnet only); a
   * network without one says so on its LayerZero routes. Other networks set
   * theirs in `endpoints`.
   */
  readonly arrivalContract?: string;
  /**
   * How routes are ranked when several arrive, and the flow's initial priority.
   * The two the flow exposes: most received, or fastest.
   */
  readonly routePriority?: "best-received" | "fastest";
  /**
   * An integrator fee, taken from what the user receives. bps is an integer in
   * [0, 1000]; recipient and recipientName are both required when set.
   */
  readonly fee?: IntegratorFeeConfig;
  /** Rails an operator has taken out of rotation (`parseDisabledSources` format). */
  readonly disabledSources?: string;

  // ---- form initialisation ----
  /** The chain the form starts on, by its Mavna slug (e.g. "ethereum"). */
  readonly fromChain?: string;
  /** Whether the recipient receives USDC or XLM. A USDT0 send always lands as USDT0. */
  readonly wanted?: Wanted;
  /** What the form starts out sending. Defaults to USDC. */
  readonly fromAsset?: SendAsset;
  /** The amount the form starts with. */
  readonly fromAmount?: string;
  /** The recipient's Stellar address, pre-filled (locked with requiredUI). */
  readonly toAddress?: string;

  // ---- narrowing what the widget offers ----
  /** Chains the picker offers, filtered over the network's real chain list. */
  readonly chains?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  /** The rails to race and toggle. Defaults to all three. */
  readonly rails?: readonly RailName[];
  readonly hiddenUI?: readonly HiddenUIElement[];
  readonly requiredUI?: readonly RequiredUIElement[];

  // ---- integration ----
  /** Links for the header overflow ("...") menu. Empty or absent hides the menu.
      The integrator's own destinations (its site, docs, socials), kept as plain
      data so the config stays serialisable. */
  readonly menuLinks?: readonly MavnaMenuLink[];
  /** Namespaces this widget's local transfer history, so two integrators on one
      origin do not share it. */
  readonly keyPrefix?: string;
  readonly walletConfig?: WalletConfig;
  readonly onEvent?: (event: MavnaWidgetEvent) => void;
}

/** Where one network's Stellar node and sponsor live. */
export interface NetworkEndpoints {
  readonly rpcUrl?: string;
  readonly sponsorUrl?: string;
  /** The Arrival Contract on this network, in place of the deployed default. */
  readonly arrivalContract?: string;
}

/** One entry in the header overflow menu. */
export interface MavnaMenuLink {
  readonly label: string;
  readonly href: string;
  /** Opens in a new tab with `rel="noopener noreferrer"` when true. */
  readonly external?: boolean;
}

/** The config after defaults, split into what each part of the widget needs. */
export interface ResolvedConfig {
  readonly integrator: string;
  /** The networks the toggle offers, the active one among them. */
  readonly networks: readonly NetworkId[];
  readonly variant: Variant;
  readonly appearance: Appearance;
  readonly theme: WidgetTheme | undefined;
  readonly init: {
    readonly fromChain: string | undefined;
    readonly wanted: Wanted | undefined;
    readonly fromAmount: string | undefined;
    readonly toAddress: string | undefined;
    readonly fromAsset: SendAsset | undefined;
  };
  readonly rails: readonly RailName[];
  readonly hiddenUI: readonly HiddenUIElement[];
  readonly requiredUI: readonly RequiredUIElement[];
  readonly menuLinks: readonly MavnaMenuLink[];
  readonly keyPrefix: string | undefined;
  readonly walletConfig: WalletConfig | undefined;
  readonly onEvent: ((event: MavnaWidgetEvent) => void) | undefined;
  readonly engineConfig: EngineConfig;
}

const ALL_RAILS: readonly RailName[] = ["Circle", "Axelar", "LayerZero", "NEAR Intents"];

/** A configuration mistake, said at mount rather than when a user presses something. */
function configError(message: string): Error {
  return new Error(`Mavna widget configuration: ${message}`);
}

/** An endpoint as configured: absent is fine, empty is a mistake. */
function given(value: string | undefined, name: string, network: NetworkId): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw configError(`the ${network} ${name} is empty.`);
  return value;
}

/**
 * The node and sponsor for one network. The foundation runs no public mainnet
 * node, so mainnet's default is a third party's, the first of the measured
 * public list; an integrator should set their own before real money.
 */
function endpointsFor(
  config: MavnaWidgetConfig,
  network: NetworkId,
  defaultNetwork: NetworkId,
): { rpcUrl: string; sponsorUrl: string } {
  const own = config.endpoints?.[network];
  const isDefault = network === defaultNetwork;
  const rpcUrl =
    given(own?.rpcUrl, "rpcUrl", network) ??
    (isDefault ? given(config.rpcUrl, "rpcUrl", network) : undefined) ??
    (network === "mainnet" ? PUBLIC_MAINNET_RPC_URLS[0] : PUBLIC_TESTNET_RPC_URL);
  if (rpcUrl === undefined) throw configError(`no rpcUrl is known for ${network}.`);
  const sponsorUrl =
    given(own?.sponsorUrl, "sponsorUrl", network) ??
    (isDefault
      ? (given(config.sponsorUrl, "sponsorUrl", network) ?? "http://localhost:8787")
      : undefined);
  if (sponsorUrl === undefined) {
    throw configError(
      `${network} is offered but has no sponsorUrl in endpoints. A sponsor serves one network, ` +
        `so ${defaultNetwork}'s cannot stand in for it.`,
    );
  }
  return { rpcUrl, sponsorUrl };
}

/**
 * The config after defaults, for the network the widget is on. `active` is the
 * network the user switched to, or the configured one when omitted.
 */
export function resolveConfig(config: MavnaWidgetConfig, active?: NetworkId): ResolvedConfig {
  const defaultNetwork: NetworkId = config.network ?? "testnet";
  const networks = config.networks ?? [defaultNetwork];
  if (!networks.includes(defaultNetwork)) {
    throw configError(`network is ${defaultNetwork}, which networks does not offer.`);
  }
  const network = active ?? defaultNetwork;
  if (!networks.includes(network)) {
    throw configError(`${network} is not one of the networks offered.`);
  }
  // Every offered network is checked now, so a missing sponsor is a mistake at
  // mount and not a broken toggle later.
  for (const offered of networks) endpointsFor(config, offered, defaultNetwork);
  const endpoints = endpointsFor(config, network, defaultNetwork);
  const rails = config.rails ?? ALL_RAILS;
  return {
    integrator: config.integrator,
    networks,
    variant: config.variant ?? "compact",
    appearance: config.appearance ?? "system",
    theme: config.theme,
    init: {
      fromChain: config.fromChain,
      wanted: config.wanted,
      fromAmount: config.fromAmount,
      toAddress: config.toAddress,
      fromAsset: config.fromAsset,
    },
    rails,
    hiddenUI: config.hiddenUI ?? [],
    requiredUI: config.requiredUI ?? [],
    menuLinks: config.menuLinks ?? [],
    keyPrefix: config.keyPrefix,
    walletConfig: config.walletConfig,
    onEvent: config.onEvent,
    engineConfig: {
      network,
      rpcUrl: endpoints.rpcUrl,
      sponsorUrl: endpoints.sponsorUrl,
      disabledSources: config.disabledSources,
      ranking: config.routePriority ?? "best-received",
      integratorFee: config.fee,
      chains: config.chains,
      rails,
      stellar: config.walletConfig?.stellar,
      arrivalContract:
        config.endpoints?.[network]?.arrivalContract ??
        (network === defaultNetwork ? config.arrivalContract : undefined) ??
        ARRIVAL_CONTRACTS[network]?.contract,
      // keyPrefix namespaces the browser transfer history per integrator, and
      // the network per network: a record carries no network, and Activity
      // looks it up on the adapters of whichever network is showing.
      historyKey: config.keyPrefix
        ? `${config.keyPrefix}:mavna.transfers.v1.${network}`
        : `mavna.transfers.v1.${network}`,
    },
  };
}
