//! The ca-integrations audit's tests (2026-10-21): the permissionless executor
//! sandwich (I1), clawback and freeze of the pooled balance, and properties.

use super::*;
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};

// constant product pool with a 30 bps fee, reserves are the venue's own balances
#[contract]
pub struct CpVenue;

fn cp_out(r_in: i128, r_out: i128, a: i128) -> i128 {
    a * 9_970 * r_out / (r_in * 10_000 + a * 9_970)
}

#[contractimpl]
impl CpVenue {
    pub fn estimate_swap(
        env: Env,
        _tokens: Vec<Address>,
        token_in: Address,
        token_out: Address,
        _pool_index: BytesN<32>,
        in_amount: u128,
    ) -> u128 {
        let me = env.current_contract_address();
        let r_in = TokenClient::new(&env, &token_in).balance(&me);
        let r_out = TokenClient::new(&env, &token_out).balance(&me);
        cp_out(r_in, r_out, in_amount as i128) as u128
    }

    pub fn swap_chained(
        env: Env,
        user: Address,
        swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
        token_in: Address,
        in_amount: u128,
        out_min: u128,
    ) -> u128 {
        user.require_auth();
        let me = env.current_contract_address();
        let (_, _, token_out) = swaps_chain.last().unwrap();
        let r_in = TokenClient::new(&env, &token_in).balance(&me);
        let r_out = TokenClient::new(&env, &token_out).balance(&me);
        let out = cp_out(r_in, r_out, in_amount as i128);
        if (out as u128) < out_min {
            panic!("below out_min");
        }
        TokenClient::new(&env, &token_in).transfer(&user, &me, &(in_amount as i128));
        TokenClient::new(&env, &token_out).transfer(&me, &user, &out);
        out as u128
    }
}

// anyone's contract: moves the pool, runs the compose as its own executor, moves it back
#[contract]
pub struct Sandwich;

fn approve(env: &Env, token: &Address, to: &Address, amount: i128) {
    let me = env.current_contract_address();
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (me, to.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
}

#[contractimpl]
impl Sandwich {
    pub fn run(
        env: Env,
        venue: Address,
        arrival: Address,
        sell: Address,
        buy: Address,
        skew: i128,
        from: Address,
        guid: BytesN<32>,
        message: Bytes,
    ) {
        let me = env.current_contract_address();
        let pool = vec![&env, sell.clone(), buy.clone()];
        let idx = BytesN::from_array(&env, &[7u8; 32]);
        if skew > 0 {
            approve(&env, &sell, &venue, skew);
            CpVenueClient::new(&env, &venue).swap_chained(
                &me,
                &vec![&env, (pool.clone(), idx.clone(), buy.clone())],
                &sell,
                &(skew as u128),
                &1,
            );
        }
        // no signature from anyone: this contract is the executor and the direct invoker
        ArrivalContractClient::new(&env, &arrival).lz_compose(
            &me,
            &from,
            &guid,
            &0,
            &message,
            &Bytes::new(&env),
            &0,
        );
        let got = TokenClient::new(&env, &buy).balance(&me);
        if got > 0 {
            approve(&env, &buy, &venue, got);
            CpVenueClient::new(&env, &venue).swap_chained(
                &me,
                &vec![&env, (pool, idx, sell.clone())],
                &buy,
                &(got as u128),
                &1,
            );
        }
    }
}

struct Cp {
    env: Env,
    endpoint: Address,
    arrival: Address,
    oft: Address,
    usdt0: Address,
    usdc: Address,
    venue: Address,
}

const R: i128 = 10_000_000_000_000; // 1,000,000 of a 7 decimal token

fn cp_world() -> Cp {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    let (native, _) = sac(&env);
    let endpoint = env.register(endpoint::WASM, (Address::generate(&env), 40600u32, native));
    let (usdt0, _) = sac(&env);
    let (usdc, _) = sac(&env);
    let oft = Address::generate(&env);
    let venue = env.register(CpVenue, ());
    StellarAssetClient::new(&env, &usdt0).mint(&venue, &R);
    StellarAssetClient::new(&env, &usdc).mint(&venue, &R);
    let arrival = env.register(
        ArrivalContract,
        (
            endpoint.clone(),
            venue.clone(),
            vec![&env, (oft.clone(), usdt0.clone())],
            vec![&env, (usdc.clone(), NO_LIMIT)],
            Vec::<Address>::new(&env),
        ),
    );
    env.set_auths(&[]);
    Cp {
        env,
        endpoint,
        arrival,
        oft,
        usdt0,
        usdc,
        venue,
    }
}

fn queue(c: &Cp, amount: i128, msg: &Bytes) -> (BytesN<32>, Bytes) {
    let guid = BytesN::random(&c.env);
    let message = envelope(&c.env, 1, amount, msg);
    c.env.mock_all_auths();
    StellarAssetClient::new(&c.env, &c.usdt0).mint(&c.arrival, &amount);
    endpoint::Client::new(&c.env, &c.endpoint)
        .send_compose(&c.oft, &c.arrival, &guid, &0, &message);
    c.env.set_auths(&[]);
    (guid, message)
}

// the largest pre-skew that still lets the user's swap clear `floor`
fn max_skew(amount: i128, floor: i128) -> i128 {
    let (mut lo, mut hi) = (0i128, R);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        let got = cp_out(R, R, mid);
        if cp_out(R + mid, R - got, amount) >= floor {
            lo = mid
        } else {
            hi = mid - 1
        }
    }
    lo
}

