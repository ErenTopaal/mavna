# Mavna Arrival Contract

Receives a LayerZero OFT transfer that carries a compose message and completes Mavna's arrival steps
in the same flow: convert through Aquarius with the user's minimum as a hard floor, take the
itemised integrator fee, send the result to the recipient the user signed for, or send the arriving
token as it came when the floor cannot be met. No administrator and no upgrade path. A compose that
still cannot complete a week after anyone notes it can be delivered as it came by anyone.

## What it accepts and calls

Fixed at construction, never changeable: the OFTs it accepts (each with the token it credits), the
assets it converts into (each with the largest arriving amount it converts into that asset), and the
further tokens a conversion may route through, plus the Aquarius router. A message naming anything
else is delivered as it came, without the contract calling the unknown token. Paths are capped at
four hops of three tokens and the integrator fee at 1000 bps. A different list means a new
deployment.

The largest conversion per asset exists because the network caps what one transaction may spend
(400M instructions on mainnet), and running out of that budget aborts the whole call where no `try_`
call can catch it: the compose stays queued, and every retry fails the same way. A large swap
through a concentrated pool crosses many ticks and costs accordingly. Above the limit the contract
never calls the venue and delivers the arriving token as it came. The mainnet limits were set on a
fork of mainnet's own router and pools (`src/test/fork.rs`, against `testdata/mainnet-fork.txt`,
ledger 65065926), running this wasm:

| Into | Largest conversion | Instructions used    | With a position at every tick spacing crossed |
| ---- | ------------------ | -------------------- | --------------------------------------------- |
| XLM  | 50,000 USDT0       | 83M (21% of the cap) | 140M (35%)                                    |
| USDC | 250,000 USDT0      | 27M (7%)             | 27M (7%): the pool's liquidity sits at peg    |

Anyone can add tiny positions at every tick spacing a swap would cross, which costs them dust and
rent and adds about 4M instructions per spacing crossed; on the same fork that pushed 200,000 USDT0
into XLM from 182M to 455M. The limits leave room for that and for the pools thinning out. A pool
state that a limit cannot cover (liquidity withdrawn and the range fragmented) is what the overdue
delivery below is for. Mavna's SDK also declines a conversion above the limit, and one whose
simulated router estimates project past 40% of the cap, so neither is offered.

Each allowlisted OFT is trusted for the amount its compose message states (`amount_ld`): the
contract pays out that amount rather than measuring what was credited, and refuses a negative one.
An OFT, or an upgrade of one, that overstated it would be paid out of other arrivals still waiting
in the contract. The mainnet USDT0 OFT is not LayerZero's stock build: it is an Everdawn Labs build
(`everdawn-oft`, soroban-sdk 25.1.1, wasm sha256
`c1e1fce3259166b6bc17ff0085319bb7a312cb4d4ab1dded98e60ae32a43a7ca` on 2026-10-21) whose source is
not public. Its entry points match LayerZero's oft-app, and LayerZero's published oft-core sets
`amount_ld` to what its credit returned, which for a MintBurn OFT is the amount minted. That is the
behaviour this contract relies on, checked from LayerZero's code and the deployed interface, not
from Everdawn's source. `scripts/arrival-mainnet.mjs` pins that wasm hash and fails if the OFT runs
anything else.

## When it holds funds

