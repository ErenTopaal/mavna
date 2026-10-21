//! The ca-math audit's tests (2026-10-21): a randomized conservation and floor
//! fuzz over the real endpoint, and the floor and fee arithmetic.

use super::*;

#[contracttype]
enum FvKey {
    Rate(Address),
    EstBias,
    Short,
    Fail,
    EstFail,
}

#[contract]
struct FuzzVenue;

#[contractimpl]
impl FuzzVenue {
    pub fn set_rate(env: Env, token_in: Address, num: i128, den: i128) {
        env.storage()
            .instance()
            .set(&FvKey::Rate(token_in), &(num, den));
    }
    pub fn set_mode(env: Env, est_bias: i128, short: i128, fail: bool, est_fail: bool) {
        let s = env.storage().instance();
        s.set(&FvKey::EstBias, &est_bias);
        s.set(&FvKey::Short, &short);
        s.set(&FvKey::Fail, &fail);
        s.set(&FvKey::EstFail, &est_fail);
    }
    fn rate(env: &Env, token_in: &Address) -> (i128, i128) {
        env.storage()
            .instance()
            .get(&FvKey::Rate(token_in.clone()))
            .unwrap()
    }
    pub fn estimate_swap(
        env: Env,
        _tokens: Vec<Address>,
        token_in: Address,
        _token_out: Address,
        _pool_index: BytesN<32>,
        in_amount: u128,
    ) -> u128 {
        if env
            .storage()
            .instance()
            .get(&FvKey::EstFail)
            .unwrap_or(false)
        {
            panic!("no estimate");
        }
        let (num, den) = Self::rate(&env, &token_in);
        let bias: i128 = env.storage().instance().get(&FvKey::EstBias).unwrap_or(0);
        let v = in_amount as i128 * num / den;
        (v * (10_000 + bias) / 10_000).max(0) as u128
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
        if env.storage().instance().get(&FvKey::Fail).unwrap_or(false) {
            panic!("venue down");
        }
        let me = env.current_contract_address();
        TokenClient::new(&env, &token_in).transfer(&user, &me, &(in_amount as i128));
        // multi-hop: apply each hop's rate keyed by what is held
        let mut holding = token_in.clone();
        let mut out = in_amount as i128;
        for (_, _, t) in swaps_chain.iter() {
            let (num, den) = Self::rate(&env, &holding);
            out = out * num / den;
            holding = t;
        }
        let short: i128 = env.storage().instance().get(&FvKey::Short).unwrap_or(0);
        out = (out - short).max(0);
        if (out as u128) < out_min {
            panic!("below out_min");
        }
        if out > 0 {
            TokenClient::new(&env, &holding).transfer(&me, &user, &out);
        }
        out as u128
    }
}

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
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }
}

fn setup_fuzz() -> World {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();
    let (native, _) = sac(&env);
    let endpoint = env.register(endpoint::WASM, (Address::generate(&env), 40600u32, native));
    let (usdt0, usdt0_asset) = sac(&env);
    let (usdc, usdc_asset) = sac(&env);
    let oft = Address::generate(&env);
    let venue = env.register(FuzzVenue, ());
    StellarAssetClient::new(&env, &usdc).mint(&venue, &(i64::MAX as i128 / 2));
    StellarAssetClient::new(&env, &usdt0).mint(&venue, &(i64::MAX as i128 / 2));
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
    let executor = Address::generate(&env);
    env.set_auths(&[]);
    World {
        env,
        endpoint,
        arrival,
        oft,
        usdt0,
        usdt0_asset,
        usdc,
        usdc_asset,
        venue,
        executor,
        nonce: 0,
        last_events: std::cell::RefCell::new(std::vec::Vec::new()),
    }
}

#[derive(Clone)]
struct Pending {
    guid: BytesN<32>,
    message: Bytes,
    amount: i128,
    minted: i128,
    recipient: Address,
    fee_recipient: Address,
    min_out: i128,
    fee_bps: u16,
    accounts: std::vec::Vec<Address>,
}

