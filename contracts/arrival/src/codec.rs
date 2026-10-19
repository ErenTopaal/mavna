use soroban_sdk::{address_payload::AddressPayload, Address, Bytes, BytesN, Env, Vec};

/// Cursor over a byte string that refuses to read past the end instead of panicking,
/// so a malformed message can be answered with a decision rather than a trap.
pub struct Reader<'a> {
    bytes: &'a Bytes,
    at: u32,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a Bytes) -> Self {
        Reader { bytes, at: 0 }
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.at.checked_add(N as u32)?;
        if end > self.bytes.len() {
            return None;
        }
        let mut out = [0u8; N];
        self.bytes.slice(self.at..end).copy_into_slice(&mut out);
        self.at = end;
        Some(out)
    }

    pub fn u8(&mut self) -> Option<u8> {
        self.take::<1>().map(|b| b[0])
    }

    pub fn u16(&mut self) -> Option<u16> {
        self.take::<2>().map(u16::from_be_bytes)
    }

    pub fn u32(&mut self) -> Option<u32> {
        self.take::<4>().map(u32::from_be_bytes)
    }

    pub fn u64(&mut self) -> Option<u64> {
        self.take::<8>().map(u64::from_be_bytes)
    }

    pub fn i128(&mut self) -> Option<i128> {
        self.take::<16>().map(i128::from_be_bytes)
    }

    pub fn bytes32(&mut self, env: &Env) -> Option<BytesN<32>> {
        self.take::<32>().map(|b| BytesN::from_array(env, &b))
    }

    pub fn rest(&mut self) -> Bytes {
        let rest = self.bytes.slice(self.at..);
        self.at = self.bytes.len();
        rest
    }

    pub fn is_done(&self) -> bool {
        self.at == self.bytes.len()
    }
}

/// LayerZero's Stellar OFTComposeMsg, as the OFT writes it in `__receive`
/// (oft-core codec/oft_compose_msg_codec.rs). amount_ld is 16 bytes here, not
/// the 32 the EVM codec uses.
pub struct OftComposeMsg {
    pub nonce: u64,
    pub src_eid: u32,
    pub amount_ld: i128,
    pub compose_from: BytesN<32>,
    pub compose_msg: Bytes,
}

pub fn decode_oft_compose(env: &Env, message: &Bytes) -> Option<OftComposeMsg> {
    let mut r = Reader::new(message);
    let nonce = r.u64()?;
    let src_eid = r.u32()?;
    let amount_ld = r.i128()?;
    let compose_from = r.bytes32(env)?;
    let compose_msg = r.rest();
    Some(OftComposeMsg {
        nonce,
        src_eid,
        amount_ld,
        compose_from,
        compose_msg,
    })
}

pub const MESSAGE_VERSION: u8 = 1;
/// The longest path a conversion may take, and the most tokens a pool hop may
/// name. A message past either is not converted, so a sender cannot spend an
/// executor's budget on a path no venue would quote.
pub const MAX_HOPS: u8 = 4;
pub const MAX_HOP_TOKENS: u8 = 3;
const KIND_ACCOUNT: u8 = 0;
const KIND_CONTRACT: u8 = 1;

/// One pool hop in the venue's swap chain: the pool's token set, its index, and
/// the token this hop pays out. Kept in the router's own tuple shape.
pub type Hop = (Vec<Address>, BytesN<32>, Address);

/// What the user signed on the source chain, beyond who receives it.
#[derive(Clone)]
pub struct Conversion {
    pub wanted: Address,
    pub min_out: i128,
    pub fee_bps: u32,
    pub fee_recipient: Address,
    pub path: Vec<Hop>,
}

/// The recipient is read first and on its own. If it cannot be read there is
/// nobody to deliver to and the caller must refuse; anything wrong after it only
/// costs the conversion, never the delivery.
pub struct Instructions {
    pub recipient: Address,
    pub conversion: Option<Conversion>,
}

fn address(env: &Env, kind: u8, payload: BytesN<32>) -> Option<Address> {
    match kind {
        KIND_ACCOUNT => Some(Address::from_payload(
            env,
            AddressPayload::AccountIdPublicKeyEd25519(payload),
        )),
        KIND_CONTRACT => Some(Address::from_payload(
            env,
            AddressPayload::ContractIdHash(payload),
        )),
        _ => None,
    }
}

fn contract(env: &Env, payload: BytesN<32>) -> Address {
    Address::from_payload(env, AddressPayload::ContractIdHash(payload))
}

/// Mavna compose message v1, big-endian:
/// version u8 | recipient kind u8 | recipient 32 | wanted asset 32 | min_out i128 |
/// fee_bps u16 | fee recipient kind u8 | fee recipient 32 | hop count u8 |
/// hops: (token count u8 | tokens 32 each | pool index 32 | token_out 32)
pub fn decode_instructions(env: &Env, msg: &Bytes) -> Option<Instructions> {
    let mut r = Reader::new(msg);
    if r.u8()? != MESSAGE_VERSION {
        return None;
    }
    let kind = r.u8()?;
    let payload = r.bytes32(env)?;
    let recipient = address(env, kind, payload)?;
    let conversion = decode_conversion(env, &mut r);
    Some(Instructions {
        recipient,
        conversion,
    })
}

fn decode_conversion(env: &Env, r: &mut Reader) -> Option<Conversion> {
    let wanted = contract(env, r.bytes32(env)?);
    let min_out = r.i128()?;
    let fee_bps = r.u16()? as u32;
    let fee_kind = r.u8()?;
    let fee_payload = r.bytes32(env)?;
    let fee_recipient = address(env, fee_kind, fee_payload)?;
    let hops = r.u8()?;
    if hops > MAX_HOPS {
        return None;
    }
    let mut path = Vec::new(env);
    for _ in 0..hops {
        let count = r.u8()?;
        if count > MAX_HOP_TOKENS {
            return None;
        }
        let mut tokens = Vec::new(env);
        for _ in 0..count {
            tokens.push_back(contract(env, r.bytes32(env)?));
        }
        let pool_index = r.bytes32(env)?;
        let token_out = contract(env, r.bytes32(env)?);
        path.push_back((tokens, pool_index, token_out));
    }
    if !r.is_done() {
        return None;
    }
    Some(Conversion {
        wanted,
        min_out,
        fee_bps,
        fee_recipient,
        path,
    })
}
