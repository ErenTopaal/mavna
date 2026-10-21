//! Mavna's arrival steps, independent of the rail that brought the funds.
//!
//! An entry point (today only LayerZero's `lz_compose`) proves where the funds
//! came from and what the user signed, then hands over an `Arrival`. Another rail
//! can be added later as another entry point without touching anything here.

use soroban_sdk::{
    panic_with_error,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Symbol, Vec,
};

use crate::{
    codec::{Conversion, Instructions},
    errors::Error,
    events::Arrived,
    venue,
};

pub const BPS: i128 = 10_000;
/// The most an integrator fee may take, the same cap the SDK applies. A message
/// asking for more is not converted.
pub const MAX_FEE_BPS: u32 = 1_000;

/// What this contract may convert into and route through, fixed at construction.
/// Nothing outside these lists is ever called: a sender cannot make the contract
/// run code of their choosing inside an executor's transaction.
pub struct Venue {
    pub router: Address,
    /// Each asset it converts into, with the largest arriving amount it converts.
    pub wanted: Vec<(Address, i128)>,
    pub path_tokens: Vec<Address>,
}

impl Venue {
    fn largest(&self, asset: &Address) -> Option<i128> {
        self.wanted
            .iter()
            .find(|(wanted, _)| wanted == asset)
            .map(|(_, largest)| largest)
    }
}

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

#[derive(Clone, Copy)]
pub enum Outcome {
    Converted,
    AsCame,
}

pub fn arrive(env: &Env, venue: &Venue, arrival: Arrival) -> Outcome {
    let recipient = arrival.instructions.recipient.clone();
    let converted = match &arrival.instructions.conversion {
        Some(conversion) if arrival.amount > 0 => convert(env, venue, &arrival, conversion),
        _ => None,
    };
    let delivery = match converted {
        Some(delivery) => delivery,
        None => {
            if arrival.amount > 0 {
                TokenClient::new(env, &arrival.token).transfer(
                    &env.current_contract_address(),
                    &recipient,
                    &arrival.amount,
                );
            }
            Delivery {
                outcome: Outcome::AsCame,
                asset: arrival.token.clone(),
                amount: arrival.amount,
                fee: 0,
                fee_recipient: None,
                unconverted: 0,
            }
        }
    };
    publish(env, &arrival, &recipient, &delivery);
    delivery.outcome
}

