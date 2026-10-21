//! The contract as deployed (testdata/mavna_arrival.wasm, the bytes build.sh makes)
//! against Aquarius's real router and pools as wasm, with mainnet's state from
//! testdata/mainnet-fork.txt (scripts/arrival-fork-snapshot.mjs). The budget these
//! tests measure is the network's: a compose that goes over it aborts, which no
//! try_ call can catch, so the largest conversion must fit with room to spare.
//!
//! The snapshot holds what a swap of up to 900,000 USDT0 touches, so nothing here
//! swaps more than that.

use super::*;
use soroban_sdk::testutils::{Ledger, LedgerInfo};
use soroban_sdk::xdr::{Limits, ReadXdr};
use soroban_sdk::Map;

mod deployed {
    soroban_sdk::contractimport!(file = "testdata/mavna_arrival.wasm");
}

const ROUTER: &str = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";
const USDT0: &str = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const XLM: &str = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDT0_USDC: &str = "CCJHUCHZ2DC6MP7LMGQJYSENNTGIFWU4J4TCGFYYDLAC5LTD4YMF6HSQ";
const USDC_XLM: &str = "CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV";
const XLM_HOLDER: &str = "GBAIA5U6E3FSRUW55AXACIVGX2QR5JYAS74OWLED3S22EGXVYEHPLGPA";
/// Both pools are concentrated pools with a 10 bps fee, which the router keys
/// by this index.
const POOL_INDEX: [u8; 32] = [
    0x24, 0xf9, 0xc9, 0x91, 0xc4, 0x4a, 0xcf, 0x33, 0xff, 0xf5, 0xf4, 0x40, 0x31, 0xc4, 0x03, 0x85,
    0xd2, 0x35, 0xdc, 0x21, 0x2d, 0x73, 0x79, 0xe8, 0x24, 0xba, 0x3d, 0xb1, 0xc3, 0x53, 0x71, 0xf3,
];

/// The mainnet limits scripts/arrival-mainnet.mjs constructs with, in USDT0 base units.
const LARGEST_INTO_XLM: i128 = 50_000 * 10_000_000;
const LARGEST_INTO_USDC: i128 = 250_000 * 10_000_000;
/// The network's per-transaction instruction cap (ContractComputeV0, mainnet).
const TX_MAX_INSTRUCTIONS: i64 = 400_000_000;

fn at(env: &Env, s: &str) -> Address {
    Address::from_str(env, s)
}

fn mainnet() -> Env {
    let env = Env::default();
    let text = include_str!("../../testdata/mainnet-fork.txt");
    let mut lines = text.lines();
    let header: std::vec::Vec<&str> = lines.next().unwrap().split(' ').collect();
    env.ledger().set(LedgerInfo {
        protocol_version: header[5].parse().unwrap(),
        sequence_number: header[1].parse().unwrap(),
        timestamp: header[3].parse().unwrap(),
        network_id: [0; 32],
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 17_280,
        min_persistent_entry_ttl: 2_073_600,
        max_entry_ttl: 3_110_400,
    });
    for line in lines {
        let parts: std::vec::Vec<&str> = line.split(' ').collect();
        let key = xdr::LedgerKey::from_xdr_base64(parts[0], Limits::none()).unwrap();
        let entry = xdr::LedgerEntry::from_xdr_base64(parts[1], Limits::none()).unwrap();
        let live = parts.get(2).map(|l| l.parse::<u32>().unwrap());
        env.host()
            .add_ledger_entry(&std::rc::Rc::new(key), &std::rc::Rc::new(entry), live)
            .unwrap();
    }
    env
}

struct Fork {
    env: Env,
    endpoint: Address,
    arrival: Address,
    oft: Address,
    nonce: u64,
}

/// What a run used, of what mainnet limits per transaction.
#[derive(Debug)]
struct Usage {
    instructions: i64,
    mem_bytes: i64,
    read_entries: u32,
    disk_read_entries: u32,
    write_entries: u32,
    write_bytes: u32,
    events_bytes: u32,
}

struct Run {
    ok: bool,
    resources: Usage,
    event: Option<Arrived>,
}

