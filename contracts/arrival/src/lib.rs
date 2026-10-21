#![no_std]
//! The Mavna Arrival Contract.
//!
//! Receives a LayerZero OFT transfer that carries a compose message, and completes
//! Mavna's arrival steps in the same flow: convert into the asset the user asked for
//! with their minimum as a hard floor, take the itemised integrator fee, and send the
//! result to the recipient the user signed for. When the floor cannot be met the
//! arriving token goes to the recipient as it came.
//!
//! There is no administrator. Everything is fixed at construction, nothing can be
//! upgraded, and no entry point moves funds except the arrival itself.

mod arrival;
mod codec;
mod errors;
mod events;
mod venue;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, panic_with_error, token::TokenClient,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

pub use crate::arrival::{fee_of, venue_floor, Outcome};
pub use crate::errors::Error;
pub use crate::events::Arrived;

/// The two calls this contract makes on LayerZero's Stellar endpoint, as the
/// endpoint declares them (endpoint-v2 interfaces/messaging_composer.rs).
#[allow(dead_code)]
#[contractclient(name = "EndpointClient")]
pub trait Endpoint {
    fn clear_compose(
        env: Env,
        composer: Address,
        from: Address,
        guid: BytesN<32>,
        index: u32,
        message: Bytes,
    );
    fn native_token(env: Env) -> Address;
    fn compose_queue(
        env: Env,
        from: Address,
        to: Address,
        guid: BytesN<32>,
        index: u32,
    ) -> Option<BytesN<32>>;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub endpoint: Address,
    pub router: Address,
    /// (OFT, the token that OFT credits). The OFT is what LayerZero names as the
    /// compose sender; the token is what this contract moves.
    pub ofts: Vec<(Address, Address)>,
    /// Assets the contract will convert into, each with the largest arriving amount
    /// it converts into that asset. Anything else, and any larger arrival, is
    /// delivered as it came.
    pub wanted: Vec<(Address, i128)>,
    /// Further tokens a conversion may route through, besides the arriving token
    /// and the wanted assets. A path touching anything else is not attempted.
    pub path_tokens: Vec<Address>,
}

#[contracttype]
enum Key {
    Config,
    /// The ledger a still-queued compose was first noted at, by (OFT, guid, index).
    /// Removed when that compose completes, by either path.
    Noted(Address, BytesN<32>, u32),
}

/// How long a noted compose waits before anyone may deliver it as it came: 7 days
/// at 5 second ledgers. LayerZero's executor runs a compose within seconds of the
/// credit and the sponsor or the sender can finish one at any time, so this only
/// ever pays out a compose the conversion has been unable to complete for a week.
pub const OVERDUE_AFTER_LEDGERS: u32 = 17_280 * 7;

// about 30 days at 5 second ledgers; extended on every arrival so a live contract
// does not get archived between transfers
const TTL_THRESHOLD: u32 = 17_280 * 15;
const TTL_EXTEND_TO: u32 = 17_280 * 30;

#[contract]
pub struct ArrivalContract;

#[contractimpl]
impl ArrivalContract {
    pub fn __constructor(
        env: Env,
        endpoint: Address,
        router: Address,
        ofts: Vec<(Address, Address)>,
        wanted: Vec<(Address, i128)>,
        path_tokens: Vec<Address>,
    ) {
        if ofts.is_empty() || wanted.is_empty() {
            panic_with_error!(&env, Error::BadAllowlist);
        }
        for (i, (asset, largest)) in wanted.iter().enumerate() {
            if largest <= 0 {
                panic_with_error!(&env, Error::BadAllowlist);
            }
            for (j, (other, _)) in wanted.iter().enumerate() {
                if i != j && asset == other {
                    panic_with_error!(&env, Error::BadAllowlist);
                }
            }
        }
        for (i, (oft, _)) in ofts.iter().enumerate() {
            for (j, (other, _)) in ofts.iter().enumerate() {
                if i != j && oft == other {
                    panic_with_error!(&env, Error::BadAllowlist);
                }
            }
        }
        env.storage().instance().set(
            &Key::Config,
            &Config {
                endpoint,
                router,
                ofts,
                wanted,
                path_tokens,
            },
        );
    }

    pub fn config(env: Env) -> Config {
        env.storage().instance().get(&Key::Config).unwrap()
    }

