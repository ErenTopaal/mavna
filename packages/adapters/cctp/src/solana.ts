import { MavnaError, type NetworkId } from "@mavna/core";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";
import { CCTP_CONTRACTS, readableUsdc, STELLAR_DOMAIN } from "./config.js";
import { buildForwarderHookData, contractAddressToBytes32, toHex } from "./hook.js";

/**
 * The burn, on Solana.
 *
 * Loaded on demand, so nothing here sits in the adapter's main chunk: the import
 * happens only once a transfer actually starts on Solana.
 *
 * Built on `@solana/addresses` rather than `@solana/web3.js`. All that is needed
 * is base58 and program-derived addresses, and the monolith drags `ws` plus two
 * optional native builds behind it for a `Connection` class this never uses. The
 * modular package hashes with WebCrypto, so it works in a browser unmodified.
 *
 * Every constant below was read off the chain rather than out of documentation.
 * The instruction discriminator and the account order come from the program's own
 * Anchor IDL, published on-chain at its IDL account; the USDC mint comes from the
 * `LocalToken` record inside CCTP's token minter; and each fixed PDA was derived
 * and then confirmed to exist and to be owned by the expected program on both
 * devnet and mainnet. `scripts/verify-cctp-solana.mjs` re-checks all of it.
 */

export const SOLANA_PROGRAMS = {
  messageTransmitterV2: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  tokenMessengerMinterV2: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  associatedTokenProgram: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  systemProgram: "11111111111111111111111111111111",
} as const;

/**
 * USDC, as CCTP's own token minter reports it, not as a human typed it.
 *
 * Discovered by reading every `LocalToken` account owned by the token messenger
 * minter and taking the mint out of it. Exactly one exists on each network and
 * both report six decimals.
 */
export const SOLANA_USDC: Readonly<Record<NetworkId, string>> = {
  testnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/** First eight bytes of the Anchor discriminator for `deposit_for_burn_with_hook`. */
const DISCRIMINATOR = Uint8Array.from([111, 245, 62, 131, 204, 108, 223, 155]);

export interface SolanaBurnParams {
  readonly amount: bigint;
  readonly stellarRecipient: string;
  readonly network: NetworkId;
  /** The user's wallet address, base58. */
  readonly owner: string;
  /**
   * A fresh keypair's public key, which the CALLER generates and signs with.
   *
   * The burn writes its message into a brand new account. The SDK will not make
   * this for you, because making it means holding a secret key.
   */
  readonly messageSentEventData: string;
  /** Undefined uses the owner's associated token account for USDC. */
  readonly burnTokenAccount: string | undefined;
  readonly maxFee: bigint;
  readonly finality: number | undefined;
}

export interface SolanaAccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface SolanaInstruction {
  readonly programId: string;
  readonly keys: readonly SolanaAccountMeta[];
  /** Base64. Anchor discriminator followed by the Borsh-encoded parameters. */
  readonly data: string;
  readonly describes: string;
  /** Accounts the caller must create and sign with. */
  readonly ephemeralSigners: readonly string[];
}

const encoder = getAddressEncoder();

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const key = (value: string): Uint8Array => new Uint8Array(encoder.encode(address(value)));

/**
 * A Solana address as the 32 bytes CCTP writes into a message, which is how a
 * reader of an attested message compares it against a known program.
 */
export function solanaAddressToBytes32(value: string): Uint8Array {
  return key(value);
}

async function pda(seeds: readonly Uint8Array[], programId: string): Promise<string> {
  const [derived] = await getProgramDerivedAddress({
    programAddress: address(programId),
    // Copied because the callee's signature is mutable. Handing it our own array
    // would let a library reorder the seeds of a burn.
    seeds: [...seeds],
  });
  return derived;
}

/** The owner's associated token account, derived rather than asked for. */
export function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  return pda(
    [key(owner), key(SOLANA_PROGRAMS.tokenProgram), key(mint)],
    SOLANA_PROGRAMS.associatedTokenProgram,
  );
}

/**
 * Build the Solana burn.
 *
 * The same two fields Circle warns about on EVM apply here and are just as
 * unrecoverable: `mint_recipient` and `destination_caller` must both be Circle's
 * Stellar forwarder, never the user. They are `pubkey` in the IDL, but for a
 * Stellar destination they carry the forwarder's contract id as 32 bytes.
 */
