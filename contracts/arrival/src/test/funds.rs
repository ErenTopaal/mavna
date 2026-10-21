//! The ca-funds audit's tests (2026-10-21): who can make the contract pay, and
//! conservation across random arrivals, recipients and compose orders.

use super::*;

#[contract]
struct Wrapper;

#[contractimpl]
impl Wrapper {
    /// runs lz_compose as the executor (auth passes as invoker), then tries to
    /// spend the arrival contract's usdt0 to `to` with whatever authorization
    /// the arrival contract may have left behind
    pub fn run(
        env: Env,
        arrival: Address,
        from: Address,
        guid: BytesN<32>,
        message: Bytes,
        token: Address,
        to: Address,
        amount: i128,
    ) -> bool {
        let me = env.current_contract_address();
        ArrivalContractClient::new(&env, &arrival).lz_compose(
            &me,
            &from,
            &guid,
            &0,
            &message,
            &Bytes::new(&env),
            &0,
        );
        matches!(
            TokenClient::new(&env, &token).try_transfer(&arrival, &to, &amount),
            Ok(Ok(()))
        )
    }
}

#[test]
fn caf_executor_equal_to_the_contract_cannot_spend_its_native_balance() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    let native = endpoint::Client::new(&w.env, &w.endpoint).native_token();
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &native).mint(&w.arrival, &5_000);
    w.env.set_auths(&[]);
    let me = w.arrival.clone();
    // no auth supplied at all
    let r = w.client().try_lz_compose(
        &me,
        &w.oft,
        &guid,
        &0,
        &message,
        &Bytes::new(&w.env),
        &5_000,
    );
    assert!(r.is_err(), "executor == contract with no auth must fail");
    // a mocked auth entry for the contract address must also fail (no __check_auth)
    let args: Vec<Val> = (
        me.clone(),
        w.oft.clone(),
        guid.clone(),
        0u32,
        message.clone(),
        Bytes::new(&w.env),
        5_000i128,
    )
        .into_val(&w.env);
    let invoke = MockAuthInvoke {
        contract: &w.arrival,
        fn_name: "lz_compose",
        args,
        sub_invokes: &[],
    };
    let r = w
        .client()
        .mock_auths(&[MockAuth {
            address: &me,
            invoke: &invoke,
        }])
        .try_lz_compose(
            &me,
            &w.oft,
            &guid,
            &0,
            &message,
            &Bytes::new(&w.env),
            &5_000,
        );
    std::println!("mocked contract auth result: {:?}", r.as_ref().err());
    assert!(r.is_err());
    assert_eq!(w.token(&native).balance(&w.arrival), 5_000);
    assert_eq!(w.held(), (1_000_000, 0));
}

#[test]
fn caf_leftover_swap_authorization_cannot_be_spent_by_an_executor_contract() {
    let mut w = setup();
    let venue = VenueClient::new(&w.env, &w.venue);
    venue.set_rate(&98, &100);
    // estimate clears the floor, swap refuses: the arrival has pre-authorized
    // usdt0.transfer(arrival, venue, 1_000_000) and it was never consumed
    venue.set_optimism(&500);
    let recipient = Address::generate(&w.env);
    let victim = Address::generate(&w.env);
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &w.ask(&recipient)));
    // a second, unrelated arrival waiting in the contract
    let _ = w.arrive(1_000_000, &encode(&w.env, &w.ask(&victim)));
    let wrapper = w.env.register(Wrapper, ());
    let thief_got = WrapperClient::new(&w.env, &wrapper).run(
        &w.arrival, &w.oft, &guid, &message, &w.usdt0, &w.venue, &1_000_000,
    );
    assert!(!thief_got, "leftover authorization was spent");
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (1_000_000, 0));
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
}