LayerZero on Stellar credits the contract in one transaction and runs the compose step in a later
one, so each arrival sits in the contract between the two. Normally that is a ledger or two; it
lasts until someone (LayerZero's executor, or anyone finishing an overdue delivery) runs the step.
While it waits it can only go to the recipient named in the signed message.

There is no administrator, so nothing can rescue funds that no compose names. These strand for good,
and this is an accepted consequence of having no admin:

- tokens sent to the contract without a compose message (a plain OFT send to its address, or a
  direct transfer);
- a compose message written by a third party whose recipient cannot be decoded;
- a compose whose recipient is the Arrival Contract itself, which only a third party's message can
  name: the contract pays itself and the funds stay here.

A compose whose recipient can never receive the arriving token (the issuer has deauthorised its
trustline for good, or its trustline limit has no room for the amount) stays queued and runs if the
recipient ever can.

Mavna's SDK never builds any of these: it refuses a recipient it cannot encode, and checks when
quoting and again when building that the recipient can hold both the arriving token and the asset it
wants. For any other recipient it can decode, the contract converts or delivers as it came.

### Overdue delivery

A compose the conversion cannot complete (the venue traps, the swap would exceed the budget in a
pool state the limits did not foresee, or the recipient refuses a converted payout the venue will
not take back) would otherwise wait for conditions to change. So anyone can:

1. `note(from, guid, index, message)`: records the current ledger for a compose the endpoint still
   holds for this contract with exactly these bytes, from an OFT on the list. Anything else is
   refused (`NotQueued`, `NotAllowlisted`), so the storage holds only real waiting composes, one
   entry each. Noting again keeps the first ledger.
2. `deliver_overdue(from, guid, index, message)`, once `OVERDUE_AFTER_LEDGERS` (120,960 ledgers, 7
   days at 5 seconds) have passed since the note: clears the compose on the endpoint exactly as
   `lz_compose` does, then sends the arriving token, exactly the message's `amount_ld`, to the
   message's own recipient, with no venue call, and publishes the same `arrival` event with outcome
   `as_came`.

Both paths spend the endpoint's slot through `clear_compose`, which compares the message's hash and
then marks the slot received, so a compose is paid once, by whichever runs first. Completing a
compose either way removes its note. Seven days is far past any normal run (LayerZero's executor
runs a compose within seconds of the credit; the sponsor and the sender can finish one at any time)
and long enough to outlast an outage of the venue. Forcing an as-came delivery early is already
possible for anyone by moving the pool past the minimum in the same transaction (see "Who runs a
compose" below), so the delay gives an attacker nothing new.

Nobody needs a key with any standing to run it; any funded account pays the fee:

```sh
stellar contract invoke --id <contract> --source-account <any funded key> --network mainnet -- \
  note --from <oft> --guid <guid hex> --index 0 --message <queued message hex>
# seven days later
stellar contract invoke --id <contract> --source-account <any funded key> --network mainnet -- \
  deliver_overdue --from <oft> --guid <guid hex> --index 0 --message <queued message hex>
```

The queued message is what the OFT's `lz_receive` passed to the endpoint's `send_compose`; Mavna's
status reader rebuilds it from LayerZero's record and checks it against the endpoint's hash (the
`finish` it hands out carries it).

### What the issuer of the arriving token can do

Every waiting arrival sits in one balance of the arriving token, owned by the contract, and each
compose pays its own `amount_ld` out of it. On mainnet that token is USDT0
(`USDT0:GATISXX6...HN6Q`), whose issuer has `auth_revocable` and `auth_clawback_enabled` set. Its
asset contract's admin is LayerZero's SAC manager `CA3GUWLO...YWGJ`, whose `clawback`,
`set_authorized` and `set_admin` are each held by a role (`CLAWBACK_ROLE`, `BLACKLISTER_ROLE`,
`ADMIN_MANAGER_ROLE`), granted by its owner, the three-signature multisig `CBCZ5CET...QKR6` that
also owns the OFT. On 2026-10-21 only `MINTER_ROLE` had a member (the OFT), and the issuer account's
only signer had weight 0, so the issuer cannot claw back around the manager.

If the owner ever grants those roles:

- a clawback of the contract's balance is not tied to any arrival: it is taken from whichever
  pending compose runs last, which then fails for lack of funds (and so does its overdue delivery).
  A clawback aimed at one user's arrival is paid by another user;
- `set_authorized(contract, false)` freezes every waiting arrival until it is reversed.

The contract cannot limit this cheaply. It learns of an arrival only when its compose runs (the OFT
credits it without telling it), so it has no per-arrival ledger to check a payout against, and its
balance covering one compose says nothing about whose tokens they are. Keeping arrivals pending as
briefly as possible is what narrows the exposure. `scripts/arrival-mainnet.mjs` prints the manager's
roles and members and refuses to pass while any of the three roles has a member, or the issuer can
still sign. Circle's USDC, held only briefly inside a conversion, is revocable but not
clawback-enabled.

### A payout the recipient refuses

A trustline limit is the one refusal the contract cannot see before it swaps, because an asset
contract does not expose it. So the payout is attempted rather than assumed:

- the recipient refuses the converted amount: the output is swapped back through the same pools and
  everything is delivered as it came. The recipient gets less than arrived by the venue's fees both
  ways. If the venue will not take it back, the call reverts and the compose stays queued until the
  recipient raises its limit;
- the integrator's fee account refuses the fee: the fee goes to the recipient, and if the recipient
  has no room for it either, it is swapped back and sent to the recipient as the arriving token. The
  integrator's account alone never holds up a user's funds. But when the recipient has room for the
  net amount and not for the fee, and the venue will not take the fee back (a fee so small the
  venue's estimate for it is zero), the call reverts and the compose stays queued until the
  recipient raises its limit;
- a fee account equal to the Arrival Contract is treated as no fee.

A swap back is held to the arrival's own forward rate, not only to the venue's estimate: what comes
back must be at least the arriving amount the forward swap took for that much output, less 200 bps
per hop (both directions of Aquarius's highest fee tier, 1%), or the call reverts and the compose
stays queued. So a router that turned hostile can keep at most that allowance of a swap back (4% on
the two-hop path into XLM), on top of what the forward floor already bounds; it cannot keep the
converted amount.

## Who runs a compose, and what slippage it exposes

`lz_compose` is open to any executor, because LayerZero's hosted executor must be able to call it
and a stuck compose must be finishable by anyone. The executor cannot change the message (the
endpoint checks its hash), so it cannot change the recipient, the asset, the minimum or the fee. It
can choose when to run it and what else runs in the same transaction: a contract can move the pool,
run the compose as its own executor (it is the direct invoker, so it needs no signature), and move
the pool back. That takes at most the gap between the quote and the signed minimum. The SDK signs
the minimum at the quote less 20 bps (`COMPOSE_MAX_SLIPPAGE_BPS`) and tells the user to expect the
minimum. Proven in `src/test/integrations.rs`: on a 1,000,000/1,000,000 constant-product pool, a
100,000 USDT0 arrival paid the user exactly the minimum and the attacker kept 212 USDT0; a little
more skew makes it deliver as it came instead, at the attacker's cost of 6.3 USDT0 in pool fees.

## Storage lifetime

The contract stores its configuration in instance storage and extends the instance and its code to
30 days whenever fewer than 15 remain, on every compose, note and overdue delivery. Mainnet's
minimum lifetime for a new persistent entry is about 120 days (2,073,600 ledgers), so a fresh
instance starts with more than the top-up, and the top-up only starts once that has run down. The
same 15 and 30 days are mirrored by the SDK's finish-cost estimate (`ARRIVAL_TTL_THRESHOLD`,
`ARRIVAL_TTL_EXTEND_TO`) and the sponsor's daily keep-alive (`KEEP_ALIVE_LEDGERS`). An archived
instance, balance or note is restored, not lost.

## Build

Reproducing the deployed bytes needs the exact toolchain, because the wasm records both:

- Rust 1.99.1 with the `wasm32v1-none` target, pinned in `contracts/rust-toolchain.toml`;
- stellar-cli 28.1.0 (commit `c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd`), which writes its own
  version into the wasm's `cliver` metadata, so any other version gives a different hash. Install it
  with `cargo install --locked stellar-cli --version 28.1.0`.

```sh
contracts/build.sh            # refuses any other stellar-cli; set STELLAR=/path/to/stellar if needed
```

`testdata/mavna_arrival.wasm` is a copy of that build, which the budget tests in `src/test/fork.rs`
run; `scripts/check-arrival-wasm.sh` fails if it or the build differs from the testnet row below.

To check a deployment against the source:

```sh
stellar contract fetch --id <contract> --network testnet -o deployed.wasm
shasum -a 256 deployed.wasm   # equals the hash build.sh prints for the same commit
```

The same commit built from a clean `git archive` in another directory gives the same hash.

## Deployments

| Network | Contract                                                   | Wasm sha256                                                        | Allowlist                                                                                                                                 |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| testnet | `CDHHLRLKWNRMRQ2PPT7CNMWG3OF4XOIQ2QTDEBMZ25CJQCLQK7Y5PMPD` | `d8cc3923a6605ada3ad761f2f0545a15dc7b0715bbd4ce8a93caef6267acf9a6` | test sender `GBNCXZUV...N2NB` with native XLM; converts at most 10,000 XLM into testnet USDC per arrival; may route through AQUA and USDT |

The testnet instance is a harness. No OFT is peered to Stellar testnet, so its allowlisted sender is
a key that queues compose messages on the real testnet endpoint itself. It proves the endpoint
queue, the Aquarius router and this contract together; it does not prove an OFT's `lz_receive`. Its
10,000 XLM limit is a harness value: testnet's routes into USDC estimated at 21M instructions or
less at every size measured, from 10 to 1,000,000 XLM. Deployed 2026-10-21 (upload
`ed705833...8e43`, deploy `e8c7be18...49e8`); a conversion (`62b9690c...f610`, noted first, the note
removed by the compose) and an as-came delivery (`2b79c66e...7eaf`) ran through it the same day.
Mainnet is not deployed yet. It is deployed with the lists and commands under "Deploying" below,
signed by the owner's mainnet key.

## Before a mainnet deployment

What the constructor is given decides what the contract will ever trust, so on mainnet:

- Every listed token (each OFT's credited token, every asset it converts into, every path token)
  must be a Stellar asset contract, the built-in contract of a classic asset, whose code is the
  network's own. The contract calls `balance`, `authorized` and `transfer` on these tokens inside
  every compose; a custom token contract runs its own code there, with the executor's call above it.
- The OFT list must name the real USDT0 OFT on Stellar
  (`CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6`, crediting
  `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF`), read and checked from mainnet at the
  time of deployment, never a key. A key in that list can queue a compose with any `amount_ld` and
  be paid out of other arrivals waiting in the contract (see above). The OFT is `MintBurn` through
  the SAC manager above, so the check reads the token it actually mints, the manager's
  `underlying_sac`, not only the OFT's own `Token`.
- Nobody may hold a role on that manager that can claw back, freeze or reassign the token (see "What
  the issuer of the arriving token can do"). The manager's owner can still grant them later.
- The Aquarius router is a trusted party, and so is whoever can upgrade it. The contract calls its
  `estimate_swap` and `swap_chained` with the arriving funds approved to it. The mainnet router
  `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK` exposes `commit_upgrade` and
  `apply_upgrade` for its `Admin`, read from its instance storage on 2026-10-21 as
  `GAV5FBMKD2ZF4X2MGWDNQYUP7KFL7MRM6HZBY7HKQLB4BRHSCCX5J6VS`, and `set_emergency_mode` for its
  `EmergencyAdmin`, `GCGZ6E5RBUKLNB4VZ5RC65C4QMBSBJ3COVRRJCWAMCXJC36LB7YYWEKM`. A router turned
  hostile can keep at most the user's slippage on the forward swap and the round-trip allowance on a
  swap back; it can also refuse every conversion, which delivers as it came. The router's source was
  not reviewed here; check these roles again at deployment time.

### The mainnet lists

Read from mainnet on 2026-10-21 and held in `scripts/arrival-mainnet.mjs`:

| Argument      | Value                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`    | `CCQLLRE5JBAWYCW3KTWOIWLMFDUOKROQVZNSALQMGOSXNW3ERUOWTZGK`, LayerZero's Stellar endpoint, id 30600                          |
| `router`      | `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`, Aquarius                                                        |
| `ofts`        | the USDT0 OFT `CBOWOLFS...MMF6`, crediting USDT0's asset contract `CBSJZEIO...26YF`                                         |
| `wanted`      | Circle USDC's asset contract `CCW67TSZ...MI75`, at most 250,000 USDT0; native XLM's `CAS3J7GY...OWMA`, at most 50,000 USDT0 |
| `path_tokens` | Circle USDC's asset contract `CCW67TSZ...MI75`                                                                              |

Aquarius's quoting service routes USDT0 through Yield USDT (`CCOVLDJC...B6F6G`), which is a custom
token contract with its own admin, so it is not listed. The router's own USDT0/USDC pool converts
into USDC in one hop and into XLM through USDC, which is why USDC is a path token as well as a
wanted asset: the SDK passes only `path_tokens` as the tokens a quote may route through. The OFT's
owner is `CBCZ5CET...QKR6`, a three-signature LayerZero multisig contract.

### Deploying

Build with `contracts/build.sh` and confirm it prints the testnet row's hash: the same bytes are
deployed on every network. Then check the lists against mainnet as it is at that moment (read-only):

```sh
pnpm --filter @mavna/swap --filter @mavna/adapter-layerzero build
node scripts/arrival-mainnet.mjs --wasm=<built wasm> --source=<deployer key name> --payer=<deployer address>
```

It exits non-zero on any failed check, prints the upload's resource fee simulated from the payer,
and ends with the two commands to sign: `stellar contract upload`, then `stellar contract deploy`
with the constructor arguments above. Any funded mainnet key can sign them; the contract has no
admin, so the key holds no power over it afterwards. Measured on 2026-10-21 (ledger 65066177): the
upload's resource fee simulates at 32.255 XLM (the previous build, 15,059 bytes against this build's
20,978, simulated at 24.114 XLM the same way). The deploy cannot be simulated before the code is on
mainnet; this build's deploy cost 0.060 XLM in resource fee on testnet, whose fee rates are about
half of mainnet's (the same upload was 16.787 XLM there against 32.255 on mainnet), so expect about
0.12 XLM. The key needs about 33.4 XLM including its 1 XLM minimum balance, plus headroom if fees
rise. Afterwards, check the instance:

```sh
node scripts/arrival-mainnet.mjs --wasm=<built wasm> --contract=<new contract id>
```

Earlier testnet instances hold nothing and are not used. `CBBT5762...7XQ` (`468af775...db7b`) is the
build the 2026-10-21 audit reviewed: it had no largest conversion, so a large conversion into XLM
could exceed the budget and stay queued for good, no overdue delivery, a swap back held only to the
router's own estimate, and it accepted a negative `amount_ld`. `CDAIQ522...QN6X` (`66948b25...06ab`)
is the same source as `CBBT5762` built with Rust 1.97.1, replaced when the toolchain moved to
1.99.1, which changes the bytes. `CD5M6IBU...P35A` (`688456b0...6155`) trapped when a trustline
limit refused the payout, leaving the compose queued instead of delivering it as it came.
`CACZ7BVN...65MH` (`9d76f0b4...f4a2`) swapped without estimating first, and its fallback failed
on-chain whenever the swap reverted, because a rolled-back swap still costs ledger writes that
simulation does not predict. `CB4B235W...JS7F` (`47921dcd...d714`) did not treat a trustline the
issuer has not authorised as unable to hold the wanted asset. `CBSWBSEL...6252` (`56e2acc5...e35f`)
called any wanted asset or path token the message named, which let a hostile token spend an
executor's authorization; it had no lists of what it may convert into and route through.