fn sandwich(c: &Cp, skew: i128, guid: &BytesN<32>, message: &Bytes) -> i128 {
    let attacker = c.env.register(Sandwich, ());
    c.env.mock_all_auths();
    StellarAssetClient::new(&c.env, &c.usdt0).mint(&attacker, &skew.max(1));
    c.env.set_auths(&[]);
    let start = TokenClient::new(&c.env, &c.usdt0).balance(&attacker);
    SandwichClient::new(&c.env, &attacker).run(
        &c.venue, &c.arrival, &c.usdt0, &c.usdc, &skew, &c.oft, guid, message,
    );
    TokenClient::new(&c.env, &c.usdt0).balance(&attacker) - start
}

fn ask_for(c: &Cp, recipient: &Address, min_out: i128) -> Bytes {
    encode(
        &c.env,
        &Ask {
            recipient: recipient.clone(),
            wanted: c.usdc.clone(),
            min_out,
            fee_bps: 0,
            fee_recipient: recipient.clone(),
            path: std::vec![(
                std::vec![c.usdt0.clone(), c.usdc.clone()],
                [7u8; 32],
                c.usdc.clone()
            )],
        },
    )
}

#[test]
fn anyone_can_run_the_compose_inside_their_own_sandwich() {
    let c = cp_world();
    let amount = 1_000_000_000_000; // 100,000 USDT0
    let quote = cp_out(R, R, amount);
    // what the SDK signs: the quote less COMPOSE_MAX_SLIPPAGE_BPS (20)
    let min_out = quote * (10_000 - 20) / 10_000;
    let recipient = Address::generate(&c.env);
    let (guid, message) = queue(&c, amount, &ask_for(&c, &recipient, min_out));

    let skew = max_skew(amount, min_out);
    let profit = sandwich(&c, skew, &guid, &message);
    let got = TokenClient::new(&c.env, &c.usdc).balance(&recipient);
    std::println!(
            "quote {quote} min_out {min_out} user got {got} (lost {} vs quote), skew {skew}, attacker profit {profit} USDT0 stroops",
            quote - got
        );
    assert!(got >= min_out && got < quote);
    assert!(profit > 0, "the sandwich paid for itself");
    assert_eq!(TokenClient::new(&c.env, &c.usdt0).balance(&c.arrival), 0);
}

#[test]
fn anyone_can_force_a_conversion_to_deliver_as_it_came() {
    let c = cp_world();
    let amount = 1_000_000_000_000;
    let quote = cp_out(R, R, amount);
    let min_out = quote * (10_000 - 20) / 10_000;
    let recipient = Address::generate(&c.env);
    let (guid, message) = queue(&c, amount, &ask_for(&c, &recipient, min_out));

    let skew = max_skew(amount, min_out) + 10_000_000; // one USDT0 past the line
    let result = sandwich(&c, skew, &guid, &message);
    assert_eq!(TokenClient::new(&c.env, &c.usdc).balance(&recipient), 0);
    assert_eq!(
        TokenClient::new(&c.env, &c.usdt0).balance(&recipient),
        amount
    );
    std::println!(
        "forced as_came; the attacker paid {} USDT0 stroops in pool fees",
        -result
    );
}

// ------------------------------------------------------------ properties

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn range(&mut self, lo: i128, hi: i128) -> i128 {
        lo + (self.next() as i128).rem_euclid(hi - lo + 1)
    }
}

#[test]
fn the_fee_never_takes_the_user_below_the_floor_for_any_amounts() {
    let mut r = Rng(0x9e3779b97f4a7c15);
    let mut loose = 0u32;
    for _ in 0..2_000_000 {
        let min_out = match r.next() % 3 {
            0 => r.range(1, 1_000),
            1 => r.range(1, i64::MAX as i128),
            _ => r.range(1, 1i128 << 100),
        };
        let bps = r.range(0, 1_000) as u32;
        let floor = venue_floor(min_out, bps).unwrap();
        for out in [floor, floor + r.range(0, 1_000_000)] {
            assert!(out - fee_of(out, bps) >= min_out, "{min_out} {bps} {out}");
        }
        let _ = &mut loose;
        // how often one less would also have done (conservative, not unsafe)
        if floor > 1 && floor - 1 - fee_of(floor - 1, bps) >= min_out {
            loose += 1;
        }
    }
    std::println!(
        "floor safe for 2,000,000 samples; one stroop looser would also have cleared in {loose}"
    );
}