fn fork() -> Fork {
    let env = mainnet();
    env.mock_all_auths();
    let endpoint = env.register(
        endpoint::WASM,
        (Address::generate(&env), 30600u32, at(&env, XLM)),
    );
    let oft = Address::generate(&env);
    let arrival = env.register(
        deployed::WASM,
        (
            endpoint.clone(),
            at(&env, ROUTER),
            vec![&env, (oft.clone(), at(&env, USDT0))],
            vec![
                &env,
                (at(&env, USDC), LARGEST_INTO_USDC),
                (at(&env, XLM), LARGEST_INTO_XLM),
            ],
            vec![&env, at(&env, USDC)],
        ),
    );
    env.set_auths(&[]);
    Fork {
        env,
        endpoint,
        arrival,
        oft,
        nonce: 0,
    }
}

impl Fork {
    fn queue(&mut self, amount: i128, into_xlm: bool, recipient: &Address) -> (BytesN<32>, Bytes) {
        let e = self.env.clone();
        let mut path = std::vec![(
            std::vec![at(&e, USDT0), at(&e, USDC)],
            POOL_INDEX,
            at(&e, USDC)
        )];
        if into_xlm {
            path.push((
                std::vec![at(&e, XLM), at(&e, USDC)],
                POOL_INDEX,
                at(&e, XLM),
            ));
        }
        let ask = Ask {
            recipient: recipient.clone(),
            wanted: at(&e, if into_xlm { XLM } else { USDC }),
            min_out: 1,
            fee_bps: 0,
            fee_recipient: recipient.clone(),
            path,
        };
        self.nonce += 1;
        let guid = BytesN::random(&e);
        let message = envelope(&e, self.nonce, amount, &encode(&e, &ask));
        e.mock_all_auths();
        StellarAssetClient::new(&e, &at(&e, USDT0)).mint(&self.arrival, &amount);
        endpoint::Client::new(&e, &self.endpoint).send_compose(
            &self.oft,
            &self.arrival,
            &guid,
            &0,
            &message,
        );
        e.set_auths(&[]);
        (guid, message)
    }

    /// Runs lz_compose with the network's budget, measuring what it used.
    fn compose(&self, guid: &BytesN<32>, message: &Bytes) -> Run {
        let e = &self.env;
        let executor = Address::generate(e);
        let args: Vec<Val> = (
            executor.clone(),
            self.oft.clone(),
            guid.clone(),
            0u32,
            message.clone(),
            Bytes::new(e),
            0i128,
        )
            .into_val(e);
        let invoke = MockAuthInvoke {
            contract: &self.arrival,
            fn_name: "lz_compose",
            args,
            sub_invokes: &[],
        };
        let auths = [MockAuth {
            address: &executor,
            invoke: &invoke,
        }];
        // measured rather than enforced, so a run over the limit reports by how much
        e.cost_estimate().disable_resource_limits();
        e.cost_estimate().budget().reset_unlimited();
        let result = deployed::Client::new(e, &self.arrival)
            .mock_auths(&auths)
            .try_lz_compose(&executor, &self.oft, guid, &0, message, &Bytes::new(e), &0);
        let r = e.cost_estimate().resources();
        let resources = Usage {
            instructions: r.instructions,
            mem_bytes: r.mem_bytes,
            read_entries: r.memory_read_entries + r.disk_read_entries,
            disk_read_entries: r.disk_read_entries,
            write_entries: r.write_entries,
            write_bytes: r.write_bytes,
            events_bytes: r.contract_events_size_bytes,
        };
        let event = self.event();
        Run {
            ok: matches!(result, Ok(Ok(()))),
            resources,
            event,
        }
    }

