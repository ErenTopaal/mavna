//! Mavna's arrival steps, independent of the rail that brought the funds.
//!
//! An entry point (today only LayerZero's `lz_compose`) proves where the funds
//! came from and what the user signed, then hands over an `Arrival`. Another rail
//! can be added later as another entry point without touching anything here.

use soroban_sdk::{panic_with_error, token::TokenClient, Address, BytesN, Env, Symbol};

use crate::{
    codec::{Conversion, Instructions},
    errors::Error,
    events::Arrived,
    venue,
};

pub const BPS: i128 = 10_000;

/// Where the funds came from, for the event. Each rail fills in what it has.
pub struct Identity {
    pub rail: Symbol,
    pub source: Address,
    pub guid: BytesN<32>,
    pub nonce: u64,
    pub src_eid: u32,
    pub sender: BytesN<32>,
}

pub struct Arrival {
    pub identity: Identity,
    /// The token that arrived at this contract, and how much of it this arrival owns.
    pub token: Address,
    pub amount: i128,
    pub instructions: Instructions,
}

pub enum Outcome {
    Converted,
    AsCame,
}

pub fn arrive(env: &Env, router: &Address, arrival: Arrival) -> Outcome {
    let recipient = arrival.instructions.recipient.clone();
    let converted = match &arrival.instructions.conversion {
        Some(conversion) if arrival.amount > 0 => convert(env, router, &arrival, conversion),
        _ => None,
    };
    match converted {
        Some(delivery) => {
            publish(env, &arrival, &recipient, &delivery, Outcome::Converted);
            Outcome::Converted
        }
        None => {
            if arrival.amount > 0 {
                TokenClient::new(env, &arrival.token).transfer(
                    &env.current_contract_address(),
                    &recipient,
                    &arrival.amount,
                );
            }
            let delivery = Delivery {
                asset: arrival.token.clone(),
                amount: arrival.amount,
                fee: 0,
                fee_recipient: None,
                unconverted: 0,
            };
            publish(env, &arrival, &recipient, &delivery, Outcome::AsCame);
            Outcome::AsCame
        }
    }
}

struct Delivery {
    asset: Address,
    amount: i128,
    fee: i128,
    fee_recipient: Option<Address>,
    /// Arriving token the venue did not take, passed on to the recipient as it came.
    unconverted: i128,
}

/// The smallest venue output that still leaves `min_out` after the fee.
/// ceil(min_out * BPS / (BPS - fee_bps)), so floor(out * fee_bps / BPS) never eats
/// into the user's minimum.
pub fn venue_floor(min_out: i128, fee_bps: u32) -> Option<i128> {
    let keep = BPS.checked_sub(fee_bps as i128)?;
    if keep <= 0 {
        return None;
    }
    let scaled = min_out.checked_mul(BPS)?.checked_add(keep - 1)?;
    Some(scaled / keep)
}

pub fn fee_of(out: i128, fee_bps: u32) -> i128 {
    out * fee_bps as i128 / BPS
}

/// Can `who` receive `asset` right now. A classic account without a trustline
/// makes the asset contract's balance read fail, which is the question asked here.
fn can_hold(env: &Env, asset: &Address, who: &Address) -> bool {
    matches!(TokenClient::new(env, asset).try_balance(who), Ok(Ok(_)))
}

fn path_is_sound(arriving: &Address, conversion: &Conversion) -> bool {
    let hops = conversion.path.len();
    if hops == 0 {
        return false;
    }
    let mut holding = arriving.clone();
    for (tokens, _, token_out) in conversion.path.iter() {
        if tokens.len() < 2 || !tokens.contains(&holding) || !tokens.contains(&token_out) {
            return false;
        }
        if token_out == holding {
            return false;
        }
        holding = token_out;
    }
    holding == conversion.wanted
}

/// Attempts the conversion. None means nothing moved and the arrival is to be
/// delivered as it came.
fn convert(
    env: &Env,
    router: &Address,
    arrival: &Arrival,
    conversion: &Conversion,
) -> Option<Delivery> {
    let recipient = &arrival.instructions.recipient;
    if conversion.min_out <= 0 || conversion.fee_bps as i128 >= BPS {
        return None;
    }
    if conversion.wanted == arrival.token || !path_is_sound(&arrival.token, conversion) {
        return None;
    }
    let charges_fee = conversion.fee_bps > 0;
    if !can_hold(env, &conversion.wanted, recipient) {
        return None;
    }
    if charges_fee && !can_hold(env, &conversion.wanted, &conversion.fee_recipient) {
        return None;
    }
    let floor = venue_floor(conversion.min_out, conversion.fee_bps)?;
    match venue::estimate(
        env,
        router,
        &arrival.token,
        arrival.amount,
        &conversion.path,
    ) {
        Some(estimate) if estimate >= floor => {}
        _ => return None,
    }

    let me = env.current_contract_address();
    let wanted = TokenClient::new(env, &conversion.wanted);
    let arriving = TokenClient::new(env, &arrival.token);
    let wanted_before = wanted.balance(&me);
    let arriving_before = arriving.balance(&me);

    if !venue::swap(
        env,
        router,
        &arrival.token,
        arrival.amount,
        &conversion.path,
        floor,
    ) {
        return None;
    }

    // measured, not taken from the router's return value
    let out = wanted.balance(&me) - wanted_before;
    let taken = arriving_before - arriving.balance(&me);
    let fee = fee_of(out, conversion.fee_bps);
    let net = out - fee;
    if net < conversion.min_out || taken < 0 || taken > arrival.amount {
        // unreachable when the venue honours out_min; trapping reverts the swap and
        // leaves the compose queued rather than delivering under the floor
        panic_with_error!(env, Error::VenueOutsideFloor);
    }

    wanted.transfer(&me, recipient, &net);
    if fee > 0 {
        wanted.transfer(&me, &conversion.fee_recipient, &fee);
    }
    let unconverted = arrival.amount - taken;
    if unconverted > 0 {
        arriving.transfer(&me, recipient, &unconverted);
    }
    Some(Delivery {
        asset: conversion.wanted.clone(),
        amount: net,
        fee,
        fee_recipient: if charges_fee {
            Some(conversion.fee_recipient.clone())
        } else {
            None
        },
        unconverted,
    })
}

fn publish(
    env: &Env,
    arrival: &Arrival,
    recipient: &Address,
    delivery: &Delivery,
    outcome: Outcome,
) {
    let id = &arrival.identity;
    Arrived {
        guid: id.guid.clone(),
        rail: id.rail.clone(),
        source: id.source.clone(),
        nonce: id.nonce,
        src_eid: id.src_eid,
        sender: id.sender.clone(),
        recipient: recipient.clone(),
        outcome: match outcome {
            Outcome::Converted => Symbol::new(env, "converted"),
            Outcome::AsCame => Symbol::new(env, "as_came"),
        },
        asset: delivery.asset.clone(),
        amount: delivery.amount,
        fee: delivery.fee,
        fee_recipient: delivery.fee_recipient.clone(),
        arrived_token: arrival.token.clone(),
        arrived_amount: arrival.amount,
        unconverted: delivery.unconverted,
    }
    .publish(env);
}