struct Delivery {
    outcome: Outcome,
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
/// makes the asset contract's balance read fail. One whose trustline the issuer
/// has not authorised reads fine and still refuses a transfer, so a Stellar
/// asset contract is asked that too; a token that is not one has no such call.
fn can_hold(env: &Env, asset: &Address, who: &Address) -> bool {
    if !matches!(TokenClient::new(env, asset).try_balance(who), Ok(Ok(_))) {
        return false;
    }
    !matches!(
        StellarAssetClient::new(env, asset).try_authorized(who),
        Ok(Ok(false))
    )
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

/// Whether every contract the conversion would touch was fixed at construction.
fn on_lists(venue: &Venue, arriving: &Address, conversion: &Conversion) -> bool {
    if venue.largest(&conversion.wanted).is_none() {
        return false;
    }
    let allowed =
        |t: &Address| t == arriving || venue.largest(t).is_some() || venue.path_tokens.contains(t);
    conversion
        .path
        .iter()
        .all(|(tokens, _, out)| allowed(&out) && tokens.iter().all(|t| allowed(&t)))
}

/// Sends `amount` of `token` from this contract, reporting a refusal instead of
/// trapping. The asset contract's own effects are rolled back when it refuses.
fn pay(env: &Env, token: &TokenClient, to: &Address, amount: i128) -> bool {
    matches!(
        token.try_transfer(&env.current_contract_address(), to, &amount),
        Ok(Ok(()))
    )
}

/// Swaps `amount` of the wanted asset back along the conversion's path into the
/// arriving token and returns what came back. Used when the recipient refuses what
/// the conversion produced, which only a trustline limit can do once `can_hold`
/// has passed: the swap cannot be undone in place, so it is undone through the
/// venue, holding the venue to its own estimate. When that fails too the call
/// traps, which leaves the compose queued for after the recipient raises its limit.
fn swap_back(
    env: &Env,
    venue: &Venue,
    arrival: &Arrival,
    conversion: &Conversion,
    amount: i128,
) -> i128 {
    let mut holding = Vec::new(env);
    holding.push_back(arrival.token.clone());
    for (_, _, token_out) in conversion.path.iter() {
        holding.push_back(token_out);
    }
    let mut back = Vec::new(env);
    for i in (0..conversion.path.len()).rev() {
        let (tokens, pool_index, _) = conversion.path.get_unchecked(i);
        back.push_back((tokens, pool_index, holding.get_unchecked(i)));
    }

    let me = env.current_contract_address();
    let arriving = TokenClient::new(env, &arrival.token);
    let wanted = TokenClient::new(env, &conversion.wanted);
    let before = arriving.balance(&me);
    let wanted_before = wanted.balance(&me);
    let swapped = match venue::estimate(env, &venue.router, &conversion.wanted, amount, &back) {
        Some(estimate) if estimate > 0 => venue::swap(
            env,
            &venue.router,
            &conversion.wanted,
            amount,
            &back,
            estimate,
        ),
        _ => false,
    };
    let returned = arriving.balance(&me) - before;
    // any of it left here would belong to no arrival, so all of it must go back
    if !swapped || returned <= 0 || wanted_before - wanted.balance(&me) != amount {
        panic_with_error!(env, Error::NoWayBack);
    }
    returned
}

/// Attempts the conversion. None means nothing moved and the arrival is to be
/// delivered as it came.
fn convert(
    env: &Env,
    venue: &Venue,
    arrival: &Arrival,
    conversion: &Conversion,
) -> Option<Delivery> {
    let router = &venue.router;
    let recipient = &arrival.instructions.recipient;
    if conversion.min_out <= 0 || conversion.fee_bps > MAX_FEE_BPS {
        return None;
    }
    // A large swap through a concentrated pool can cost more than a transaction
    // may spend, and running out of budget aborts the whole call where no try_
    // can catch it, so the compose would stay queued for good. Above the limit
    // the venue is never called.
    match venue.largest(&conversion.wanted) {
        Some(largest) if arrival.amount <= largest => {}
        _ => return None,
    }
    if conversion.wanted == arrival.token || !path_is_sound(&arrival.token, conversion) {
        return None;
    }
    // checked before anything is called on the wanted asset or a path token
    if !on_lists(venue, &arrival.token, conversion) {
        return None;
    }
    let me = env.current_contract_address();
    // a fee paid to this contract would never leave it, so it is not charged
    let charges_fee = conversion.fee_bps > 0 && conversion.fee_recipient != me;
    let fee_bps = if charges_fee { conversion.fee_bps } else { 0 };
    if !can_hold(env, &conversion.wanted, recipient) {
        return None;
    }
    if charges_fee && !can_hold(env, &conversion.wanted, &conversion.fee_recipient) {
        return None;
    }
    let floor = venue_floor(conversion.min_out, fee_bps)?;
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
    let fee = fee_of(out, fee_bps);
    let net = out - fee;
    if net < conversion.min_out || taken < 0 || taken > arrival.amount {
        // unreachable when the venue honours out_min; trapping reverts the swap and
        // leaves the compose queued rather than delivering under the floor
        panic_with_error!(env, Error::VenueOutsideFloor);
    }
    let mut unconverted = arrival.amount - taken;

    if !pay(env, &wanted, recipient, net) {
        // the recipient's trustline limit has no room for the conversion
        unconverted += swap_back(env, venue, arrival, conversion, out);
        arriving.transfer(&me, recipient, &unconverted);
        return Some(Delivery {
            outcome: Outcome::AsCame,
            asset: arrival.token.clone(),
            amount: unconverted,
            fee: 0,
            fee_recipient: None,
            unconverted: 0,
        });
    }

    // An integrator that cannot take its fee must not hold up the user's funds,
    // so the fee goes to the recipient instead, and failing that back to them as
    // the arriving token.
    let mut amount = net;
    let mut fee_paid = 0;
    if fee > 0 {
        if pay(env, &wanted, &conversion.fee_recipient, fee) {
            fee_paid = fee;
        } else if pay(env, &wanted, recipient, fee) {
            amount += fee;
        } else {
            unconverted += swap_back(env, venue, arrival, conversion, fee);
        }
    }
    if unconverted > 0 {
        arriving.transfer(&me, recipient, &unconverted);
    }
    Some(Delivery {
        outcome: Outcome::Converted,
        asset: conversion.wanted.clone(),
        amount,
        fee: fee_paid,
        fee_recipient: if fee_paid > 0 {
            Some(conversion.fee_recipient.clone())
        } else {
            None
        },
        unconverted,
    })
}

fn publish(env: &Env, arrival: &Arrival, recipient: &Address, delivery: &Delivery) {
    let id = &arrival.identity;
    Arrived {
        guid: id.guid.clone(),
        rail: id.rail.clone(),
        source: id.source.clone(),
        nonce: id.nonce,
        src_eid: id.src_eid,
        sender: id.sender.clone(),
        recipient: recipient.clone(),
        outcome: match delivery.outcome {
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
