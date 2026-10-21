//! Contract tests.
//!
//! LayerZero's endpoint here is the real one: the wasm in testdata/ was fetched
//! from Stellar testnet (CALTBA5S...), and mainnet runs byte-identical code
//! (sha256 2411385509a00aeab0aed1236fb9cfa07106fbd8675232382bb15b6b07c704b9).
//! The venue is a stand-in for Aquarius's router with the same swap_chained
//! signature and the same call tree (it pulls token_in from the caller with its
//! own transfer and pays the output to the caller), so the contract's
//! authorization of that transfer is exercised for real, with no auth mocking on
//! the arrival path except the executor's own signature.

extern crate std;

use soroban_sdk::{
    address_payload::AddressPayload,
    contract, contractimpl, contracttype,
    testutils::{
        Address as _, BytesN as _, Events as _, IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, xdr, Address, Bytes, BytesN, Env, IntoVal, Symbol, TryFromVal, Val, Vec,
};

use crate::{
    codec::MESSAGE_VERSION, fee_of, venue_floor, ArrivalContract, ArrivalContractClient, Arrived,
    Error, OVERDUE_AFTER_LEDGERS,
};

mod endpoint {
    soroban_sdk::contractimport!(file = "testdata/layerzero_endpoint_v2.wasm");
}

// ---------------------------------------------------------------- venue double

#[contracttype]
enum VenueKey {
    Rate,
    Reenter,
    // what estimate_swap overstates by, in basis points, so the swap can still
    // refuse after an estimate that cleared the floor
    Optimism,
    // how many times the arrival contract has called it
    Calls,
    // a separate rate for swaps that sell this token, as a swap back does
    Back,
}

/// The rate for a swap selling `token_in`: the back rate when one is set for it.
fn rate_for(env: &Env, token_in: &Address) -> (i128, i128) {
    if let Some((token, num, den)) = env
        .storage()
        .instance()
        .get::<_, (Address, i128, i128)>(&VenueKey::Back)
    {
        if token == *token_in {
            return (num, den);
        }
    }
    env.storage().instance().get(&VenueKey::Rate).unwrap()
}

fn count_call(env: &Env) {
    let calls: u32 = env.storage().instance().get(&VenueKey::Calls).unwrap_or(0);
    env.storage().instance().set(&VenueKey::Calls, &(calls + 1));
}

#[contracttype]
#[derive(Clone)]
struct Reentry {
    arrival: Address,
    executor: Address,
    from: Address,
    guid: BytesN<32>,
    message: Bytes,
}

#[contract]
struct Venue;

#[contractimpl]
impl Venue {
    pub fn set_rate(env: Env, num: i128, den: i128) {
        env.storage().instance().set(&VenueKey::Rate, &(num, den));
    }

    pub fn set_optimism(env: Env, bps: i128) {
        env.storage().instance().set(&VenueKey::Optimism, &bps);
    }

    /// A venue that pays `num / den` for whatever sells `token`; a rate under one
    /// unit per amount sold pays a single unit, as a router keeping the rest would.
    pub fn set_back_rate(env: Env, token: Address, num: i128, den: i128) {
        env.storage()
            .instance()
            .set(&VenueKey::Back, &(token, num, den));
    }

    pub fn calls(env: Env) -> u32 {
        env.storage().instance().get(&VenueKey::Calls).unwrap_or(0)
    }

    pub fn estimate_swap(
        env: Env,
        _tokens: Vec<Address>,
        token_in: Address,
        _token_out: Address,
        _pool_index: BytesN<32>,
        in_amount: u128,
    ) -> u128 {
        count_call(&env);
        let (num, den) = rate_for(&env, &token_in);
        let optimism: i128 = env
            .storage()
            .instance()
            .get(&VenueKey::Optimism)
            .unwrap_or(0);
        ((in_amount as i128 * num / den).max(1) * (10_000 + optimism) / 10_000) as u128
    }

    pub fn set_reenter(env: Env, reentry: Reentry) {
        env.storage().instance().set(&VenueKey::Reenter, &reentry);
    }

    pub fn swap_chained(
        env: Env,
        user: Address,
        swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
        token_in: Address,
        in_amount: u128,
        out_min: u128,
    ) -> u128 {
        count_call(&env);
        user.require_auth();
        let me = env.current_contract_address();
        TokenClient::new(&env, &token_in).transfer(&user, &me, &(in_amount as i128));
        if let Some(r) = env
            .storage()
            .instance()
            .get::<_, Reentry>(&VenueKey::Reenter)
        {
            ArrivalContractClient::new(&env, &r.arrival).lz_compose(
                &r.executor,
                &r.from,
                &r.guid,
                &0,
                &r.message,
                &Bytes::new(&env),
                &0,
            );
        }
        let (num, den) = rate_for(&env, &token_in);
        let out = (in_amount as i128 * num / den).max(1);
        if (out as u128) < out_min {
            panic!("below out_min");
        }
        let (_, _, token_out) = swaps_chain.last().unwrap();
        TokenClient::new(&env, &token_out).transfer(&me, &user, &out);
        out as u128
    }
}

// ---------------------------------------------------------------- harness

struct World {
    env: Env,
    endpoint: Address,
    arrival: Address,
    oft: Address,
    usdt0: Address,
    usdt0_asset: xdr::Asset,
    usdc: Address,
    usdc_asset: xdr::Asset,
    venue: Address,
    executor: Address,
    nonce: u64,
    last_events: std::cell::RefCell<std::vec::Vec<Arrived>>,
}

const SRC_EID: u32 = 30101;

fn sac(env: &Env) -> (Address, xdr::Asset) {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    (sac.address(), sac.asset())
}

/// Larger than any arrival the tests make, so only the tests about the limit meet it.
const NO_LIMIT: i128 = i64::MAX as i128;

fn setup() -> World {
    setup_converting_at_most(NO_LIMIT)
}

fn setup_converting_at_most(largest: i128) -> World {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    let (native, _) = sac(&env);
    let endpoint = env.register(endpoint::WASM, (Address::generate(&env), 40600u32, native));
    // as USDT0's issuer is on mainnet: its holders' balances can be clawed back
    // and frozen, the Arrival Contract's included
    let usdt0_sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    usdt0_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    usdt0_sac
        .issuer()
        .set_flag(IssuerFlags::ClawbackEnabledFlag);
    let (usdt0, usdt0_asset) = (usdt0_sac.address(), usdt0_sac.asset());
    let (usdc, usdc_asset) = sac(&env);
    let oft = Address::generate(&env);
    let venue = env.register(Venue, ());
    VenueClient::new(&env, &venue).set_rate(&1, &1);
    StellarAssetClient::new(&env, &usdc).mint(&venue, &1_000_000_000_000);

    let arrival = env.register(
        ArrivalContract,
        (
            endpoint.clone(),
            venue.clone(),
            vec![&env, (oft.clone(), usdt0.clone())],
            vec![&env, (usdc.clone(), largest)],
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

fn account(env: &Env) -> Address {
    Address::from_payload(
        env,
        AddressPayload::AccountIdPublicKeyEd25519(BytesN::random(env)),
    )
}

fn account_id(address: &Address) -> xdr::AccountId {
    match xdr::ScAddress::from(address) {
        xdr::ScAddress::Account(id) => id,
        other => panic!("not an account: {other:?}"),
    }
}

fn add_entry(env: &Env, key: xdr::LedgerKey, data: xdr::LedgerEntryData) {
    let entry = xdr::LedgerEntry {
        data,
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(&std::rc::Rc::new(key), &std::rc::Rc::new(entry), None)
        .unwrap();
}

fn open_account(env: &Env, address: &Address) {
    let id = account_id(address);
    add_entry(
        env,
        xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
            account_id: id.clone(),
        }),
        xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: id,
            balance: 0,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 0,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
    );
}

fn trust(env: &Env, address: &Address, asset: &xdr::Asset) {
    trust_with(
        env,
        address,
        asset,
        xdr::TrustLineFlags::AuthorizedFlag as u32,
    );
}

fn trust_with(env: &Env, address: &Address, asset: &xdr::Asset, flags: u32) {
    trust_up_to(env, address, asset, flags, i64::MAX);
}

fn trust_up_to(env: &Env, address: &Address, asset: &xdr::Asset, flags: u32, limit: i64) {
    let id = account_id(address);
    let asset = match asset.clone() {
        xdr::Asset::Native => xdr::TrustLineAsset::Native,
        xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a),
        xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a),
    };
    add_entry(
        env,
        xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
            account_id: id.clone(),
            asset: asset.clone(),
        }),
        xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
            account_id: id,
            asset,
            balance: 0,
            limit,
            flags,
            ext: xdr::TrustLineEntryExt::V0,
        }),
    );
}