/// a party with a random ability to hold usdt0 and usdc
fn random_party(w: &World, rng: &mut Rng) -> Address {
    match rng.below(7) {
        0 => Address::generate(&w.env),
        _ => {
            let a = account(&w.env);
            open_account(&w.env, &a);
            let lim = |rng: &mut Rng| -> i64 {
                match rng.below(4) {
                    0 => i64::MAX,
                    1 => rng.below(3_000_000) as i64,
                    2 => rng.below(20_000) as i64,
                    _ => i64::MAX,
                }
            };
            match rng.below(5) {
                0 => {}
                1 => trust_up_to(&w.env, &a, &w.usdt0_asset, 0, i64::MAX),
                _ => {
                    let l = lim(rng);
                    trust_up_to(&w.env, &a, &w.usdt0_asset, AUTHORIZED, l)
                }
            }
            match rng.below(5) {
                0 => {}
                1 => trust_up_to(&w.env, &a, &w.usdc_asset, 0, i64::MAX),
                _ => {
                    let l = lim(rng);
                    trust_up_to(&w.env, &a, &w.usdc_asset, AUTHORIZED, l)
                }
            }
            a
        }
    }
}

fn bal(w: &World, t: &Address, who: &Address) -> i128 {
    w.token(t)
        .try_balance(who)
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(0)
}

#[test]
fn caf_conservation_across_random_arrivals_and_orders() {
    let mut total_ok = 0;
    let mut total_err = 0;
    let mut outcomes = std::collections::BTreeMap::<std::string::String, u32>::new();
    for seed in 1..=300u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let mut w = setup();
        w.env.mock_all_auths();
        StellarAssetClient::new(&w.env, &w.usdt0).mint(&w.venue, &1_000_000_000_000);
        w.env.set_auths(&[]);
        let mut pending: std::vec::Vec<(BytesN<32>, Bytes, i128, Address, Address, i128, u16)> =
            std::vec::Vec::new();
        let n = 3 + rng.below(6) as usize;
        for _ in 0..n {
            let amount = match rng.below(5) {
                0 => rng.below(10) as i128,
                _ => 1 + rng.below(2_000_000) as i128,
            };
            let recipient = if rng.below(15) == 0 {
                w.arrival.clone()
            } else {
                random_party(&w, &mut rng)
            };
            let fee_recipient = match rng.below(4) {
                0 => recipient.clone(),
                1 => w.arrival.clone(),
                _ => random_party(&w, &mut rng),
            };
            let fee_bps = match rng.below(4) {
                0 => 0,
                1 => rng.below(1_200) as u16,
                _ => rng.below(100) as u16,
            };
            let min_out = match rng.below(4) {
                0 => 0,
                _ => (amount * (90 + rng.below(15) as i128) / 100).max(1),
            };
            let ask = Ask {
                recipient: recipient.clone(),
                wanted: w.usdc.clone(),
                min_out,
                fee_bps,
                fee_recipient: fee_recipient.clone(),
                path: w.direct_path(),
            };
            let (guid, message) = w.arrive(amount, &encode(&w.env, &ask));
            pending.push((
                guid,
                message,
                amount,
                recipient,
                fee_recipient,
                min_out,
                fee_bps,
            ));
        }
        let mut stuck_usdt0 = 0i128;
        let mut stuck_usdc = 0i128;
        let mut attempts = 0;
        while !pending.is_empty() && attempts < 3 * n {
            attempts += 1;
            let i = rng.below(pending.len() as u64) as usize;
            let venue = VenueClient::new(&w.env, &w.venue);
            venue.set_rate(&(95 + rng.below(12) as i128), &100);
            venue.set_optimism(
                &(if rng.below(3) == 0 {
                    rng.below(300) as i128
                } else {
                    0
                }),
            );
            let (guid, message, _amount, recipient, fee_recipient, min_out, _fee_bps) =
                pending[i].clone();
            let pending_sum: i128 = pending.iter().map(|p| p.2.max(0)).sum();
            assert_eq!(
                w.held(),
                (pending_sum + stuck_usdt0, stuck_usdc),
                "seed {seed}: held before"
            );
            let r0 = (bal(&w, &w.usdt0, &recipient), bal(&w, &w.usdc, &recipient));
            let f0 = bal(&w, &w.usdc, &fee_recipient);
            let r = w.compose(&guid, &message);
            match r {
                Ok(()) => {
                    total_ok += 1;
                    let e = w.arrived_events()[0].clone();
                    let key = std::format!(
                        "{}{}{}",
                        if e.outcome == w.sym("converted") {
                            "converted"
                        } else {
                            "as_came"
                        },
                        if e.fee > 0 { "+fee" } else { "" },
                        if e.unconverted > 0 {
                            "+unconverted"
                        } else {
                            ""
                        }
                    );
                    *outcomes.entry(key).or_default() += 1;
                    pending.remove(i);
                    if recipient == w.arrival {
                        // paid to itself: whatever it delivered stays here
                        if e.outcome == w.sym("converted") {
                            stuck_usdc += e.amount;
                            stuck_usdt0 += e.unconverted;
                        } else {
                            stuck_usdt0 += e.amount;
                        }
                        continue;
                    }
                    let r1 = (bal(&w, &w.usdt0, &recipient), bal(&w, &w.usdc, &recipient));
                    let f1 = bal(&w, &w.usdc, &fee_recipient);
                    if e.outcome == w.sym("converted") {
                        assert!(e.amount >= min_out, "seed {seed}: under the floor");
                        if fee_recipient == recipient {
                            assert_eq!(r1.1 - r0.1, e.amount + e.fee, "seed {seed}");
                        } else {
                            assert_eq!(r1.1 - r0.1, e.amount, "seed {seed}");
                            assert_eq!(f1 - f0, e.fee, "seed {seed}");
                        }
                        assert_eq!(r1.0 - r0.0, e.unconverted, "seed {seed}");
                    } else {
                        assert_eq!(r1.1, r0.1, "seed {seed}");
                        assert_eq!(r1.0 - r0.0, e.amount.max(0), "seed {seed}");
                        // the venue double can return more than it took on a swap back, so no upper bound here
                    }
                }
                Err(_) => {
                    total_err += 1;
                    // reverted: nothing moved, still queued
                    let r1 = (bal(&w, &w.usdt0, &recipient), bal(&w, &w.usdc, &recipient));
                    assert_eq!(r0, r1, "seed {seed}: a failed compose moved funds");
                    let q = endpoint::Client::new(&w.env, &w.endpoint)
                        .compose_queue(&w.oft, &w.arrival, &guid, &0);
                    assert_eq!(q, Some(w.env.crypto().keccak256(&message).into()));
                }
            }
            let pending_sum: i128 = pending.iter().map(|p| p.2.max(0)).sum();
            assert_eq!(
                w.held(),
                (pending_sum + stuck_usdt0, stuck_usdc),
                "seed {seed}: held after"
            );
        }
    }
    std::println!("ok {total_ok} err {total_err} outcomes {outcomes:?}");
}