    /// LayerZero's composer entry point, called by an executor (LayerZero's own,
    /// or anyone finishing an overdue delivery).
    ///
    /// The endpoint's clear_compose is what makes this safe to leave open: it only
    /// succeeds for a message the allowlisted OFT queued for this contract, with
    /// exactly these bytes, and only once.
    pub fn lz_compose(
        env: Env,
        executor: Address,
        from: Address,
        guid: BytesN<32>,
        index: u32,
        message: Bytes,
        _extra_data: Bytes,
        value: i128,
    ) {
        // LayerZero's executor account only signs when the composer asks for its auth
        // here, so this is required for the hosted executor to work at all
        executor.require_auth();

        let config = Self::live_config(&env);
        let token = Self::token_from(&env, &config, &from);

        let me = env.current_contract_address();
        EndpointClient::new(&env, &config.endpoint)
            .clear_compose(&me, &from, &guid, &index, &message);
        env.storage()
            .persistent()
            .remove(&Key::Noted(from.clone(), guid.clone(), index));

        let (compose, instructions) = Self::read(&env, &message);

        if value < 0 {
            panic_with_error!(&env, Error::BadValue);
        }
        if value > 0 {
            // never requested by Mavna; passed straight through so nothing stays here
            let native = EndpointClient::new(&env, &config.endpoint).native_token();
            TokenClient::new(&env, &native).transfer(&executor, &instructions.recipient, &value);
        }

        arrival::arrive(
            &env,
            &arrival::Venue {
                router: config.router,
                wanted: config.wanted,
                path_tokens: config.path_tokens,
            },
            arrival::Arrival {
                identity: arrival::Identity {
                    rail: Symbol::new(&env, "layerzero"),
                    source: from,
                    guid,
                    nonce: compose.nonce,
                    src_eid: compose.src_eid,
                    sender: compose.compose_from,
                },
                token,
                amount: compose.amount_ld,
                instructions,
            },
        );
    }

    /// Records that a compose is still waiting, starting its overdue delay. Anyone
    /// may call it, but only for a compose the endpoint holds for this contract
    /// with exactly these bytes, from an OFT on the list; noting it again keeps
    /// the first ledger.
    pub fn note(env: Env, from: Address, guid: BytesN<32>, index: u32, message: Bytes) {
        let config = Self::live_config(&env);
        Self::token_from(&env, &config, &from);
        let me = env.current_contract_address();
        let queued =
            EndpointClient::new(&env, &config.endpoint).compose_queue(&from, &me, &guid, &index);
        if queued != Some(env.crypto().keccak256(&message).to_bytes()) {
            panic_with_error!(&env, Error::NotQueued);
        }
        let key = Key::Noted(from, guid, index);
        if !env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .set(&key, &env.ledger().sequence());
        }
    }

    /// The ledger a compose was noted at, while it is still waiting.
    pub fn noted(env: Env, from: Address, guid: BytesN<32>, index: u32) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&Key::Noted(from, guid, index))
    }

    /// Delivers a compose that has waited `OVERDUE_AFTER_LEDGERS` since it was
    /// noted, as it came: the arriving token, exactly the message's amount, to the
    /// message's own recipient, with no venue call. So a conversion that can never
    /// complete, whatever the reason, cannot hold the funds for good.
    ///
    /// clear_compose spends the endpoint's slot here exactly as in lz_compose, so
    /// a compose is paid once, by whichever path runs first.
    pub fn deliver_overdue(env: Env, from: Address, guid: BytesN<32>, index: u32, message: Bytes) {
        let config = Self::live_config(&env);
        let token = Self::token_from(&env, &config, &from);
        let key = Key::Noted(from.clone(), guid.clone(), index);
        let since: u32 = match env.storage().persistent().get(&key) {
            Some(since) => since,
            None => panic_with_error!(&env, Error::NotNoted),
        };
        if env.ledger().sequence() < since.saturating_add(OVERDUE_AFTER_LEDGERS) {
            panic_with_error!(&env, Error::NotOverdue);
        }

        let me = env.current_contract_address();
        EndpointClient::new(&env, &config.endpoint)
            .clear_compose(&me, &from, &guid, &index, &message);
        env.storage().persistent().remove(&key);

        let (compose, instructions) = Self::read(&env, &message);
        arrival::deliver_as_came(
            &env,
            arrival::Arrival {
                identity: arrival::Identity {
                    rail: Symbol::new(&env, "layerzero"),
                    source: from,
                    guid,
                    nonce: compose.nonce,
                    src_eid: compose.src_eid,
                    sender: compose.compose_from,
                },
                token,
                amount: compose.amount_ld,
                instructions,
            },
        );
    }
}

impl ArrivalContract {
    fn live_config(env: &Env) -> Config {
        let config = Self::config(env.clone());
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        config
    }

    /// The token `from` credits, or a trap when it is not on the list.
    fn token_from(env: &Env, config: &Config, from: &Address) -> Address {
        match config.ofts.iter().find(|(oft, _)| oft == from) {
            Some((_, token)) => token,
            None => panic_with_error!(env, Error::NotAllowlisted),
        }
    }

    fn read(env: &Env, message: &Bytes) -> (codec::OftComposeMsg, codec::Instructions) {
        let compose = match codec::decode_oft_compose(env, message) {
            Some(c) => c,
            None => panic_with_error!(env, Error::BadComposeMessage),
        };
        let instructions = match codec::decode_instructions(env, &compose.compose_msg) {
            Some(i) => i,
            None => panic_with_error!(env, Error::BadRecipient),
        };
        if compose.amount_ld < 0 {
            panic_with_error!(env, Error::BadAmount);
        }
        (compose, instructions)
    }
}
