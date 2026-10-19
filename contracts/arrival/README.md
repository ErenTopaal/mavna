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
| testnet | `CACZ7BVNAE42AIL7DCQPUAMA6APM6GJG7VBDZ6O4UFK2TK5NAC7765MH` | `9d76f0b45fef9af36a4fd531a7f7e7d011deb4a98162a18f863d5954ef01f4a2` | test sender `GBNCXZUV...N2NB` with native XLM |

The testnet instance is a harness. No OFT is peered to Stellar testnet, so its
allowlisted sender is a key that queues compose messages on the real testnet
endpoint itself. It proves the endpoint queue, the Aquarius router and this
contract together; it does not prove an OFT's `lz_receive`. Mainnet is not
deployed: the contract goes through an independent audit first.

## Test

```sh
cd contracts
cargo test
```

The tests run against LayerZero's real endpoint wasm (`testdata/`, fetched from
testnet `CALTBA5S...`, byte-identical to mainnet's
`2411385509a00aeab0aed1236fb9cfa07106fbd8675232382bb15b6b07c704b9`).