#[test]
fn every_compose_moves_exactly_its_own_arrival_for_random_conditions() {
    let mut rng = Rng(0xdeadbeefcafef00d);
    let mut stats = [0u32; 7]; // converted, as_came, trapped, reverted-other
    for case in 0..400 {
        let mut w = setup();
        let num = rng.range(900, 1_100);
        w.env.mock_all_auths();
        VenueClient::new(&w.env, &w.venue).set_rate(&num, &1_000);
        if rng.next().is_multiple_of(3) {
            VenueClient::new(&w.env, &w.venue).set_optimism(&rng.range(1, 60));
        }
        // the double pays back the arriving token on a swap back too
        StellarAssetClient::new(&w.env, &w.usdt0).mint(&w.venue, &1_000_000_000_000);
        w.env.set_auths(&[]);

        let n = rng.range(1, 4) as usize;
        let mut pending: std::vec::Vec<(BytesN<32>, Bytes, i128, Address, Address)> = std::vec![];
        for _ in 0..n {
            let amount = match rng.next() % 3 {
                0 => rng.range(1, 100),
                _ => rng.range(1, 1_000_000_000_000),
            };
            let expect = amount * num / 1_000;
            let recipient = if rng.next().is_multiple_of(2) {
                Address::generate(&w.env)
            } else {
                let a = account(&w.env);
                open_account(&w.env, &a);
                trust(&w.env, &a, &w.usdt0_asset);
                let limit = if rng.next().is_multiple_of(3) {
                    rng.range(0, expect.max(1))
                } else {
                    i64::MAX as i128
                };
                trust_up_to(
                    &w.env,
                    &a,
                    &w.usdc_asset,
                    xdr::TrustLineFlags::AuthorizedFlag as u32,
                    limit as i64,
                );
                a
            };
            let fee_to = if rng.next().is_multiple_of(2) {
                Address::generate(&w.env)
            } else {
                let a = account(&w.env);
                open_account(&w.env, &a);
                let limit = rng.range(0, (expect / 50).max(1));
                trust_up_to(
                    &w.env,
                    &a,
                    &w.usdc_asset,
                    xdr::TrustLineFlags::AuthorizedFlag as u32,
                    limit as i64,
                );
                a
            };
            let mut ask = w.ask(&recipient);
            let bps = if rng.next().is_multiple_of(8) {
                rng.range(1_001, 1_200)
            } else {
                rng.range(0, 1_000)
            };
            ask.min_out =
                (expect * (10_000 - bps) / 10_000 * rng.range(9_700, 10_050) / 10_000).max(1);
            ask.fee_bps = bps as u16;
            ask.fee_recipient = fee_to.clone();
            let (g, m) = w.arrive(amount, &encode(&w.env, &ask));
            pending.push((g, m, amount, recipient, fee_to));
        }
        let mut queued: i128 = pending.iter().map(|p| p.2).sum();
        assert_eq!(w.held(), (queued, 0));
        while !pending.is_empty() {
            let i = (rng.next() as usize) % pending.len();
            let (g, m, amount, recipient, fee_to) = pending.remove(i);
            let before = (
                w.token(&w.usdt0).balance(&recipient),
                w.token(&w.usdc).balance(&recipient),
                w.token(&w.usdc).balance(&fee_to),
            );
            match w.compose(&g, &m) {
                Ok(()) => {
                    queued -= amount;
                    let e = w.arrived_events().pop().unwrap();
                    let got_usdt0 = w.token(&w.usdt0).balance(&recipient) - before.0;
                    let got_usdc = w.token(&w.usdc).balance(&recipient) - before.1;
                    let fee_paid = w.token(&w.usdc).balance(&fee_to) - before.2;
                    if recipient == fee_to {
                        panic!("same address")
                    }
                    if e.outcome == w.sym("converted") {
                        stats[0] += 1;
                        if e.fee > 0 {
                            stats[4] += 1
                        }
                        if e.unconverted > 0 {
                            stats[5] += 1
                        }
                        assert_eq!(got_usdc, e.amount);
                        assert_eq!(fee_paid, e.fee);
                        assert_eq!(got_usdt0, e.unconverted);
                    } else {
                        stats[1] += 1;
                        if got_usdt0 != amount {
                            stats[6] += 1
                        }
                        assert_eq!(got_usdc, 0);
                        assert_eq!(got_usdt0, e.amount);
                        // the double's swap back is at the same rate, so with a rate above one it
                        // returns more than was taken; that surplus is the venue's, not another arrival's
                        assert!(e.amount > 0, "case {case}");
                    }
                }
                Err(Some(e)) => {
                    stats[2] += 1;
                    assert_eq!(e, contract_error(Error::NoWayBack), "case {case}");
                }
                Err(None) => {
                    stats[3] += 1;
                }
            }
            assert_eq!(
                w.held(),
                (queued, 0),
                "case {case}: the contract holds exactly what is still queued"
            );
        }
    }
    std::println!("converted {} as_came {} NoWayBack {} other reverts {}; converted with fee paid {}, with unconverted {}, as_came after a swap back {}", stats[0], stats[1], stats[2], stats[3], stats[4], stats[5], stats[6]);
}