fn payload(address: &Address) -> (u8, [u8; 32]) {
    match address.to_payload().unwrap() {
        AddressPayload::AccountIdPublicKeyEd25519(b) => (0, b.to_array()),
        AddressPayload::ContractIdHash(b) => (1, b.to_array()),
    }
}

struct Ask {
    recipient: Address,
    wanted: Address,
    min_out: i128,
    fee_bps: u16,
    fee_recipient: Address,
    path: std::vec::Vec<(std::vec::Vec<Address>, [u8; 32], Address)>,
}

fn encode(env: &Env, ask: &Ask) -> Bytes {
    let mut b = std::vec::Vec::new();
    b.push(MESSAGE_VERSION);
    let (k, p) = payload(&ask.recipient);
    b.push(k);
    b.extend_from_slice(&p);
    b.extend_from_slice(&payload(&ask.wanted).1);
    b.extend_from_slice(&ask.min_out.to_be_bytes());
    b.extend_from_slice(&ask.fee_bps.to_be_bytes());
    let (k, p) = payload(&ask.fee_recipient);
    b.push(k);
    b.extend_from_slice(&p);
    b.push(ask.path.len() as u8);
    for (tokens, index, out) in &ask.path {
        b.push(tokens.len() as u8);
        for t in tokens {
            b.extend_from_slice(&payload(t).1);
        }
        b.extend_from_slice(index);
        b.extend_from_slice(&payload(out).1);
    }
    Bytes::from_slice(env, &b)
}

fn envelope(env: &Env, nonce: u64, amount_ld: i128, compose_msg: &Bytes) -> Bytes {
    let mut b = std::vec::Vec::new();
    b.extend_from_slice(&nonce.to_be_bytes());
    b.extend_from_slice(&SRC_EID.to_be_bytes());
    b.extend_from_slice(&amount_ld.to_be_bytes());
    b.extend_from_slice(&[0xab; 32]);
    let mut out = Bytes::from_slice(env, &b);
    out.append(compose_msg);
    out
}

