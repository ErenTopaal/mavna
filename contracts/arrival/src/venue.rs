use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contractclient, vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

use crate::codec::Hop;

/// The part of Aquarius's router this contract calls, as the deployed router's
/// own interface declares it (mainnet CBQDHNBF..., testnet CBCFTQSP...).
#[allow(dead_code)]
#[contractclient(name = "AquariusRouterClient")]
pub trait AquariusRouter {
    fn swap_chained(
        env: Env,
        user: Address,
        swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
        token_in: Address,
        in_amount: u128,
        out_min: u128,
    ) -> u128;
    fn estimate_swap(
        env: Env,
        tokens: Vec<Address>,
        token_in: Address,
        token_out: Address,
        pool_index: BytesN<32>,
        in_amount: u128,
    ) -> u128;
}

/// What the venue says `amount` of `token_in` buys along `path`, hop by hop,
/// without moving anything. None when any hop will not say.
///
/// Asked before swapping because a swap that fails and rolls back still costs
/// ledger writes the network's simulation does not predict (seen on testnet:
/// 628 bytes simulated, 3764 written), so an executor that simulates first
/// would keep failing the very delivery that is meant to be the safe fallback.
pub fn estimate(
    env: &Env,
    router: &Address,
    token_in: &Address,
    amount: i128,
    path: &Vec<Hop>,
) -> Option<i128> {
    let client = AquariusRouterClient::new(env, router);
    let mut holding = token_in.clone();
    let mut out = u128::try_from(amount).ok()?;
    for (tokens, pool_index, token_out) in path.iter() {
        out = match client.try_estimate_swap(&tokens, &holding, &token_out, &pool_index, &out) {
            Ok(Ok(v)) => v,
            _ => return None,
        };
        holding = token_out;
    }
    i128::try_from(out).ok()
}

/// Swaps `amount` of `token_in` along `path` through the router, refusing anything
/// under `out_min`. Returns false when the venue could not do it; the failed call's
/// own effects are rolled back by the host, so nothing has moved in that case.
pub fn swap(
    env: &Env,
    router: &Address,
    token_in: &Address,
    amount: i128,
    path: &Vec<Hop>,
    out_min: i128,
) -> bool {
    let me = env.current_contract_address();

    // the router pulls token_in from us with its own transfer call, which is not a
    // direct invocation by this contract, so that one transfer is authorized ahead
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token_in.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (me.clone(), router.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);

    let client = AquariusRouterClient::new(env, router);
    matches!(
        client.try_swap_chained(&me, path, token_in, &(amount as u128), &(out_min as u128)),
        Ok(Ok(_))
    )
}
