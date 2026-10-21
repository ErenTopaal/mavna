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
    /// The recipient refused the converted asset and the venue would not take it
    /// back, so nothing can be delivered yet. The compose stays queued.
    NoWayBack = 7,
    /// The compose stated a negative amount, which no OFT credits.
    BadAmount = 8,
    /// note() was given a compose the endpoint is not holding for this contract
    /// with exactly these bytes.
    NotQueued = 9,
    /// deliver_overdue() for a compose nobody has noted.
    NotNoted = 10,
    /// deliver_overdue() before the delay since the note has passed.
    NotOverdue = 11,
}