impl World {
    fn client(&self) -> ArrivalContractClient<'_> {
        ArrivalContractClient::new(&self.env, &self.arrival)
    }

    fn token(&self, t: &Address) -> TokenClient<'_> {
        TokenClient::new(&self.env, t)
    }

    fn direct_path(&self) -> std::vec::Vec<(std::vec::Vec<Address>, [u8; 32], Address)> {
        std::vec![(
            std::vec![self.usdt0.clone(), self.usdc.clone()],
            [7u8; 32],
            self.usdc.clone()
        )]
    }

    fn ask(&self, recipient: &Address) -> Ask {
        Ask {
            recipient: recipient.clone(),
            wanted: self.usdc.clone(),
            min_out: 990_000,
            fee_bps: 0,
            fee_recipient: recipient.clone(),
            path: self.direct_path(),
        }
    }

    /// What an OFT's lz_receive does: credit the token to the composer and queue
    /// the compose on the real endpoint under the OFT's own name.
    fn arrive_from(
        &mut self,
        oft: &Address,
        amount: i128,
        compose_msg: &Bytes,
    ) -> (BytesN<32>, Bytes) {
        self.nonce += 1;
        let guid = BytesN::random(&self.env);
        let message = envelope(&self.env, self.nonce, amount, compose_msg);
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.usdt0).mint(&self.arrival, &amount);
        endpoint::Client::new(&self.env, &self.endpoint).send_compose(
            oft,
            &self.arrival,
            &guid,
            &0,
            &message,
        );
        self.env.set_auths(&[]);
        (guid, message)
    }

    /// Queues a compose whose envelope states `amount_ld` without crediting
    /// anything, as only a misbehaving OFT could.
    fn queue_only(&mut self, amount_ld: i128, compose_msg: &Bytes) -> (BytesN<32>, Bytes) {
        self.nonce += 1;
        let guid = BytesN::random(&self.env);
        let message = envelope(&self.env, self.nonce, amount_ld, compose_msg);
        self.env.mock_all_auths();
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

    fn arrive(&mut self, amount: i128, compose_msg: &Bytes) -> (BytesN<32>, Bytes) {
        let oft = self.oft.clone();
        self.arrive_from(&oft, amount, compose_msg)
    }

    fn compose_args(&self, from: &Address, guid: &BytesN<32>, message: &Bytes) -> Vec<Val> {
        (
            self.executor.clone(),
            from.clone(),
            guid.clone(),
            0u32,
            message.clone(),
            Bytes::new(&self.env),
            0i128,
        )
            .into_val(&self.env)
    }

    /// Runs lz_compose with nothing mocked but the executor's signature. Err(None)
    /// is a failure that is not this contract's own error (a token refusing, say).
    fn compose_from(
        &self,
        from: &Address,
        guid: &BytesN<32>,
        message: &Bytes,
    ) -> Result<(), Option<soroban_sdk::Error>> {
        let args = self.compose_args(from, guid, message);
        let invoke = MockAuthInvoke {
            contract: &self.arrival,
            fn_name: "lz_compose",
            args,
            sub_invokes: &[],
        };
        let auths = [MockAuth {
            address: &self.executor,
            invoke: &invoke,
        }];
        let r = self.client().mock_auths(&auths).try_lz_compose(
            &self.executor,
            from,
            guid,
            &0,
            message,
            &Bytes::new(&self.env),
            &0,
        );
        // events are only readable until the next invocation, so they are taken now
        *self.last_events.borrow_mut() = self.read_events();
        match r {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => panic!("conversion error {e:?}"),
            Err(Ok(e)) => Err(Some(e)),
            Err(Err(_)) => Err(None),
        }
    }

    fn compose(
        &self,
        guid: &BytesN<32>,
        message: &Bytes,
    ) -> Result<(), Option<soroban_sdk::Error>> {
        self.compose_from(&self.oft, guid, message)
    }

    /// note(), with nothing mocked: it needs no one's signature.
    fn note(&self, guid: &BytesN<32>, message: &Bytes) -> Result<(), Option<soroban_sdk::Error>> {
        match self.client().try_note(&self.oft, guid, &0, message) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => panic!("conversion error {e:?}"),
            Err(Ok(e)) => Err(Some(e)),
            Err(Err(_)) => Err(None),
        }
    }

    /// deliver_overdue(), with nothing mocked.
    fn overdue(
        &self,
        guid: &BytesN<32>,
        message: &Bytes,
    ) -> Result<(), Option<soroban_sdk::Error>> {
        let r = self
            .client()
            .try_deliver_overdue(&self.oft, guid, &0, message);
        *self.last_events.borrow_mut() = self.read_events();
        match r {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => panic!("conversion error {e:?}"),
            Err(Ok(e)) => Err(Some(e)),
            Err(Err(_)) => Err(None),
        }
    }

    fn queued(&self, guid: &BytesN<32>) -> Option<BytesN<32>> {
        endpoint::Client::new(&self.env, &self.endpoint).compose_queue(
            &self.oft,
            &self.arrival,
            guid,
            &0,
        )
    }

    fn wait(&self, ledgers: u32) {
        self.env
            .ledger()
            .set_sequence_number(self.env.ledger().sequence() + ledgers);
    }

    fn arrived_events(&self) -> std::vec::Vec<Arrived> {
        self.last_events.borrow().clone()
    }

    fn read_events(&self) -> std::vec::Vec<Arrived> {
        let mut found = std::vec::Vec::new();
        for event in self.env.events().all().events() {
            let xdr::ContractEventBody::V0(body) = &event.body;
            let Some(first) = body.topics.first() else {
                continue;
            };
            let topic = Val::try_from_val(&self.env, first).unwrap();
            let Ok(sym) = Symbol::try_from_val(&self.env, &topic) else {
                continue;
            };
            if sym != Symbol::new(&self.env, "arrival") {
                continue;
            }
            let data = Val::try_from_val(&self.env, &body.data).unwrap();
            let map: soroban_sdk::Map<Symbol, Val> =
                soroban_sdk::Map::try_from_val(&self.env, &data).unwrap();
            let get = |k: &str| {
                map.get(Symbol::new(&self.env, k))
                    .unwrap_or_else(|| panic!("no {k} in {:?}", map.keys()))
            };
            let guid_val = Val::try_from_val(&self.env, &body.topics[1]).unwrap();
            found.push(Arrived {
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
                // a None field is left out of the map entirely, not written as void
                fee_recipient: map
                    .get(Symbol::new(&self.env, "fee_recipient"))
                    .map(|v| Address::try_from_val(&self.env, &v).unwrap()),
                arrived_token: Address::try_from_val(&self.env, &get("arrived_token")).unwrap(),
                arrived_amount: i128::try_from_val(&self.env, &get("arrived_amount")).unwrap(),
                unconverted: i128::try_from_val(&self.env, &get("unconverted")).unwrap(),
            });
        }
        found
    }

    fn held(&self) -> (i128, i128) {
        (
            self.token(&self.usdt0).balance(&self.arrival),
            self.token(&self.usdc).balance(&self.arrival),
        )
    }

    fn sym(&self, s: &str) -> Symbol {
        Symbol::new(&self.env, s)
    }
}

fn contract_error(e: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

// ---------------------------------------------------------------- tests

#[test]
fn converts_and_delivers_to_a_contract_recipient() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 0);
    assert_eq!(w.held(), (0, 0));
    let events = w.arrived_events();
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.guid, guid);
    assert_eq!(e.rail, w.sym("layerzero"));
    assert_eq!(e.source, w.oft);
    assert_eq!(e.nonce, 1);
    assert_eq!(e.src_eid, SRC_EID);
    assert_eq!(e.sender, BytesN::from_array(&w.env, &[0xab; 32]));
    assert_eq!(e.recipient, recipient);
    assert_eq!(e.outcome, w.sym("converted"));
    assert_eq!(e.asset, w.usdc);
    assert_eq!(e.amount, 1_000_000);
    assert_eq!(e.fee, 0);
    assert_eq!(e.fee_recipient, None);
    assert_eq!(e.arrived_token, w.usdt0);
    assert_eq!(e.arrived_amount, 1_000_000);
}

