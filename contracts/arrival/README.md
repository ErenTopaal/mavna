# Mavna Arrival Contract

Receives a LayerZero OFT transfer that carries a compose message and completes
Mavna's arrival steps in the same flow: convert through Aquarius with the user's
minimum as a hard floor, take the itemised integrator fee, send the result to the
recipient the user signed for, or send the arriving token as it came when the floor
cannot be met. No administrator, no upgrade path, nothing held between transfers.

## Build

The toolchain is pinned in `contracts/rust-toolchain.toml` (Rust 1.97.1,
`wasm32v1-none`). soroban-sdk 29 needs stellar-cli 25.2 or later; the hashes below
were produced with stellar-cli 28.1.0.

```sh
cd contracts
stellar contract build
shasum -a 256 target/wasm32v1-none/release/mavna_arrival.wasm
```

Building the same commit from a different directory gives the same hash, and
`stellar contract fetch --id <contract> --network testnet` returns the deployed
bytes to compare against.

## Deployments

| Network | Contract | Wasm sha256 | Allowlist |
| --- | --- | --- | --- |
| testnet | `CB4B235WXWSGKVKBYD7H3QKUWYQE2B4DXH7U42B67M4ZP2K4KWNCJS7F` | `47921dcdba974b2af1d0bbb99ceef4518858c646a55f13f7972ad40e1dcdd714` | test sender `GBNCXZUV...N2NB` with native XLM |

The testnet instance is a harness. No OFT is peered to Stellar testnet, so its
allowlisted sender is a key that queues compose messages on the real testnet
endpoint itself. It proves the endpoint queue, the Aquarius router and this
contract together; it does not prove an OFT's `lz_receive`. Mainnet is not
deployed: the contract goes through an independent audit first.

An earlier testnet instance, `CACZ7BVN...65MH` (`9d76f0b4...f4a2`), swapped
without estimating first. Its fallback path failed on-chain whenever the swap
reverted, because a rolled-back swap still costs ledger writes that simulation
does not predict. It holds nothing and is not used.

## Test

```sh
cd contracts
cargo test
```

The tests run against LayerZero's real endpoint wasm (`testdata/`, fetched from
testnet `CALTBA5S...`, byte-identical to mainnet's
`2411385509a00aeab0aed1236fb9cfa07106fbd8675232382bb15b6b07c704b9`).