    fn event(&self) -> Option<Arrived> {
        let me = match xdr::ScAddress::from(&self.arrival) {
            xdr::ScAddress::Contract(id) => id,
            other => panic!("not a contract: {other:?}"),
        };
        for event in self.env.events().all().events() {
            if event.contract_id.as_ref() != Some(&me) {
                continue;
            }
            let xdr::ContractEventBody::V0(body) = &event.body;
            let data = Val::try_from_val(&self.env, &body.data).unwrap();
            let map: Map<Symbol, Val> = Map::try_from_val(&self.env, &data).unwrap();
            let get = |k: &str| map.get(Symbol::new(&self.env, k)).unwrap();
            let guid_val = Val::try_from_val(&self.env, &body.topics[1]).unwrap();
            return Some(Arrived {
                guid: BytesN::try_from_val(&self.env, &guid_val).unwrap(),
                rail: Symbol::try_from_val(&self.env, &get("rail")).unwrap(),
                source: Address::try_from_val(&self.env, &get("source")).unwrap(),
                nonce: u64::try_from_val(&self.env, &get("nonce")).unwrap(),
                src_eid: u32::try_from_val(&self.env, &get("src_eid")).unwrap(),
                sender: BytesN::try_from_val(&self.env, &get("sender")).unwrap(),
                recipient: Address::try_from_val(&self.env, &get("recipient")).unwrap(),
                outcome: Symbol::try_from_val(&self.env, &get("outcome")).unwrap(),
                asset: Address::try_from_val(&self.env, &get("asset")).unwrap(),
                amount: i128::try_from_val(&self.env, &get("amount")).unwrap(),
                fee: i128::try_from_val(&self.env, &get("fee")).unwrap(),
                fee_recipient: None,
                arrived_token: Address::try_from_val(&self.env, &get("arrived_token")).unwrap(),
                arrived_amount: i128::try_from_val(&self.env, &get("arrived_amount")).unwrap(),
                unconverted: i128::try_from_val(&self.env, &get("unconverted")).unwrap(),
            });
        }
        None
    }

    fn tick(&self, pool: &str) -> i32 {
        let slot: Map<Symbol, Val> = self.env.invoke_contract(
            &at(&self.env, pool),
            &Symbol::new(&self.env, "get_slot0"),
            vec![&self.env],
        );
        i32::try_from_val(
            &self.env,
            &slot.get(Symbol::new(&self.env, "tick")).unwrap(),
        )
        .unwrap()
    }

    /// What anyone can do to a pool for the price of some dust and rent: a tiny
    /// position at every tick spacing a swap would cross, so the swap pays for
    /// crossing each one. Pools cap positions per owner, so owners are many.
    fn fragment(&self, pool: &str, positions: i32, up: bool) {
        let e = &self.env;
        let pool_id = at(e, pool);
        let spacing: i32 =
            e.invoke_contract(&pool_id, &Symbol::new(e, "get_tick_spacing"), vec![e]);
        let base = self.tick(pool).div_euclid(spacing) * spacing;
        let tokens: Vec<Address> =
            e.invoke_contract(&pool_id, &Symbol::new(e, "get_tokens"), vec![e]);
        let side = tokens.get(if up { 0 } else { 1 }).unwrap();
        let dust: u128 = 10_000_000;
        e.mock_all_auths();
        e.cost_estimate().disable_resource_limits();
        let mut owner = Address::generate(e);
        for i in 0..positions {
            if i % 20 == 0 {
                owner = Address::generate(e);
                let need = dust as i128 * 20;
                if side == at(e, XLM) {
                    TokenClient::new(e, &side).transfer(&at(e, XLM_HOLDER), &owner, &need);
                } else {
                    StellarAssetClient::new(e, &side).mint(&owner, &need);
                }
            }
            let (lower, upper) = if up {
                (base + spacing * (i + 1), base + spacing * (i + 2))
            } else {
                (base - spacing * (i + 2), base - spacing * (i + 1))
            };
            let amounts = if up {
                vec![e, dust, 0u128]
            } else {
                vec![e, 0u128, dust]
            };
            e.cost_estimate().budget().reset_unlimited();
            let _: Val = e.invoke_contract(
                &pool_id,
                &Symbol::new(e, "deposit_position"),
                (owner.clone(), lower, upper, amounts, 0u128).into_val(e),
            );
        }
        e.set_auths(&[]);
    }
}

/// Within every per-transaction limit mainnet sets (read 2026-10-21), with the
/// instructions held to `share` of the cap.
fn fits(run: &Run, share_pct: i64) {
    let r = &run.resources;
    std::println!("{r:?}");
    assert!(
        r.instructions * 100 <= TX_MAX_INSTRUCTIONS * share_pct,
        "{} instructions is over {share_pct}% of the cap",
        r.instructions
    );
    assert!(r.mem_bytes <= 41_943_040);
    assert!(r.write_entries <= 200);
    assert!(r.read_entries <= 400);
    assert!(r.disk_read_entries <= 200);
    assert!(r.write_bytes <= 132_096);
    assert!(r.events_bytes <= 16_384);
}