#[test]
fn converts_for_an_existing_account_with_a_trustline() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdc_asset);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (0, 0));
    assert_eq!(w.arrived_events()[0].outcome, w.sym("converted"));
}

#[test]
fn delivers_as_it_came_when_the_floor_cannot_be_met() {
    let mut w = setup();
    VenueClient::new(&w.env, &w.venue).set_rate(&98, &100);
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    let venue_usdc = w.token(&w.usdc).balance(&w.venue);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    // the failed swap's pull of usdt0 was rolled back with it
    assert_eq!(w.token(&w.usdt0).balance(&w.venue), 0);
    assert_eq!(w.token(&w.usdc).balance(&w.venue), venue_usdc);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.outcome, w.sym("as_came"));
    assert_eq!(e.asset, w.usdt0);
    assert_eq!(e.amount, 1_000_000);
    assert_eq!(e.fee, 0);
}

#[test]
fn delivers_as_it_came_when_the_venue_refuses_after_an_estimate_that_cleared_the_floor() {
    let mut w = setup();
    let venue = VenueClient::new(&w.env, &w.venue);
    venue.set_rate(&98, &100);
    // the estimate says 1.029x, the swap pays 0.98x, so only the swap's own
    // out_min stands between the user and a delivery under their minimum
    venue.set_optimism(&500);
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    assert_eq!(w.token(&w.usdt0).balance(&w.venue), 0);
    assert_eq!(w.held(), (0, 0));
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn delivers_as_it_came_when_the_issuer_has_not_authorised_the_recipient() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    // the trustline exists, so a balance read works, but a transfer into it fails
    trust_with(&w.env, &recipient, &w.usdc_asset, 0);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdt0).balance(&w.venue), 0);
    assert_eq!(w.held(), (0, 0));
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn delivers_as_it_came_when_the_recipient_cannot_hold_the_wanted_asset() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdt0).balance(&w.venue), 0);
    assert_eq!(w.held(), (0, 0));
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn a_recipient_who_can_hold_neither_leaves_the_compose_queued() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    // the as-came transfer itself is refused by the token, so the whole call
    // reverts: nothing moved and the compose can be finished later
    // 13 is the asset contract's own "trustline entry is missing"
    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(soroban_sdk::Error::from_contract_error(13)))
    );
    assert_eq!(w.held(), (1_000_000, 0));
    let queued =
        endpoint::Client::new(&w.env, &w.endpoint).compose_queue(&w.oft, &w.arrival, &guid, &0);
    assert_eq!(queued, Some(w.env.crypto().keccak256(&message).into()));

    trust(&w.env, &recipient, &w.usdc_asset);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn takes_the_itemised_fee_from_the_conversion() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let integrator = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 25;
    ask.fee_recipient = integrator.clone();
    ask.min_out = 990_000;
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    // floor(1_000_000 * 25 / 10_000) = 2_500
    assert_eq!(w.token(&w.usdc).balance(&integrator), 2_500);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 997_500);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.fee, 2_500);
    assert_eq!(e.fee_recipient, Some(integrator));
    assert_eq!(e.amount, 997_500);
}

#[test]
fn the_fee_never_takes_the_user_below_their_minimum() {
    let mut w = setup();
    // the venue pays exactly 1:1; a 1% fee on 1_000_000 would leave 990_000,
    // one unit under a 990_001 minimum, so the conversion must not happen
    let recipient = Address::generate(&w.env);
    let integrator = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 100;
    ask.fee_recipient = integrator.clone();
    ask.min_out = 990_001;
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&integrator), 0);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn fee_math() {
    assert_eq!(fee_of(1_000_000, 25), 2_500);
    assert_eq!(fee_of(999, 25), 2);
    assert_eq!(fee_of(1_000_000, 0), 0);
    assert_eq!(venue_floor(990_000, 0), Some(990_000));
    assert_eq!(venue_floor(990_000, 100), Some(1_000_000));
    assert_eq!(venue_floor(990_001, 100), Some(1_000_002));
    assert_eq!(venue_floor(1, 9_999), Some(10_000));
    assert_eq!(venue_floor(1, 10_000), None);
    assert_eq!(venue_floor(i128::MAX, 1), None);
    for bps in [0u32, 1, 25, 100, 3_000, 9_999] {
        for min in [1i128, 7, 990_000, 123_456_789] {
            let floor = venue_floor(min, bps).unwrap();
            assert!(floor - fee_of(floor, bps) >= min, "bps {bps} min {min}");
        }
    }
}

#[test]
fn a_fee_recipient_who_cannot_hold_the_asset_stops_the_conversion() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let integrator = account(&w.env);
    open_account(&w.env, &integrator);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 25;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn refuses_a_compose_from_an_oft_not_on_the_allowlist() {
    let mut w = setup();
    let impostor = Address::generate(&w.env);
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive_from(&impostor, 1_000_000, &msg);

    assert_eq!(
        w.compose_from(&impostor, &guid, &message),
        Err(Some(contract_error(Error::NotAllowlisted)))
    );
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 0);
    assert!(w.arrived_events().is_empty());
}

#[test]
fn refuses_a_message_the_endpoint_never_queued() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let attacker = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, _) = w.arrive(1_000_000, &msg);

    // same guid, but the caller swaps in their own recipient
    let forged = envelope(&w.env, 1, 1_000_000, &encode(&w.env, &w.ask(&attacker)));
    assert!(w.compose_from(&w.oft, &guid, &forged).is_err());
    assert_eq!(w.token(&w.usdc).balance(&attacker), 0);
    assert_eq!(w.token(&w.usdt0).balance(&attacker), 0);
    assert_eq!(w.held(), (1_000_000, 0));
}

