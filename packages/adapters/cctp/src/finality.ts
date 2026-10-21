/**
 * How long Circle takes to attest a standard burn, by source domain.
 *
 * From Circle's "CCTP Transfer Finality by Source Chain" table
 * (developers.circle.com/cctp/required-block-confirmations, read 21 October 2026),
 * taking the slow end of each average: a quote that says five minutes for a burn
 * that waits out Ethereum's finality has someone watching a spinner for three
 * times as long as they were told. Testnets share their mainnet's figure; a
 * Sepolia burn was measured at well over fifteen minutes.
 *
 * Sub-second figures round up to one second.
 */
const STANDARD_SECONDS: Readonly<Record<number, number>> = {
  0: 19 * 60, // ethereum
  1: 8, // avalanche
  2: 19 * 60, // op mainnet
  3: 19 * 60, // arbitrum
  5: 25, // solana
  6: 19 * 60, // base
  7: 8, // polygon pos
  10: 19 * 60, // unichain
  11: 32 * 3600, // linea
  12: 19 * 60, // codex
  13: 8, // sonic
  14: 19 * 60, // world chain
  15: 5, // monad
  16: 5, // sei
  18: 10, // xdc
  19: 5, // hyperevm
  21: 30 * 60, // ink
  22: 19 * 60, // plume
  25: 4 * 3600, // starknet
  26: 1, // arc
  28: 21 * 60, // edge
  29: 1, // injective
  30: 30 * 60, // morph
  31: 7, // pharos
  32: 1, // cronos
  37: 19 * 60, // x layer
};

export function standardAttestationSeconds(domain: number): number {
  const seconds = STANDARD_SECONDS[domain];
  if (seconds === undefined) {
    throw new Error(`No published standard attestation time for CCTP domain ${domain}.`);
  }
  return seconds;
}