impl World {
    fn arrive_raw(
        &mut self,
        minted: i128,
        amount_ld: i128,
        compose_msg: &Bytes,
    ) -> (BytesN<32>, Bytes) {
        self.nonce += 1;
        let guid = BytesN::random(&self.env);
        let message = envelope(&self.env, self.nonce, amount_ld, compose_msg);
        self.env.mock_all_auths();
        if minted > 0 {
            StellarAssetClient::new(&self.env, &self.usdt0).mint(&self.arrival, &minted);
        }
        endpoint::Client::new(&self.env, &self.endpoint).send_compose(
            &self.oft,
            &self.arrival,
            &guid,
            &0,
            &message,
        );
        self.env.set_auths(&[]);
        (guid, message)
    }
    fn is_queued(&self, guid: &BytesN<32>, message: &Bytes) -> bool {
        let want: BytesN<32> = self.env.crypto().keccak256(message).into();
        endpoint::Client::new(&self.env, &self.endpoint).compose_queue(
            &self.oft,
            &self.arrival,
            guid,
            &0,
        ) == Some(want)
    }
    fn venue_mode(&self, est_bias: i128, short: i128, fail: bool, est_fail: bool) {
        self.env.mock_all_auths();
        FuzzVenueClient::new(&self.env, &self.venue).set_mode(&est_bias, &short, &fail, &est_fail);
        self.env.set_auths(&[]);
    }
    fn venue_rate(&self, token_in: &Address, num: i128, den: i128) {
        self.env.mock_all_auths();
        FuzzVenueClient::new(&self.env, &self.venue).set_rate(token_in, &num, &den);
        self.env.set_auths(&[]);
    }
    fn bal(&self, t: &Address, who: &Address) -> i128 {
        match self.token(t).try_balance(who) {
            Ok(Ok(v)) => v,
            _ => 0,
        }
    }
}

const FLAGS_AUTH: u32 = xdr::TrustLineFlags::AuthorizedFlag as u32;

/// A random party: a contract address (holds anything), or a classic account with
/// random trustlines (none, unauthorised, limited, full) on each asset.
fn party(w: &World, r: &mut Rng, accounts: &mut std::vec::Vec<Address>) -> Address {
    if r.below(3) == 0 {
        return Address::generate(&w.env);
    }
    let a = account(&w.env);
    open_account(&w.env, &a);
    for asset in [w.usdt0_asset.clone(), w.usdc_asset.clone()] {
        match r.below(6) {
            0 => {}
            1 => trust_with(&w.env, &a, &asset, 0),
            2 | 3 => trust_up_to(
                &w.env,
                &a,
                &asset,
                FLAGS_AUTH,
                r.pick(&[1i64, 1_000, 500_000, 999_999, 1_000_000, 10_000_000]),
            ),
            _ => trust(&w.env, &a, &asset),
        }
    }
    accounts.push(a.clone());
    a
}