#[test]
fn a_second_compose_cannot_deliver_twice() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    // a second, unrelated arrival so there is something in the contract to steal
    let other = Address::generate(&w.env);
    let mut other_ask = w.ask(&other);
    other_ask.min_out = 495_000;
    let (other_guid, other_message) = w.arrive(500_000, &encode(&w.env, &other_ask));

    w.compose(&guid, &message).unwrap();
    assert!(w.compose(&guid, &message).is_err());

    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (500_000, 0));
    assert_eq!(w.arrived_events().len(), 0); // events of the failed call are rolled back

    w.compose(&other_guid, &other_message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&other), 500_000);
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn a_venue_that_reenters_cannot_deliver_twice() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    let other = Address::generate(&w.env);
    let (other_guid, other_message) = w.arrive(500_000, &encode(&w.env, &w.ask(&other)));
    w.env.mock_all_auths();
    VenueClient::new(&w.env, &w.venue).set_reenter(&Reentry {
        arrival: w.arrival.clone(),
        executor: w.executor.clone(),
        from: w.oft.clone(),
        guid: other_guid.clone(),
        message: other_message.clone(),
    });
    w.env.set_auths(&[]);

    w.compose(&guid, &message).unwrap();

    // the host refuses re-entry, the swap fails and is rolled back, and the first
    // arrival is delivered as it came; the second stays queued for its own compose
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&other), 0);
    assert_eq!(w.held(), (500_000, 0));
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn a_path_that_does_not_end_in_the_wanted_asset_is_not_attempted() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let (decoy, _) = sac(&w.env);
    let mut ask = w.ask(&recipient);
    ask.path = std::vec![(
        std::vec![w.usdt0.clone(), decoy.clone()],
        [7u8; 32],
        decoy.clone()
    )];
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdt0).balance(&w.venue), 0);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn malformed_instructions_after_the_recipient_deliver_as_it_came() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let mut msg = encode(&w.env, &w.ask(&recipient));
    msg.push_back(0); // trailing garbage
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn a_message_without_a_readable_recipient_is_refused_and_stays_queued() {
    let mut w = setup();
    let msg = Bytes::from_slice(&w.env, &[MESSAGE_VERSION, 9]);
    let (guid, message) = w.arrive(1_000_000, &msg);

    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(contract_error(Error::BadRecipient)))
    );
    assert_eq!(w.held(), (1_000_000, 0));
}

#[test]
fn a_zero_minimum_is_not_a_floor_and_is_not_converted() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.min_out = 0;
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn an_arrival_larger_than_the_limit_is_delivered_as_it_came_without_calling_the_venue() {
    let mut w = setup_converting_at_most(1_000_000);
    let venue = VenueClient::new(&w.env, &w.venue);
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));

    let (guid, message) = w.arrive(1_000_001, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_001);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
    assert_eq!(venue.calls(), 0);

    // the limit itself still converts
    let (guid, message) = w.arrive(1_000_000, &msg);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("converted"));
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn the_constructor_refuses_a_limit_that_converts_nothing_or_a_repeated_asset() {
    let env = Env::default();
    let endpoint = Address::generate(&env);
    let router = Address::generate(&env);
    let oft = Address::generate(&env);
    let token = Address::generate(&env);
    let wanted = Address::generate(&env);
    for list in [
        vec![&env, (wanted.clone(), 0i128)],
        vec![&env, (wanted.clone(), -1i128)],
        vec![&env, (wanted.clone(), 5i128), (wanted.clone(), 6i128)],
    ] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            env.register(
                ArrivalContract,
                (
                    endpoint.clone(),
                    router.clone(),
                    vec![&env, (oft.clone(), token.clone())],
                    list.clone(),
                    Vec::<Address>::new(&env),
                ),
            );
        }));
        assert!(r.is_err());
    }
}

#[test]
fn a_negative_amount_is_refused_and_stays_queued() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (other, other_message) = w.arrive(500, &msg);
    for amount_ld in [-1, i128::MIN] {
        let (guid, message) = w.queue_only(amount_ld, &msg);
        assert_eq!(
            w.compose(&guid, &message),
            Err(Some(contract_error(Error::BadAmount)))
        );
        let slot =
            endpoint::Client::new(&w.env, &w.endpoint).compose_queue(&w.oft, &w.arrival, &guid, &0);
        assert_eq!(slot, Some(w.env.crypto().keccak256(&message).to_bytes()));
    }
    assert_eq!(w.held(), (500, 0));
    w.compose(&other, &other_message).unwrap();
}

#[test]
fn compose_needs_the_executor_signature() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    let r = w.client().try_lz_compose(
        &w.executor,
        &w.oft,
        &guid,
        &0,
        &message,
        &Bytes::new(&w.env),
        &0,
    );
    assert!(r.is_err());
    assert_eq!(w.held(), (1_000_000, 0));
}

#[test]
fn the_constructor_refuses_an_empty_or_duplicated_allowlist() {
    let env = Env::default();
    let endpoint = Address::generate(&env);
    let router = Address::generate(&env);
    let oft = Address::generate(&env);
    let token = Address::generate(&env);
    let empty: Vec<(Address, Address)> = Vec::new(&env);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            ArrivalContract,
            (
                endpoint.clone(),
                router.clone(),
                empty,
                vec![&env, (token.clone(), NO_LIMIT)],
                Vec::<Address>::new(&env),
            ),
        );
    }));
    assert!(r.is_err());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            ArrivalContract,
            (
                endpoint.clone(),
                router.clone(),
                vec![
                    &env,
                    (oft.clone(), token.clone()),
                    (oft.clone(), token.clone()),
                ],
                vec![&env, (token.clone(), NO_LIMIT)],
                Vec::<Address>::new(&env),
            ),
        );
    }));
    assert!(r.is_err());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            ArrivalContract,
            (
                endpoint.clone(),
                router.clone(),
                vec![&env, (oft.clone(), token.clone())],
                Vec::<(Address, i128)>::new(&env),
                Vec::<Address>::new(&env),
            ),
        );
    }));
    assert!(r.is_err());
}

