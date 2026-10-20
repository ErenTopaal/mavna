import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hideBufferFrom } from "./__fixtures__/no-buffer.js";
import { CCTP_CONTRACTS, STELLAR_DOMAIN } from "./config.js";
import { contractAddressToBytes32, toHex } from "./hook.js";
import {
  associatedTokenAddress,
  buildSolanaBurn,
  SOLANA_PROGRAMS,
  SOLANA_USDC,
  solanaAddressToBytes32,
  solanaInstructionDataHex,
} from "./solana.js";

/**
 * MERGE PREREQUISITE, same standing as the EVM burn.
 *
 * The two fields Circle warns about are the same on Solana and just as
 * unrecoverable, so they are asserted the same way. `scripts/verify-cctp-solana.mjs`
 * covers the other half: that the discriminator and account order still match the
 * program's own on-chain IDL.
 */

const RECIPIENT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVENT_ACCOUNT = "AaXs7cLGcSVAsEt8QxstVrqhLhYN2iGhFNRemwYnHitV";

const base = {
  amount: 25_000_000n,
  stellarRecipient: RECIPIENT,
  network: "testnet" as const,
  owner: OWNER,
  messageSentEventData: EVENT_ACCOUNT,
  burnTokenAccount: undefined,
  maxFee: 0n,
  finality: undefined,
};

describe("the Solana burn", () => {
  it("points mint_recipient at Circle's forwarder, NOT at the user", async () => {
    const instruction = await buildSolanaBurn(base);
    const data = Buffer.from(instruction.data, "base64");
    // 8 discriminator, 8 amount, 4 destination domain, then the 32-byte recipient.
    const mintRecipient = toHex(new Uint8Array(data.subarray(20, 52)));
    expect(mintRecipient).toBe(
      toHex(contractAddressToBytes32(CCTP_CONTRACTS.testnet.cctpForwarder)),
    );
  });

  it("sets destination_caller to the same forwarder, never zero", async () => {
    const data = Buffer.from((await buildSolanaBurn(base)).data, "base64");
    const mintRecipient = data.subarray(20, 52);
    const destinationCaller = data.subarray(52, 84);
    expect(destinationCaller.equals(mintRecipient)).toBe(true);
    expect(destinationCaller.every((b) => b === 0)).toBe(false);
  });

  it("carries the real recipient in the hook data instead", async () => {
    const data = Buffer.from((await buildSolanaBurn(base)).data, "base64");
    // amount, domain, recipient, caller, max fee, finality, then a u32 length.
    const hookLength = data.readUInt32LE(96);
    const hook = data.subarray(100, 100 + hookLength);
    // The recipient travels as UTF-8 text of the strkey, at offset 32.
    expect(hook.subarray(32).toString("utf8")).toBe(RECIPIENT);
  });

  it("encodes the amount and Stellar's domain little-endian", async () => {
    const data = Buffer.from((await buildSolanaBurn(base)).data, "base64");
    expect(data.readBigUInt64LE(8)).toBe(25_000_000n);
    expect(data.readUInt32LE(16)).toBe(STELLAR_DOMAIN);
  });

  it("lists eighteen accounts in the order the program expects", async () => {
    const instruction = await buildSolanaBurn(base);
    expect(instruction.keys).toHaveLength(18);
    expect(instruction.programId).toBe(SOLANA_PROGRAMS.tokenMessengerMinterV2);
    expect(instruction.keys[10]?.pubkey).toBe(SOLANA_USDC.testnet);
    expect(instruction.keys[12]?.pubkey).toBe(SOLANA_PROGRAMS.messageTransmitterV2);
    expect(instruction.keys[14]?.pubkey).toBe(SOLANA_PROGRAMS.tokenProgram);
    expect(instruction.keys[15]?.pubkey).toBe(SOLANA_PROGRAMS.systemProgram);
  });

  it("names the accounts the caller has to sign for", async () => {
    const instruction = await buildSolanaBurn(base);
    const signers = instruction.keys.filter((k) => k.isSigner).map((k) => k.pubkey);
    expect(signers).toContain(OWNER);
    expect(signers).toContain(EVENT_ACCOUNT);
    // Said out loud, because a caller who misses this discovers it as a failed
    // signature rather than as a missing argument.
    expect(instruction.ephemeralSigners).toEqual(["message_sent_event_data"]);
  });

  it("uses the owner's associated token account when not told otherwise", async () => {
    const expected = await associatedTokenAddress(OWNER, SOLANA_USDC.testnet);
    const instruction = await buildSolanaBurn(base);
    expect(instruction.keys[3]?.pubkey).toBe(expected);

    const overridden = await buildSolanaBurn({ ...base, burnTokenAccount: EVENT_ACCOUNT });
    expect(overridden.keys[3]?.pubkey).toBe(EVENT_ACCOUNT);
  });

  it("burns a different mint on mainnet than on testnet", async () => {
    const testnet = await buildSolanaBurn(base);
    const mainnet = await buildSolanaBurn({ ...base, network: "mainnet" });
    expect(mainnet.keys[10]?.pubkey).not.toBe(testnet.keys[10]?.pubkey);
  });

  it("refuses a fee ceiling that would eat the whole transfer", async () => {
    await expect(buildSolanaBurn({ ...base, maxFee: 25_000_000n })).rejects.toThrow(/fee ceiling/);
  });
});

describe("a Solana address as CCTP carries it", () => {
  it("is the 32 raw bytes of the base58 key", () => {
    // The system program is the all-zero key, so its encoding is known exactly.
    expect(toHex(solanaAddressToBytes32(SOLANA_PROGRAMS.systemProgram))).toBe(
      `0x${"00".repeat(32)}`,
    );
    expect(solanaAddressToBytes32(SOLANA_PROGRAMS.tokenMessengerMinterV2)).toHaveLength(32);
  });

  it("refuses something that is not a Solana address", () => {
    expect(() => solanaAddressToBytes32("not-an-address")).toThrow();
  });
});

describe("the Solana burn without Node's Buffer, as in a browser", () => {
  it("builds the same instruction and reads it back as hex", async () => {
    const withNode = await buildSolanaBurn(base);
    const restore = hideBufferFrom(fileURLToPath(new URL(".", import.meta.url)));
    try {
      const instruction = await buildSolanaBurn(base);
      expect(instruction.data).toBe(withNode.data);
      expect(solanaInstructionDataHex(instruction)).toBe(
        toHex(new Uint8Array(Buffer.from(withNode.data, "base64"))),
      );
    } finally {
      restore();
    }
  });
});