#[test]
fn fuzz_conservation_and_floor() {
    let seed: u64 = std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x9e3779b97f4a7c15);
    let iters: u64 = std::env::var("FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(150);
    let mut r = Rng(seed);
    let mut stats = std::collections::BTreeMap::<std::string::String, u64>::new();
    let mut bump = |k: &str| *stats.entry(k.into()).or_insert(0) += 1;

    for iter in 0..iters {
        let mut w = setup_fuzz();
        let (fnum, fden) = r.pick(&[
            (1i128, 1i128),
            (2, 1),
            (1, 2),
            (3, 7),
            (7, 3),
            (1, 1_000_000),
            (999, 1000),
        ]);
        let (bnum, bden) = r.pick(&[(1i128, 1i128), (1, 2), (999, 1000), (1, 1_000_000), (2, 1)]);
        w.venue_rate(&w.usdt0.clone(), fnum, fden);
        w.venue_rate(&w.usdc.clone(), bnum, bden);
        let n = 1 + r.below(5) as usize;
        let mut pend: std::vec::Vec<Pending> = std::vec::Vec::new();
        for _ in 0..n {
            let mut accounts = std::vec::Vec::new();
            let recipient = party(&w, &mut r, &mut accounts);
            let fee_recipient = match r.below(5) {
                0 => recipient.clone(),
                1 => w.arrival.clone(),
                _ => party(&w, &mut r, &mut accounts),
            };
            let amount: i128 = match r.below(9) {
                0 => 0,
                1 => 1,
                2 => r.pick(&[2i128, 9, 10, 11, 99, 100, 101]),
                3 => (r.below(10_000_000) + 1) as i128,
                4 => (r.below(1_000_000_000_000) + 1) as i128,
                5 => (r.below(1u64 << 50) + 1) as i128,
                6 => i64::MAX as i128 / 64,
                _ => (r.below(5_000_000) + 1) as i128,
            };
            let fee_bps: u16 = r.pick(&[0u16, 0, 1, 7, 20, 30, 999, 1000, 1001, 65535]);
            let est = amount * fnum / fden;
            let keep = 10_000 - (fee_bps.min(1000) as i128);
            let net_at = |out: i128| out - out * fee_bps.min(1000) as i128 / 10_000;
            let min_out: i128 = match r.below(12) {
                0 => -5,
                1 => 0,
                2 => 1,
                3 => net_at(est),
                4 => net_at(est) + 1,
                5 => (net_at(est) - 1).max(1),
                6 => est * keep / 10_000,
                7 => (r.below(est.max(1) as u64) + 1) as i128,
                8 => i128::MAX,
                9 => i128::MAX / 10_000 + 1,
                _ => (est * 995 / 1000).max(1),
            };
            let ask = Ask {
                recipient: recipient.clone(),
                wanted: w.usdc.clone(),
                min_out,
                fee_bps,
                fee_recipient: fee_recipient.clone(),
                path: w.direct_path(),
            };
            let msg = encode(&w.env, &ask);
            let (guid, message) = w.arrive_raw(amount, amount, &msg);
            pend.push(Pending {
                guid,
                message,
                amount,
                minted: amount,
                recipient,
                fee_recipient,
                min_out,
                fee_bps,
                accounts,
            });
        }

        let mut queued_sum: i128 = pend.iter().map(|p| p.minted).sum();
        assert_eq!(w.held(), (queued_sum, 0));
        let mut order: std::vec::Vec<usize> = (0..n).collect();
        for i in (1..n).rev() {
            order.swap(i, r.below(i as u64 + 1) as usize);
        }
        let mut done = std::vec![false; n];
        for &i in &order {
            let p = pend[i].clone();
            let (est_bias, short, fail, est_fail) = match r.below(8) {
                0 => (100, 0, false, false),
                1 => (0, 1, false, false),
                2 => (0, 0, true, false),
                3 => (0, 0, false, true),
                4 => (-100, 0, false, false),
                _ => (0, 0, false, false),
            };
            w.venue_mode(est_bias, short, fail, est_fail);
            let rb = (w.bal(&w.usdt0, &p.recipient), w.bal(&w.usdc, &p.recipient));
            let fb = w.bal(&w.usdc, &p.fee_recipient);
            let before = w.held();
            // anyone may note a waiting compose; the normal path still runs first
            if r.below(4) == 0 {
                w.note(&p.guid, &p.message).unwrap();
                bump("noted");
            }
            let res = w.compose(&p.guid, &p.message);
            match res {
                Ok(()) => {
                    assert_eq!(w.client().noted(&w.oft, &p.guid, &0), None);
                    done[i] = true;
                    queued_sum -= p.minted;
                    let ev = w.arrived_events();
                    assert_eq!(ev.len(), 1, "iter {iter}: one event");
                    let e = &ev[0];
                    let ra = (
                        w.bal(&w.usdt0, &p.recipient) - rb.0,
                        w.bal(&w.usdc, &p.recipient) - rb.1,
                    );
                    let fa = w.bal(&w.usdc, &p.fee_recipient) - fb;
                    // the contract holds exactly what is still queued, nothing else
                    assert_eq!(
                        w.held(),
                        (queued_sum, 0),
                        "iter {iter} arrival {i}: books off, min_out {} fee {} amount {}",
                        p.min_out,
                        p.fee_bps,
                        p.amount
                    );
                    let distinct = p.fee_recipient != p.recipient && p.fee_recipient != w.arrival;
                    if e.outcome == w.sym("converted") {
                        bump("converted");
                        assert!(p.min_out > 0 && p.fee_bps <= 1000);
                        assert!(
                            e.amount >= p.min_out,
                            "iter {iter}: under floor {} < {}",
                            e.amount,
                            p.min_out
                        );
                        if distinct {
                            assert_eq!(ra.1, e.amount);
                            assert_eq!(fa, e.fee);
                        } else {
                            assert_eq!(
                                ra.1,
                                e.amount
                                    + if p.fee_recipient == p.recipient {
                                        e.fee
                                    } else {
                                        0
                                    }
                            );
                        }
                        assert_eq!(ra.0, e.unconverted);
                        // the fee never exceeds what was signed for
                        assert!(e.fee * 10_000 <= (e.amount + e.fee) * p.fee_bps as i128);
                        if e.unconverted > 0 {
                            bump("converted+unconverted");
                        }
                        if e.fee > 0 {
                            bump("fee paid");
                        }
                    } else {
                        bump("as_came");
                        assert_eq!(e.asset, w.usdt0);
                        assert_eq!(ra.1, 0);
                        assert_eq!(ra.0, e.amount);
                        if e.amount != p.amount {
                            bump("as_came swapped back");
                            assert!(e.amount > 0);
                        } else {
                            assert_eq!(e.amount, p.amount);
                        }
                    }
                }
                Err(err) => {
                    assert_eq!(
                        w.held(),
                        before,
                        "iter {iter}: a failed compose moved funds"
                    );
                    assert!(
                        w.is_queued(&p.guid, &p.message),
                        "iter {iter}: failed compose no longer queued"
                    );
                    match err {
                        Some(e) if e == contract_error(Error::NoWayBack) => bump("err NoWayBack"),
                        Some(e) if e == contract_error(Error::VenueOutsideFloor) => {
                            panic!("iter {iter}: VenueOutsideFloor with an honest venue")
                        }
                        Some(e) => bump(&std::format!("err token/other {e:?}")),
                        None => bump("err token refused"),
                    }
                }
            }
        }

        // repair: every party can now hold everything, the venue is honest;
        // nothing that was queued should stay stuck
        w.venue_mode(0, 0, false, false);
        w.venue_rate(&w.usdc.clone(), 1, 1);
        for (i, p) in pend.iter().enumerate() {
            if done[i] {
                continue;
            }
            for a in &p.accounts {
                trust(&w.env, a, &w.usdt0_asset);
                trust(&w.env, a, &w.usdc_asset);
            }
            if r.below(2) == 0 {
                // a week after it is noted, anyone delivers it as it came, once
                let before = w.bal(&w.usdt0, &p.recipient);
                w.note(&p.guid, &p.message).unwrap();
                w.wait(crate::OVERDUE_AFTER_LEDGERS);
                match w.overdue(&p.guid, &p.message) {
                    Ok(()) => {
                        queued_sum -= p.minted;
                        bump("delivered overdue");
                    }
                    Err(e) => panic!("iter {iter}: overdue delivery failed: {e:?}"),
                }
                let e = &w.arrived_events()[0];
                assert_eq!(e.outcome, w.sym("as_came"));
                assert_eq!(e.amount, p.amount);
                assert_eq!(w.bal(&w.usdt0, &p.recipient) - before, p.amount);
                assert!(
                    w.compose(&p.guid, &p.message).is_err(),
                    "iter {iter}: paid twice"
                );
                assert!(
                    w.overdue(&p.guid, &p.message).is_err(),
                    "iter {iter}: paid twice"
                );
            } else {
                match w.compose(&p.guid, &p.message) {
                    Ok(()) => {
                        queued_sum -= p.minted;
                        bump("repaired");
                    }
                    Err(e) => panic!("iter {iter}: still stuck after repair: {e:?}"),
                }
            }
            assert_eq!(w.held(), (queued_sum, 0));
        }
        assert_eq!(w.held(), (0, 0));
    }
    std::println!("fuzz stats: {stats:?}");
}

