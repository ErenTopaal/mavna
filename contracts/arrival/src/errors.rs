use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The compose did not come from an OFT this contract was built to accept.
    NotAllowlisted = 1,
    /// The OFT compose envelope could not be read.
    BadComposeMessage = 2,
    /// No recipient could be read from what the user signed.
    BadRecipient = 3,
    /// A negative native value was passed with the compose.
    BadValue = 4,
    /// The venue reported success but left less than the floor. Never expected.
    VenueOutsideFloor = 5,
    /// The constructor was given no OFT, a duplicated OFT, or no wanted asset.
    BadAllowlist = 6,
}