#[test]
fn native_value_from_the_executor_passes_straight_to_the_recipient() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    let native = endpoint::Client::new(&w.env, &w.endpoint).native_token();
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &native).mint(&w.executor, &5_000);
    w.env.set_auths(&[]);

    let args: Vec<Val> = (
        w.executor.clone(),
        w.oft.clone(),
        guid.clone(),
        0u32,
        message.clone(),
        Bytes::new(&w.env),
        5_000i128,
    )
        .into_val(&w.env);
    let transfer = MockAuthInvoke {
        contract: &native,
        fn_name: "transfer",
        args: (w.executor.clone(), recipient.clone(), 5_000i128).into_val(&w.env),
        sub_invokes: &[],
    };
    let invoke = MockAuthInvoke {
        contract: &w.arrival,
        fn_name: "lz_compose",
        args,
        sub_invokes: &[transfer],
    };
    w.client()
        .mock_auths(&[MockAuth {
            address: &w.executor,
            invoke: &invoke,
        }])
        .lz_compose(
            &w.executor,
            &w.oft,
            &guid,
            &0,
            &message,
            &Bytes::new(&w.env),
            &5_000,
        );

    assert_eq!(w.token(&native).balance(&recipient), 5_000);
    assert_eq!(w.token(&native).balance(&w.arrival), 0);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn a_message_the_sdk_writes_decodes_to_what_it_says() {
    // written by encodeArrivalMessage in packages/adapters/layerzero/src/compose.ts,
    // the same bytes its own test pins
    let env = Env::default();
    let hex = "0100\
        85e8c67a3bce389d24603743e1a274c504cac13a9a5e71f2d2212609f5443041\
        adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496\
        000000000000000000000000000f1b30\
        001e\
        01\
        781d6fb6bda4655541c0fe7dc154b6204d0783b9ff4e683efb3997e95c559a24\
        01\
        02\
        649c910ee8bea16a45db1526dee995ba6dd66d0df809b15446c3a6478953391d\
        adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496\
        0707070707070707070707070707070707070707070707070707070707070707\
        adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496";
    let raw: std::vec::Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let at = |s: &str| Address::from_str(&env, s);

    let read = crate::codec::decode_instructions(&env, &Bytes::from_slice(&env, &raw)).unwrap();
    assert_eq!(
        read.recipient,
        at("GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL")
    );
    let c = read.conversion.unwrap();
    let usdc = at("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
    assert_eq!(c.wanted, usdc);
    assert_eq!(c.min_out, 990_000);
    assert_eq!(c.fee_bps, 30);
    assert_eq!(
        c.fee_recipient,
        at("CB4B235WXWSGKVKBYD7H3QKUWYQE2B4DXH7U42B67M4ZP2K4KWNCJS7F")
    );
    assert_eq!(c.path.len(), 1);
    let (tokens, index, out) = c.path.get(0).unwrap();
    assert_eq!(
        tokens,
        vec![
            &env,
            at("CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"),
            usdc.clone()
        ]
    );
    assert_eq!(index, BytesN::from_array(&env, &[7u8; 32]));
    assert_eq!(out, usdc);
}

// ---------------------------------------------------------------- review findings

#[test]
fn a_stranger_cannot_clear_the_arrival_contracts_compose() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    // no auth mocked: someone tries to burn the slot on the endpoint directly
    let r = endpoint::Client::new(&w.env, &w.endpoint)
        .try_clear_compose(&w.arrival, &w.oft, &guid, &0, &message);
    assert!(r.is_err());
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
}

#[test]
fn an_oft_that_overstates_amount_ld_is_paid_from_other_pending_arrivals() {
    // not a defence, a recorded trust assumption: the contract pays the amount the
    // allowlisted OFT's message states, so an OFT (or an upgrade of one) that
    // overstates it spends another arrival still waiting in the contract
    let mut w = setup();
    let a = Address::generate(&w.env);
    let b = Address::generate(&w.env);
    let mut ask_a = w.ask(&a);
    ask_a.min_out = 1;
    let (ga, ma) = w.arrive(1_000_000, &encode(&w.env, &ask_a));
    w.nonce += 1;
    let gb = BytesN::random(&w.env);
    let mut ask_b = w.ask(&b);
    ask_b.min_out = 1;
    let mb = envelope(&w.env, w.nonce, 1_500_000, &encode(&w.env, &ask_b));
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &w.usdt0).mint(&w.arrival, &500_000);
    endpoint::Client::new(&w.env, &w.endpoint).send_compose(&w.oft, &w.arrival, &gb, &0, &mb);
    w.env.set_auths(&[]);
    w.compose(&gb, &mb).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&b), 1_500_000);
    assert!(w.compose(&ga, &ma).is_err());
}

#[contracttype]
enum MalKey {
    Victim,
    Native,
    Thief,
}

/// A token whose balance() spends whatever auth the caller's transaction carries.
#[contract]
struct Mal;

#[contractimpl]
impl Mal {
    pub fn arm(env: Env, victim: Address, native: Address, thief: Address) {
        env.storage().instance().set(&MalKey::Victim, &victim);
        env.storage().instance().set(&MalKey::Native, &native);
        env.storage().instance().set(&MalKey::Thief, &thief);
    }

    pub fn balance(env: Env, _id: Address) -> i128 {
        let victim: Address = env.storage().instance().get(&MalKey::Victim).unwrap();
        let native: Address = env.storage().instance().get(&MalKey::Native).unwrap();
        let thief: Address = env.storage().instance().get(&MalKey::Thief).unwrap();
        let all = TokenClient::new(&env, &native).balance(&victim);
        TokenClient::new(&env, &native).transfer(&victim, &thief, &all);
        0
    }
}

#[test]
fn a_wanted_token_off_the_list_is_never_called_and_cannot_spend_the_executors_auth() {
    let mut w = setup();
    let native = endpoint::Client::new(&w.env, &w.endpoint).native_token();
    let executor = w.executor.clone();
    let thief = Address::generate(&w.env);
    let mal = w.env.register(Mal, ());
    MalClient::new(&w.env, &mal).arm(&executor, &native, &thief);
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &native).mint(&executor, &777_000);
    w.env.set_auths(&[]);

    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.wanted = mal.clone();
    ask.min_out = 1;
    ask.path = std::vec![(
        std::vec![w.usdt0.clone(), mal.clone()],
        [7u8; 32],
        mal.clone()
    )];
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &ask));

    // recording mode, which is what a simulation hands an executor to sign
    w.env.mock_all_auths();
    w.client().lz_compose(
        &executor,
        &w.oft,
        &guid,
        &0,
        &message,
        &Bytes::new(&w.env),
        &0,
    );
    let auths = w.env.auths();
    let events = w.read_events();
    assert_eq!(auths.len(), 1);
    assert!(auths[0].1.sub_invocations.is_empty());
    assert_eq!(events[0].outcome, w.sym("as_came"));
    assert_eq!(w.token(&native).balance(&executor), 777_000);
    assert_eq!(w.token(&native).balance(&thief), 0);
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
}

