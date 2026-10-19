/**
 * Delivering a Circle transfer on Stellar from the receiving account itself.
 *
 * With reserves funded by the account (`MAVNA_RESERVE_FUNDING=self`) the
 * sponsor may hold no XLM at all, so it cannot pay `mint_and_forward`. The
 * receiving account signs and pays for it instead, from its own XLM.
 */

/**
 * The inclusion fee bid for the delivery, in stroops. The resource fee comes
 * from simulation on top of it. A testnet delivery was charged 69,257 stroops
 * in total, with a resource fee of 82,612 at most.
 */
export const OWN_DELIVERY_INCLUSION_FEE_STROOPS = 100_000;

/**
 * The most the account is asked to have spare for the delivery, in stroops,
 * and the most a prepared delivery may cost before it is refused unsigned.
 * Several times the measured cost, so a busier network still fits.
 */
export const OWN_DELIVERY_FEE_BUDGET_STROOPS = 1_000_000n;

/** The fee the sponsor bids on a self-funded trustline, in stroops. */
export const OWN_TRUSTLINE_FEE_STROOPS = 1_000n;
