# Mavna Arrival Contract

Receives a LayerZero OFT transfer that carries a compose message and completes Mavna's arrival steps
in the same flow: convert through Aquarius with the user's minimum as a hard floor, take the
itemised integrator fee, send the result to the recipient the user signed for, or send the arriving
token as it came when the floor cannot be met. No administrator and no upgrade path.

## What it accepts and calls

Fixed at construction, never changeable: the OFTs it accepts (each with the token it credits), the
assets it converts into, and the further tokens a conversion may route through, plus the Aquarius
router. A message naming anything else is delivered as it came, without the contract calling the
unknown token. Paths are capped at four hops of three tokens and the integrator fee at 1000 bps. A
different list means a new deployment.

Each allowlisted OFT is trusted for the amount its compose message states (`amount_ld`): the
contract pays out that amount rather than measuring what was credited. LayerZero's stock OFT states
exactly what it credited. An OFT, or an upgrade of one, that overstated it would be paid out of
other arrivals still waiting in the contract.

## When it holds funds

LayerZero on Stellar credits the contract in one transaction and runs the compose step in a later
one, so each arrival sits in the contract between the two. Normally that is a ledger or two; it
lasts until someone (LayerZero's executor, or anyone finishing an overdue delivery) runs the step.
While it waits it can only go to the recipient named in the signed message.

There is no administrator, so nothing can rescue funds the step can never deliver. These strand for
good, and this is an accepted consequence of having no admin:

- tokens sent to the contract without a compose message (a plain OFT send to its address, or a
  direct transfer);
- a compose message written by a third party whose recipient cannot be decoded;
- a compose whose recipient can never receive the arriving token (for example, the issuer has
  deauthorised its trustline for good). It stays queued and runs if the recipient ever can.

Mavna's SDK never builds the second or third case: it refuses a recipient it cannot encode, and
checks when quoting and again when building that the recipient can hold both the arriving token and
the asset it wants. For any recipient it can decode, the contract converts or delivers as it came.

## Build

The toolchain is pinned in `contracts/rust-toolchain.toml` (Rust 1.97.1, `wasm32v1-none`).
soroban-sdk 29 needs stellar-cli 25.2 or later; the hashes below were produced with stellar-cli
28.1.0.

```sh
cd contracts
stellar contract build
shasum -a 256 target/wasm32v1-none/release/mavna_arrival.wasm
```

Building the same commit from a different directory gives the same hash, and
`stellar contract fetch --id <contract> --network testnet` returns the deployed bytes to compare
against.

## Deployments

| Network | Contract                                                   | Wasm sha256                                                        | Allowlist                                     |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| testnet | `CBSWBSELNYEDXQHO4JDXYJ7HFMTSBLVHAKIQ6KFC2NYZUT5PHDSI6252` | `56e2acc5c2bfe41ff931f00df2e6092ff658e8933c1e313537faa26a1296e35f` | test sender `GBNCXZUV...N2NB` with native XLM |

The testnet instance is a harness. No OFT is peered to Stellar testnet, so its allowlisted sender is
a key that queues compose messages on the real testnet endpoint itself. It proves the endpoint
queue, the Aquarius router and this contract together; it does not prove an OFT's `lz_receive`.
Mainnet is not deployed: the contract goes through an independent audit first.

Earlier testnet instances hold nothing and are not used. `CACZ7BVN...65MH` (`9d76f0b4...f4a2`)
swapped without estimating first, and its fallback failed on-chain whenever the swap reverted,
because a rolled-back swap still costs ledger writes that simulation does not predict.
`CB4B235W...JS7F` (`47921dcd...d714`) did not treat a trustline the issuer has not authorised as
unable to hold the wanted asset.
