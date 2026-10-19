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