#[test]
fn caf_a_clawback_aimed_at_one_arrival_lands_on_another_users_arrival() {
    let mut w = setup();
    let target = Address::generate(&w.env);
    let bystander = Address::generate(&w.env);
    // the bystander's arrival is credited first, the targeted one second
    let (g_by, m_by) = w.arrive(1_000_000, &encode(&w.env, &w.ask(&bystander)));
    let (g_t, m_t) = w.arrive(1_000_000, &encode(&w.env, &w.ask(&target)));
    // the issuer (on mainnet: the SAC manager's CLAWBACK_ROLE) claws back the
    // targeted arrival's amount from the contract's single pooled balance
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &w.usdt0).clawback(&w.arrival, &1_000_000);
    w.env.set_auths(&[]);
    // the targeted message still runs first and is paid in full, out of the bystander's funds
    w.compose(&g_t, &m_t).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&target), 1_000_000);
    // the bystander's compose now traps and stays queued, with nothing left to pay it
    assert!(w.compose(&g_by, &m_by).is_err());
    assert_eq!(w.held(), (0, 0));
    let q = endpoint::Client::new(&w.env, &w.endpoint).compose_queue(&w.oft, &w.arrival, &g_by, &0);
    assert_eq!(q, Some(w.env.crypto().keccak256(&m_by).into()));
    std::println!(
        "target paid 1_000_000 usdc; bystander's 1_000_000 usdt0 arrival stuck in the queue"
    );
}

#[test]
fn caf_a_freeze_of_the_contract_holds_every_waiting_arrival() {
    let mut w = setup();
    let a = Address::generate(&w.env);
    let (g, m) = w.arrive(1_000_000, &encode(&w.env, &w.ask(&a)));
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &w.usdt0).set_authorized(&w.arrival, &false);
    w.env.set_auths(&[]);
    assert!(w.compose(&g, &m).is_err());
    assert_eq!(w.held(), (1_000_000, 0));
}