export async function buildSolanaBurn(params: SolanaBurnParams): Promise<SolanaInstruction> {
  if (params.amount <= 0n) {
    throw new MavnaError("Refusing to burn a non-positive amount.", { retryable: false });
  }
  if (params.maxFee >= params.amount) {
    throw new MavnaError("The fee ceiling must be smaller than the amount being sent.", {
      retryable: false,
    });
  }

  const tmm = SOLANA_PROGRAMS.tokenMessengerMinterV2;
  const mt = SOLANA_PROGRAMS.messageTransmitterV2;
  const mint = SOLANA_USDC[params.network];

  const forwarder = CCTP_CONTRACTS[params.network].cctpForwarder;
  // Refuses anything that is not a contract address, which is what stops a user
  // account being named as the mint recipient.
  const forwarderBytes = contractAddressToBytes32(forwarder);
  // Validates the recipient before encoding a single byte.
  const hookData = buildForwarderHookData(params.stellarRecipient);

  const finality = params.finality ?? 2000;
  if (finality !== 1000 && finality !== 2000) {
    throw new MavnaError(
      "Finality must be 1000 or 2000; anything else is coerced to one of them and " +
        "pretending otherwise would mislead the caller.",
      { retryable: false },
    );
  }

  const [
    burnTokenAccount,
    senderAuthority,
    denylist,
    messageTransmitter,
    tokenMessenger,
    remoteTokenMessenger,
    tokenMinter,
    localToken,
    eventAuthority,
  ] = await Promise.all([
    params.burnTokenAccount === undefined
      ? associatedTokenAddress(params.owner, mint)
      : Promise.resolve(params.burnTokenAccount),
    pda([text("sender_authority")], tmm),
    pda([text("denylist_account"), key(params.owner)], tmm),
    pda([text("message_transmitter")], mt),
    pda([text("token_messenger")], tmm),
    // Keyed by the DESTINATION domain as decimal text. Stellar is 27.
    pda([text("remote_token_messenger"), text(String(STELLAR_DOMAIN))], tmm),
    pda([text("token_minter")], tmm),
    pda([text("local_token"), key(mint)], tmm),
    pda([text("__event_authority")], tmm),
  ]);

  const keys: SolanaAccountMeta[] = [
    { pubkey: params.owner, isSigner: true, isWritable: false },
    { pubkey: params.owner, isSigner: true, isWritable: true }, // event_rent_payer
    { pubkey: senderAuthority, isSigner: false, isWritable: false },
    { pubkey: burnTokenAccount, isSigner: false, isWritable: true },
    { pubkey: denylist, isSigner: false, isWritable: false },
    { pubkey: messageTransmitter, isSigner: false, isWritable: true },
    { pubkey: tokenMessenger, isSigner: false, isWritable: false },
    { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
    { pubkey: tokenMinter, isSigner: false, isWritable: false },
    { pubkey: localToken, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: params.messageSentEventData, isSigner: true, isWritable: true },
    { pubkey: SOLANA_PROGRAMS.messageTransmitterV2, isSigner: false, isWritable: false },
    { pubkey: SOLANA_PROGRAMS.tokenMessengerMinterV2, isSigner: false, isWritable: false },
    { pubkey: SOLANA_PROGRAMS.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SOLANA_PROGRAMS.systemProgram, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: SOLANA_PROGRAMS.tokenMessengerMinterV2, isSigner: false, isWritable: false },
  ];

  return {
    programId: SOLANA_PROGRAMS.tokenMessengerMinterV2,
    keys,
    data: Buffer.from(
      encodeParams({
        amount: params.amount,
        destinationDomain: STELLAR_DOMAIN,
        mintRecipient: forwarderBytes,
        destinationCaller: forwarderBytes,
        maxFee: params.maxFee,
        minFinalityThreshold: finality,
        hookData,
      }),
    ).toString("base64"),
    describes:
      `Send ${readableUsdc(params.amount)} USDC to ${params.stellarRecipient} on Stellar, ` +
      `via Circle, ${finality === 1000 ? "on the fast path" : "on the standard path"}.`,
    ephemeralSigners: ["message_sent_event_data"],
  };
}

interface Params {
  readonly amount: bigint;
  readonly destinationDomain: number;
  readonly mintRecipient: Uint8Array;
  readonly destinationCaller: Uint8Array;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly hookData: Uint8Array;
}

/**
 * Borsh, by hand and in the IDL's declared field order.
 *
 * Little-endian throughout, `bytes` prefixed with a u32 length. Anchor is
 * strictly positional, so a field out of order is not a decode error on the far
 * side, it is a burn with the wrong arguments.
 */
function encodeParams(p: Params): Uint8Array {
  const out = new Uint8Array(8 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + p.hookData.length);
  const view = new DataView(out.buffer);
  let at = 0;

  out.set(DISCRIMINATOR, at);
  at += 8;

  view.setBigUint64(at, p.amount, true);
  at += 8;

  view.setUint32(at, p.destinationDomain, true);
  at += 4;

  out.set(p.mintRecipient, at);
  at += 32;

  out.set(p.destinationCaller, at);
  at += 32;

  view.setBigUint64(at, p.maxFee, true);
  at += 8;

  view.setUint32(at, p.minFinalityThreshold, true);
  at += 4;

  view.setUint32(at, p.hookData.length, true);
  at += 4;

  out.set(p.hookData, at);
  return out;
}

/** The hex form, for anyone who would rather read the payload than decode base64. */
export function solanaInstructionDataHex(instruction: SolanaInstruction): string {
  return toHex(Uint8Array.from(Buffer.from(instruction.data, "base64")));
}
