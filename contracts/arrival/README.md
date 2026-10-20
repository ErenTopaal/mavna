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
  deauthorised its trustline for good, or its trustline limit has no room for the amount). It stays
  queued and runs if the recipient ever can;
- a compose whose recipient is the Arrival Contract itself, which only a third party's message can
  name: the contract pays itself and the funds stay here.

Mavna's SDK never builds the second, third or fourth case: it refuses a recipient it cannot encode,
and checks when quoting and again when building that the recipient can hold both the arriving token
and the asset it wants. For any other recipient it can decode, the contract converts or delivers as
it came.

A trustline limit is the one refusal the contract cannot see before it swaps, because an asset
contract does not expose it. So the payout is attempted rather than assumed:

- the recipient refuses the converted amount: the output is swapped back through the same pools,
  holding the venue to its own estimate, and everything is delivered as it came. The recipient gets
  less than arrived by the venue's fees both ways. If the venue will not take it back, the call
  reverts and the compose stays queued until the recipient raises its limit;
- the integrator's fee account refuses the fee: the fee goes to the recipient, and if the recipient
  has no room for it either, it is swapped back and sent to the recipient as the arriving token. An
  integrator's account never holds up a user's funds;
- a fee account equal to the Arrival Contract is treated as no fee.

## Build

Reproducing the deployed bytes needs the exact toolchain, because the wasm records both:

- Rust 1.97.1 with the `wasm32v1-none` target, pinned in `contracts/rust-toolchain.toml`;
- stellar-cli 28.1.0 (commit `c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd`), which writes its own
  version into the wasm's `cliver` metadata, so any other version gives a different hash. Install it
  with `cargo install --locked stellar-cli --version 28.1.0`.

```sh
contracts/build.sh            # refuses any other stellar-cli; set STELLAR=/path/to/stellar if needed
```

To check a deployment against the source:

```sh
stellar contract fetch --id <contract> --network testnet -o deployed.wasm
shasum -a 256 deployed.wasm   # equals the hash build.sh prints for the same commit
```

The same commit built from a clean `git archive` in another directory gives the same hash.

## Deployments

| Network | Contract                                                   | Wasm sha256                                                        | Allowlist                                                                                                  |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| testnet | `CDAIQ522QK5AFCCVGENKVE7SDF6KRCDCAPRFGUWQ4GXO4NJZRVOHQN6X` | `66948b257be56b7c7d4ba4b853ad347e730eae4da37953fc919d1cc79b4a06ab` | test sender `GBNCXZUV...N2NB` with native XLM; converts into testnet USDC; may route through AQUA and USDT |

The testnet instance is a harness. No OFT is peered to Stellar testnet, so its allowlisted sender is
a key that queues compose messages on the real testnet endpoint itself. It proves the endpoint
queue, the Aquarius router and this contract together; it does not prove an OFT's `lz_receive`.
Mainnet is not deployed: the contract goes through an independent audit first.

## Before a mainnet deployment

What the constructor is given decides what the contract will ever trust, so on mainnet:

- Every listed token (each OFT's credited token, every asset it converts into, every path token)
  must be a Stellar asset contract, the built-in contract of a classic asset, whose code is the
  network's own. The contract calls `balance`, `authorized` and `transfer` on these tokens inside
  every compose; a custom token contract runs its own code there, with the executor's call above it.
- The OFT list must name the real USDT0 OFT on Stellar
  (`CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6`, crediting
  `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF`), read and checked from the OFT's own
  storage at the time of deployment, never a key. A key in that list can queue a compose with any
  `amount_ld` and be paid out of other arrivals waiting in the contract (see above).
- The Aquarius router is a trusted party, and so is whoever can upgrade it. The contract calls its
  `estimate_swap` and `swap_chained` with the arriving funds approved to it. The mainnet router
  `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK` exposes `commit_upgrade` and
  `apply_upgrade` for its `Admin`, read from its instance storage on 2026-10-20 as
  `GAV5FBMKD2ZF4X2MGWDNQYUP7KFL7MRM6HZBY7HKQLB4BRHSCCX5J6VS`, and `set_emergency_mode` for its
  `EmergencyAdmin`, `GCGZ6E5RBUKLNB4VZ5RC65C4QMBSBJ3COVRRJCWAMCXJC36LB7YYWEKM`. Either key, or a
  router upgraded by them, can change what a swap does with the funds it is given. The router's
  source was not reviewed here; check these roles again at deployment time.

Earlier testnet instances hold nothing and are not used. `CD5M6IBU...P35A` (`688456b0...6155`)
trapped when a trustline limit refused the payout, leaving the compose queued instead of delivering
it as it came. `CACZ7BVN...65MH` (`9d76f0b4...f4a2`) swapped without estimating first, and its
fallback failed on-chain whenever the swap reverted, because a rolled-back swap still costs ledger
writes that simulation does not predict. `CB4B235W...JS7F` (`47921dcd...d714`) did not treat a
trustline the issuer has not authorised as unable to hold the wanted asset. `CBSWBSEL...6252`
(`56e2acc5...e35f`) called any wanted asset or path token the message named, which let a hostile
token spend an executor's authorization; it had no lists of what it may convert into and route
through.