#[test]
fn a_path_through_a_token_off_the_list_is_not_attempted() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let (stranger, _) = sac(&w.env);
    let mut ask = w.ask(&recipient);
    ask.path = std::vec![
        (
            std::vec![w.usdt0.clone(), stranger.clone()],
            [7u8; 32],
            stranger.clone()
        ),
        (
            std::vec![stranger.clone(), w.usdc.clone()],
            [8u8; 32],
            w.usdc.clone()
        ),
    ];
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &ask));
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn a_fee_above_the_cap_is_not_converted() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let fee_to = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 1_001;
    ask.fee_recipient = fee_to.clone();
    ask.min_out = 1;
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &ask));
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&fee_to), 0);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

#[test]
fn a_path_longer_than_the_cap_is_delivered_as_it_came() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let hop = |from: &Address, to: &Address, i: u8| {
        (std::vec![from.clone(), to.clone()], [i; 32], to.clone())
    };
    let mut ask = w.ask(&recipient);
    // five hops, every token on the list and the path sound
    ask.path = std::vec![
        hop(&w.usdt0, &w.usdc, 1),
        hop(&w.usdc, &w.usdt0, 2),
        hop(&w.usdt0, &w.usdc, 3),
        hop(&w.usdc, &w.usdt0, 4),
        hop(&w.usdt0, &w.usdc, 5),
    ];
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &ask));
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));

    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    // one hop naming four tokens
    ask.path = std::vec![(
        std::vec![
            w.usdt0.clone(),
            w.usdc.clone(),
            w.usdt0.clone(),
            w.usdc.clone()
        ],
        [7u8; 32],
        w.usdc.clone()
    )];
    let (guid, message) = w.arrive(1_000_000, &encode(&w.env, &ask));
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
}

const AUTHORIZED: u32 = xdr::TrustLineFlags::AuthorizedFlag as u32;

#[test]
fn a_recipient_trustline_limit_below_the_conversion_delivers_as_it_came() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 500_000);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    // the venue double trades 1:1 both ways, so swapping back returns it all
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.outcome, w.sym("as_came"));
    assert_eq!(e.asset, w.usdt0);
    assert_eq!(e.amount, 1_000_000);
    assert_eq!(e.fee, 0);
}

#[test]
fn a_swap_back_that_returns_almost_nothing_traps_and_stays_queued() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 500_000);
    // a router that quotes and pays one unit for anything sold back to it
    VenueClient::new(&w.env, &w.venue).set_back_rate(&w.usdc, &1, &1_000_000_000);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(contract_error(Error::NoWayBack)))
    );
    assert_eq!(w.held(), (1_000_000, 0));
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 0);
}

#[test]
fn a_swap_back_within_the_round_trip_allowance_delivers_as_it_came() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 500_000);
    // two pools' worth of a 1% fee on the way back
    VenueClient::new(&w.env, &w.venue).set_back_rate(&w.usdc, &9_801, &10_000);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 980_100);
    assert_eq!(w.arrived_events()[0].outcome, w.sym("as_came"));
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn a_fee_swapped_back_for_almost_nothing_traps_and_stays_queued() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 998_000);
    let integrator = account(&w.env);
    open_account(&w.env, &integrator);
    trust_up_to(&w.env, &integrator, &w.usdc_asset, AUTHORIZED, 1);
    VenueClient::new(&w.env, &w.venue).set_back_rate(&w.usdc, &1, &1_000_000_000);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 20;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(contract_error(Error::NoWayBack)))
    );
    assert_eq!(w.held(), (1_000_000, 0));
}

#[test]
fn an_integrator_trustline_at_its_limit_gives_the_fee_to_the_recipient() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust(&w.env, &recipient, &w.usdc_asset);
    let integrator = account(&w.env);
    open_account(&w.env, &integrator);
    trust_up_to(&w.env, &integrator, &w.usdc_asset, AUTHORIZED, 1);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 20;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&integrator), 0);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.outcome, w.sym("converted"));
    assert_eq!(e.amount, 1_000_000);
    assert_eq!(e.fee, 0);
    assert_eq!(e.fee_recipient, None);
}

#[test]
fn a_fee_neither_side_can_take_goes_back_to_the_recipient_as_it_came() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    // room for the net amount and not a unit more
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 998_000);
    let integrator = account(&w.env);
    open_account(&w.env, &integrator);
    trust_up_to(&w.env, &integrator, &w.usdc_asset, AUTHORIZED, 1);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 20;
    ask.fee_recipient = integrator.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdc).balance(&recipient), 998_000);
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 2_000);
    assert_eq!(w.token(&w.usdc).balance(&integrator), 0);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.outcome, w.sym("converted"));
    assert_eq!(e.amount, 998_000);
    assert_eq!(e.fee, 0);
    assert_eq!(e.unconverted, 2_000);
}

#[test]
fn a_refused_conversion_the_venue_will_not_take_back_stays_queued() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 500_000);
    // estimates now promise 1% more than any swap pays, so the way back, which
    // holds the venue to its estimate, is refused
    VenueClient::new(&w.env, &w.venue).set_optimism(&100);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(contract_error(Error::NoWayBack)))
    );
    assert_eq!(w.held(), (1_000_000, 0));
    let queued =
        endpoint::Client::new(&w.env, &w.endpoint).compose_queue(&w.oft, &w.arrival, &guid, &0);
    assert_eq!(queued, Some(w.env.crypto().keccak256(&message).into()));

    // once the recipient can take it, the same compose completes
    trust(&w.env, &recipient, &w.usdc_asset);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn a_fee_named_for_the_contract_itself_is_not_charged() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let mut ask = w.ask(&recipient);
    ask.fee_bps = 20;
    ask.fee_recipient = w.arrival.clone();
    let msg = encode(&w.env, &ask);
    let (guid, message) = w.arrive(1_000_000, &msg);

    w.compose(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.held(), (0, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.fee, 0);
    assert_eq!(e.fee_recipient, None);
}

mod fork;
mod funds;
mod integrations;
mod math;