#[test]
fn the_largest_conversion_into_xlm_fits_well_inside_the_budget() {
    let mut f = fork();
    let recipient = Address::generate(&f.env);
    let (guid, message) = f.queue(LARGEST_INTO_XLM, true, &recipient);
    let run = f.compose(&guid, &message);
    assert!(run.ok);
    assert_eq!(
        run.event.as_ref().unwrap().outcome,
        Symbol::new(&f.env, "converted")
    );
    assert!(TokenClient::new(&f.env, &at(&f.env, XLM)).balance(&recipient) > 0);
    fits(&run, 30);
}

#[test]
fn the_largest_conversion_into_xlm_fits_through_pools_fragmented_at_every_tick() {
    let mut f = fork();
    // more positions than the swap crosses spacings in either pool
    f.fragment(USDC_XLM, 40, true);
    f.fragment(USDT0_USDC, 20, false);
    let recipient = Address::generate(&f.env);
    let (guid, message) = f.queue(LARGEST_INTO_XLM, true, &recipient);
    let before = f.tick(USDC_XLM);
    let run = f.compose(&guid, &message);
    assert!(run.ok);
    assert_eq!(
        run.event.as_ref().unwrap().outcome,
        Symbol::new(&f.env, "converted")
    );
    // it crossed fewer spacings than there are positions, so every one it crossed was taken
    assert!((f.tick(USDC_XLM) - before) / 20 < 40);
    fits(&run, 50);
}

#[test]
fn an_arrival_above_the_largest_into_xlm_comes_as_it_came_without_touching_a_pool() {
    for amount in [LARGEST_INTO_XLM + 1, 900_000 * 10_000_000] {
        let mut f = fork();
        let recipient = Address::generate(&f.env);
        let (guid, message) = f.queue(amount, true, &recipient);
        let ticks = (f.tick(USDT0_USDC), f.tick(USDC_XLM));
        let run = f.compose(&guid, &message);
        assert!(run.ok);
        let e = run.event.clone().unwrap();
        assert_eq!(e.outcome, Symbol::new(&f.env, "as_came"));
        assert_eq!(e.amount, amount);
        assert_eq!(
            TokenClient::new(&f.env, &at(&f.env, USDT0)).balance(&recipient),
            amount
        );
        assert_eq!(ticks, (f.tick(USDT0_USDC), f.tick(USDC_XLM)));
        fits(&run, 5);
    }
}

#[test]
fn the_largest_conversion_into_usdc_fits_well_inside_the_budget() {
    let mut f = fork();
    let recipient = Address::generate(&f.env);
    let (guid, message) = f.queue(LARGEST_INTO_USDC, false, &recipient);
    let run = f.compose(&guid, &message);
    assert!(run.ok);
    assert_eq!(
        run.event.as_ref().unwrap().outcome,
        Symbol::new(&f.env, "converted")
    );
    fits(&run, 15);

    let mut f = fork();
    f.fragment(USDT0_USDC, 20, false);
    let (guid, message) = f.queue(LARGEST_INTO_USDC, false, &recipient);
    let run = f.compose(&guid, &message);
    assert!(run.ok);
    fits(&run, 15);
}

#[test]
fn an_arrival_above_the_largest_into_usdc_comes_as_it_came() {
    let mut f = fork();
    let recipient = Address::generate(&f.env);
    let (guid, message) = f.queue(LARGEST_INTO_USDC + 1, false, &recipient);
    let run = f.compose(&guid, &message);
    assert!(run.ok);
    assert_eq!(
        run.event.as_ref().unwrap().outcome,
        Symbol::new(&f.env, "as_came")
    );
    fits(&run, 5);
}

#[test]
fn an_overdue_compose_is_delivered_as_it_came_for_a_fraction_of_the_budget() {
    let mut f = fork();
    let recipient = Address::generate(&f.env);
    let amount = 900_000 * 10_000_000;
    let (guid, message) = f.queue(amount, true, &recipient);
    let client = deployed::Client::new(&f.env, &f.arrival);
    client.note(&f.oft, &guid, &0, &message);
    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + crate::OVERDUE_AFTER_LEDGERS);
    f.env.cost_estimate().budget().reset_unlimited();
    client.deliver_overdue(&f.oft, &guid, &0, &message);
    let r = f.env.cost_estimate().resources();
    std::println!("{r:?}");
    assert!(r.instructions * 100 <= TX_MAX_INSTRUCTIONS * 5);
    assert_eq!(
        TokenClient::new(&f.env, &at(&f.env, USDT0)).balance(&recipient),
        amount
    );
    assert_eq!(client.noted(&f.oft, &guid, &0), None);
}
