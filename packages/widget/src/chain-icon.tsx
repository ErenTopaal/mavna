/*
 * The real network mark for a chain, in the design's circular avatar.
 *
 * Every logo is a bundled SVG compiled into a React component by @web3icons.
 * Nothing is fetched at render: the app is meant to be self-hostable, and an
 * avatar that reaches a CDN would leak which chain a user is looking at to a
 * third party and break entirely behind a firewall.
 *
 * A chain the icon set has never heard of gets a monogram in the same circle
 * rather than a logo we drew ourselves, because inventing a mark for someone
 * else's network puts a wrong claim about their brand in the interface.
 */
import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkArc from "@web3icons/react/icons/networks/NetworkArc";
import NetworkAvalanche from "@web3icons/react/icons/networks/NetworkAvalanche";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkCodex from "@web3icons/react/icons/networks/NetworkCodex";
import NetworkCronos from "@web3icons/react/icons/networks/NetworkCronos";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkHyperEvm from "@web3icons/react/icons/networks/NetworkHyperEvm";
import NetworkInjective from "@web3icons/react/icons/networks/NetworkInjective";
import NetworkInk from "@web3icons/react/icons/networks/NetworkInk";
import NetworkLinea from "@web3icons/react/icons/networks/NetworkLinea";
import NetworkMonad from "@web3icons/react/icons/networks/NetworkMonad";
import NetworkOptimism from "@web3icons/react/icons/networks/NetworkOptimism";
import NetworkPlume from "@web3icons/react/icons/networks/NetworkPlume";
import NetworkPolygon from "@web3icons/react/icons/networks/NetworkPolygon";
import NetworkSeiNetwork from "@web3icons/react/icons/networks/NetworkSeiNetwork";
import NetworkSolana from "@web3icons/react/icons/networks/NetworkSolana";
import NetworkSonic from "@web3icons/react/icons/networks/NetworkSonic";
import NetworkStarknet from "@web3icons/react/icons/networks/NetworkStarknet";
import NetworkStellar from "@web3icons/react/icons/networks/NetworkStellar";
import NetworkUnichain from "@web3icons/react/icons/networks/NetworkUnichain";
import NetworkWorld from "@web3icons/react/icons/networks/NetworkWorld";
import NetworkXdc from "@web3icons/react/icons/networks/NetworkXdc";
import NetworkXLayer from "@web3icons/react/icons/networks/NetworkXLayer";
import type { ReactElement } from "react";
import { s } from "./style";

/**
 * A test network wears its parent's logo.
 *
 * The registry keys Sepolia, Fuji, Amoy, Apothem, Hoodi and Devnet as separate
 * chains, and they are, but Base Sepolia is still Base to anyone looking at the
 * list. Stripping the suffix means a new test network of a chain we already
 * cover arrives with its logo already right.
 */
const TESTNET_SUFFIX = /-(sepolia|testnet|devnet|fuji|amoy|apothem|hoodi)$/;

/**
 * The shape every icon in the set shares.
 *
 * Taken from one of the icons rather than imported from the package root,
 * because the root barrel re-exports several thousand token components and
 * naming a type through it drags all of them into the type graph.
 */
export type NetworkIcon = typeof NetworkEthereum;

/** The chain id the icon is keyed on, which is the mainnet one. */
export function baseChainId(chainId: string): string {
  return chainId.replace(TESTNET_SUFFIX, "");
}

/*
 * Our chain ids are Circle's; the icon set has its own. The pairs below were
 * checked against @web3icons/common's network metadata by EVM chain id rather
 * than by name, so "sei" reaching NetworkSeiNetwork and "world-chain" reaching
 * NetworkWorld are matches on 1329 and 480, not on a resemblance between words.
 *
 * Absent on purpose: morph, edge and pharos have no icon in this set, and the
 * one thing that looks close (NetworkEdgeless, chain 2026) is a different
 * network from Edge. They take the monogram.
 */
const ICONS: Readonly<Record<string, NetworkIcon>> = {
  arbitrum: NetworkArbitrumOne,
  arc: NetworkArc,
  avalanche: NetworkAvalanche,
  base: NetworkBase,
  codex: NetworkCodex,
  cronos: NetworkCronos,
  ethereum: NetworkEthereum,
  hyperevm: NetworkHyperEvm,
  injective: NetworkInjective,
  ink: NetworkInk,
  linea: NetworkLinea,
  monad: NetworkMonad,
  optimism: NetworkOptimism,
  plume: NetworkPlume,
  polygon: NetworkPolygon,
  sei: NetworkSeiNetwork,
  solana: NetworkSolana,
  sonic: NetworkSonic,
  starknet: NetworkStarknet,
  stellar: NetworkStellar,
  unichain: NetworkUnichain,
  "world-chain": NetworkWorld,
  "x-layer": NetworkXLayer,
  xdc: NetworkXdc,
};

/** The logo component for a chain, or undefined where the set has none. */
export function chainIconFor(chainId: string): NetworkIcon | undefined {
  return ICONS[baseChainId(chainId)];
}

/*
 * Words that say "which network" rather than "which chain", dropped before the
 * initials are taken. Without this, morph-hoodi reads as MH and Edge Testnet as
 * ET, which is a monogram for the deployment instead of for the chain.
 */
const FILLER: ReadonlySet<string> = new Set([
  "mainnet",
  "testnet",
  "network",
  "chain",
  "sepolia",
  "fuji",
  "amoy",
  "apothem",
  "hoodi",
  "devnet",
]);

/** Initials for a chain with no logo: one per word, or two from a lone word. */
export function chainMonogram(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "" && !FILLER.has(word.toLowerCase()));
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "").slice(0, 1)}${(words[1] ?? "").slice(0, 1)}`.toUpperCase();
}

export interface ChainIconProps {
  readonly chainId: string;
  readonly name: string;
  readonly size: number;
}

/**
 * The avatar itself.
 *
 * The logo is drawn at the full width of the circle rather than inset, because
 * these marks are the "background" variant: the brand's own ground with the mark
 * on top. That is the one variant legible on this interface whatever the brand
 * is, since Linea, Sonic, World Chain and X Layer all draw their logo in solid
 * black and would vanish on a dark row. Letting it bleed under the 1px ring
 * leaves no seam between the logo and the border.
 *
 * Decorative: every place this appears already names the chain in text next to
 * it, so a screen reader saying it twice would only be noise.
 */
export function ChainIcon({ chainId, name, size }: ChainIconProps): ReactElement {
  const Icon = chainIconFor(chainId);
  return (
    <span
      aria-hidden="true"
      style={s(
        // The ring is an inset shadow, not a border: a 1px border under
        // box-sizing:border-box shrinks the content box by 2px, so the logo drawn
        // at the full size overflows and the clip lands off-centre. An inset
        // shadow draws the ring over the edge without touching the box, so the
        // mark sits dead centre. block ensures no baseline gap under the svg.
        `display:block;width:${size}px;height:${size}px;flex:0 0 auto;position:relative;border-radius:999px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--mv-rule);color:var(--mv-ink-2)`,
      )}
    >
      {Icon === undefined ? (
        <span
          style={s(
            `position:absolute;inset:0;display:grid;place-items:center;font-family:var(--mv-font-mono);font-size:${Math.round(size * 0.34)}px;font-weight:500;letter-spacing:0.02em;line-height:1`,
          )}
        >
          {chainMonogram(name)}
        </span>
      ) : (
        <Icon variant="background" size={size} style={{ display: "block" }} />
      )}
    </span>
  );
}