// ---------------------------------------------------------------- overdue delivery

/// A compose the conversion can never complete while this holds: the recipient
/// refuses the converted amount and the venue will not take it back.
fn stuck(w: &mut World) -> (Address, BytesN<32>, Bytes) {
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    trust(&w.env, &recipient, &w.usdt0_asset);
    trust_up_to(&w.env, &recipient, &w.usdc_asset, AUTHORIZED, 500_000);
    VenueClient::new(&w.env, &w.venue).set_optimism(&100);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    assert_eq!(
        w.compose(&guid, &message),
        Err(Some(contract_error(Error::NoWayBack)))
    );
    (recipient, guid, message)
}

#[test]
fn an_overdue_compose_is_delivered_as_it_came_exactly_once() {
    let mut w = setup();
    let (recipient, guid, message) = stuck(&mut w);
    let (other, other_message) = w.arrive(700, &encode(&w.env, &w.ask(&recipient)));

    w.note(&guid, &message).unwrap();
    w.wait(OVERDUE_AFTER_LEDGERS);
    w.overdue(&guid, &message).unwrap();

    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
    assert_eq!(w.token(&w.usdc).balance(&recipient), 0);
    assert_eq!(w.held(), (700, 0));
    let e = &w.arrived_events()[0];
    assert_eq!(e.outcome, w.sym("as_came"));
    assert_eq!(e.guid, guid);
    assert_eq!(e.amount, 1_000_000);
    assert_eq!(e.arrived_amount, 1_000_000);
    assert_eq!(e.recipient, recipient);
    // the endpoint's slot is spent, so neither path can pay it again
    assert_ne!(
        w.queued(&guid),
        Some(w.env.crypto().keccak256(&message).to_bytes())
    );
    assert!(w.overdue(&guid, &message).is_err());
    trust(&w.env, &recipient, &w.usdc_asset);
    VenueClient::new(&w.env, &w.venue).set_optimism(&0);
    assert!(w.compose(&guid, &message).is_err());
    assert_eq!(w.held(), (700, 0));
    // the other arrival is untouched and still completes
    w.compose(&other, &other_message).unwrap();
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn an_overdue_delivery_waits_the_full_delay_from_the_note() {
    let mut w = setup();
    let (_, guid, message) = stuck(&mut w);

    assert_eq!(
        w.overdue(&guid, &message),
        Err(Some(contract_error(Error::NotNoted)))
    );
    w.note(&guid, &message).unwrap();
    w.wait(OVERDUE_AFTER_LEDGERS - 1);
    assert_eq!(
        w.overdue(&guid, &message),
        Err(Some(contract_error(Error::NotOverdue)))
    );
    // noting again does not restart or shorten the wait
    w.note(&guid, &message).unwrap();
    w.wait(1);
    w.overdue(&guid, &message).unwrap();
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn only_a_compose_still_waiting_on_the_endpoint_can_be_noted() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);

    // other bytes than the ones queued
    let mut forged = message.clone();
    forged.set(20, forged.get(20).unwrap() ^ 1);
    assert_eq!(
        w.note(&guid, &forged),
        Err(Some(contract_error(Error::NotQueued)))
    );
    // a guid nothing was queued under
    assert_eq!(
        w.note(&BytesN::random(&w.env), &message),
        Err(Some(contract_error(Error::NotQueued)))
    );
    // a compose queued by a sender not on the list
    let stranger = Address::generate(&w.env);
    let (sguid, smessage) = w.arrive_from(&stranger, 5, &msg);
    assert_eq!(
        w.client().try_note(&stranger, &sguid, &0, &smessage),
        Err(Ok(contract_error(Error::NotAllowlisted)))
    );
    // a compose already completed
    w.compose(&guid, &message).unwrap();
    assert_eq!(
        w.note(&guid, &message),
        Err(Some(contract_error(Error::NotQueued)))
    );
}

#[test]
fn completing_a_noted_compose_removes_its_note() {
    let mut w = setup();
    let (recipient, guid, message) = stuck(&mut w);
    w.note(&guid, &message).unwrap();
    assert!(w.client().noted(&w.oft, &guid, &0).is_some());

    trust(&w.env, &recipient, &w.usdc_asset);
    VenueClient::new(&w.env, &w.venue).set_optimism(&0);
    w.compose(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdc).balance(&recipient), 1_000_000);
    assert_eq!(w.client().noted(&w.oft, &guid, &0), None);
    w.wait(OVERDUE_AFTER_LEDGERS);
    assert!(w.overdue(&guid, &message).is_err());
    assert_eq!(w.held(), (0, 0));
}

#[test]
fn an_overdue_delivery_removes_its_note() {
    let mut w = setup();
    let (_, guid, message) = stuck(&mut w);
    w.note(&guid, &message).unwrap();
    w.wait(OVERDUE_AFTER_LEDGERS);
    w.overdue(&guid, &message).unwrap();
    assert_eq!(w.client().noted(&w.oft, &guid, &0), None);
}

#[test]
fn an_overdue_delivery_the_recipient_cannot_take_stays_queued() {
    let mut w = setup();
    let recipient = account(&w.env);
    open_account(&w.env, &recipient);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.arrive(1_000_000, &msg);
    w.note(&guid, &message).unwrap();
    w.wait(OVERDUE_AFTER_LEDGERS);

    assert!(w.overdue(&guid, &message).is_err());
    assert_eq!(w.held(), (1_000_000, 0));
    assert_eq!(
        w.queued(&guid),
        Some(w.env.crypto().keccak256(&message).to_bytes())
    );
    // and runs once it can
    trust(&w.env, &recipient, &w.usdt0_asset);
    w.overdue(&guid, &message).unwrap();
    assert_eq!(w.token(&w.usdt0).balance(&recipient), 1_000_000);
}

#[test]
fn an_overdue_delivery_refuses_a_negative_amount() {
    let mut w = setup();
    let recipient = Address::generate(&w.env);
    let msg = encode(&w.env, &w.ask(&recipient));
    let (guid, message) = w.queue_only(-5, &msg);
    w.note(&guid, &message).unwrap();
    w.wait(OVERDUE_AFTER_LEDGERS);
    assert_eq!(
        w.overdue(&guid, &message),
        Err(Some(contract_error(Error::BadAmount)))
    );
}
