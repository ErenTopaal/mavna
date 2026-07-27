import type { NetworkId } from "@mavna/core";

/**
 * Circle's deployment, verified on-chain rather than copied from documentation.
 *
 * Every testnet address here was confirmed live by reading the contract instance
 * from the ledger. That check exists because a previous draft of this project
 * carried a bridge's addresses that had been dead for months.
 */

export interface CctpNetworkConfig {
  readonly tokenMessengerMinter: string;
  readonly messageTransmitter: string;
  /**
   * The contract that receives the mint and forwards it on. Both `mintRecipient`
   * and `destinationCaller` on the burn must be set to this, and any other value
   * strands the funds permanently.
   */
  readonly cctpForwarder: string;
  readonly usdcIssuer: string;
  readonly usdcContract: string;
  readonly irisBaseUrl: string;
}

export const CCTP_CONTRACTS: Readonly<Record<NetworkId, CctpNetworkConfig>> = {
  testnet: {
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    irisBaseUrl: "https://iris-api-sandbox.circle.com",
  },
  mainnet: {
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    cctpForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    usdcContract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    irisBaseUrl: "https://iris-api.circle.com",
  },
};

/**
 * Circle's domain identifiers, which are NOT chain ids and must never be confused
 * with them. Measured against the live fee service rather than transcribed: every
 * one of these was confirmed to route into Stellar on both networks.
 *
 * BNB Smart Chain (17) is documented by Circle as supported but is NOT routable
 * to Stellar, which is why it is absent.
 */
export const CCTP_DOMAINS: Readonly<Record<number, string>> = {
  0: "Ethereum",
  1: "Avalanche",
  2: "OP Mainnet",
  3: "Arbitrum",
  5: "Solana",
  6: "Base",
  7: "Polygon PoS",
  10: "Unichain",
  11: "Linea",
  12: "Codex",
  13: "Sonic",
  14: "World Chain",
  15: "Monad",
  16: "Sei",
  18: "XDC",
  19: "HyperEVM",
  21: "Ink",
  22: "Plume",
  25: "Starknet",
  26: "Arc",
  28: "EDGE",
  29: "Injective",
  30: "Morph",
  31: "Pharos",
  32: "Cronos",
  37: "X Layer",
};

/** Stellar's own domain. Fetched rather than guessed, and identical on both networks. */
export const STELLAR_DOMAIN = 27;

export type CctpDomain = keyof typeof CCTP_DOMAINS;

export function stellarDomainFor(_network: NetworkId): number {
  return STELLAR_DOMAIN;
}

export function IRIS_BASE_URL(network: NetworkId): string {
  return CCTP_CONTRACTS[network].irisBaseUrl;
}

/**
 * USDC's decimals on every chain a burn starts from.
 *
 * Six, everywhere, and verified rather than assumed: the EVM sweep asks each
 * token whether it agrees it is USDC with six decimals and drops any chain that
 * says otherwise, and the Solana and Starknet scripts check the same thing
 * against their own registries. Stellar's seven is a separate number and is
 * handled at the delivery boundary, not here.
 */
export const USDC_SOURCE_DECIMALS = 6;

/**
 * A base-unit integer as a person would read it.
 *
 * Used in the sentences a user is shown before signing. "5000000 USDC base
 * units" is the machine's number, and a signature is consent, which needs the
 * amount to be one the signer recognises as the amount they typed.
 *
 * String arithmetic throughout. A float here would round the very figure the
 * user is being asked to agree to.
 */
export function readableUsdc(baseUnits: bigint): string {
  const scale = 10n ** BigInt(USDC_SOURCE_DECIMALS);
  const negative = baseUnits < 0n;
  const value = negative ? -baseUnits : baseUnits;
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(USDC_SOURCE_DECIMALS, "0")
    .replace(/0+$/, "");
  const text = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}