#[test]
fn prop_floor_and_fee_arithmetic() {
    let mut r = Rng(0xdeadbeefcafef00d);
    let mut slack = 0u64;
    let mut sdk_checked = 0u64;
    for _ in 0..5_000_000u64 {
        let fee_bps = match r.below(4) {
            0 => r.below(1001) as u32,
            1 => r.pick(&[0u32, 1, 999, 1000]),
            2 => r.below(10_000) as u32,
            _ => r.pick(&[9_999u32, 10_000, 10_001, u16::MAX as u32]),
        };
        let min_out: i128 = match r.below(5) {
            0 => (r.below(100) + 1) as i128,
            1 => (r.next() >> 1) as i128 + 1,
            2 => ((r.next() as i128) << 64 | r.next() as i128).abs().max(1),
            3 => i128::MAX / 10_000 - r.below(3) as i128 + 1,
            _ => (r.below(1u64 << 40) + 1) as i128,
        };
        let f = venue_floor(min_out, fee_bps);
        if fee_bps >= 10_000 {
            assert!(f.is_none());
            continue;
        }
        let Some(floor) = f else {
            // only refused when min_out * BPS overflows
            assert!(min_out
                .checked_mul(10_000)
                .and_then(|v| v.checked_add(9_999))
                .is_none());
            continue;
        };
        assert!(floor >= min_out);
        // any venue output at or above the floor leaves the minimum after the fee
        for d in [0i128, 1, 2, 1_000, (r.next() >> 2) as i128] {
            let Some(out) = floor.checked_add(d) else {
                continue;
            };
            let Some(prod) = out.checked_mul(fee_bps as i128) else {
                continue;
            };
            let fee = prod / 10_000;
            assert!(
                fee >= 0 && out - fee >= min_out,
                "out {out} fee_bps {fee_bps} min {min_out}"
            );
        }
        // how tight: does floor - 1 already clear the minimum after the fee
        if floor > 1 {
            let o = floor - 1;
            if let Some(prod) = o.checked_mul(fee_bps as i128) {
                if o - prod / 10_000 >= min_out {
                    slack += 1;
                }
            }
        }
        // sdk: minOut = floor(M * (BPS - bps) / BPS); the contract's floor must not exceed M
        if fee_bps <= 1000 {
            let m = min_out;
            if let Some(p) = m.checked_mul(10_000 - fee_bps as i128) {
                let sdk_min = p / 10_000;
                if sdk_min > 0 {
                    let cf = venue_floor(sdk_min, fee_bps).unwrap();
                    assert!(
                        cf <= m,
                        "contract floor {cf} above venue minimum {m} at {fee_bps}"
                    );
                    sdk_checked += 1;
                }
            }
        }
    }
    std::println!("floor - 1 would also have cleared the minimum in {slack} cases; sdk composition checked {sdk_checked}");
}

#[test]
fn edge_amounts() {
    // a zero amount clears the compose and moves nothing
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    StellarAssetClient::new(&w.env, &w.usdt0)
        .mock_all_auths()
        .mint(&w.arrival, &500);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive_raw(0, 0, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.held(), (500, 0));
    assert_eq!(w.arrived_events()[0].amount, 0);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
    // a min_out whose scaled floor overflows is delivered as it came, not trapped
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.min_out = i128::MAX;
    ask.fee_bps = 1000;
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    // two units with a 10% fee: the fee rounds to zero and the user keeps both
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let integrator = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.min_out = 1;
    ask.fee_bps = 1000;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(2, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 2);
    assert_eq!(w.token(&w.usdc).balance(&integrator), 0);
    // one unit at 10%: the floor is 2 and the venue gives 1, so it comes as it came
    // (CA-MATH-2: the floor is up to 2 units stricter than it needs to be)
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.min_out = 1;
    ask.fee_bps = 1000;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1);
}
