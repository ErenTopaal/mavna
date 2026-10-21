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
}

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

        let config = Self::config(env.clone());
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        let token = match config.ofts.iter().find(|(oft, _)| *oft == from) {
            Some((_, token)) => token,
            None => panic_with_error!(&env, Error::NotAllowlisted),
        };

        let me = env.current_contract_address();
        EndpointClient::new(&env, &config.endpoint)
            .clear_compose(&me, &from, &guid, &index, &message);

        let compose = match codec::decode_oft_compose(&env, &message) {
            Some(c) => c,
            None => panic_with_error!(&env, Error::BadComposeMessage),
        };
        let instructions = match codec::decode_instructions(&env, &compose.compose_msg) {
            Some(i) => i,
            None => panic_with_error!(&env, Error::BadRecipient),
        };

        if value < 0 {
            panic_with_error!(&env, Error::BadValue);
        }
        if compose.amount_ld < 0 {
            panic_with_error!(&env, Error::BadAmount);
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
}
