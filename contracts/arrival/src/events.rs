use soroban_sdk::{contractevent, Address, BytesN, Symbol};

/// One per completed arrival. Topics are ("arrival", guid) so a status reader can
/// find the event for its own message with a topic filter.
#[contractevent(topics = ["arrival"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Arrived {
    #[topic]
    pub guid: BytesN<32>,
    /// Which entry point handled it ("layerzero").
    pub rail: Symbol,
    /// The OFT (or other rail contract) the funds came through.
    pub source: Address,
    pub nonce: u64,
    pub src_eid: u32,
    /// The source-chain sender, as 32 bytes.
    pub sender: BytesN<32>,
    pub recipient: Address,
    /// "converted" or "as_came".
    pub outcome: Symbol,
    /// What the recipient was sent and how much of it.
    pub asset: Address,
    pub amount: i128,
    pub fee: i128,
    pub fee_recipient: Option<Address>,
    pub arrived_token: Address,
    pub arrived_amount: i128,
    pub unconverted: i128,
}
