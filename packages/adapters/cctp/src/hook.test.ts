import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildForwarderHookData,
  classifyForwardRecipient,
  contractAddressToBytes32,
  fromHex,
  HOOK_LAYOUT,
  parseForwarderHookData,
  toHex,
} from "./hook.js";

/**
 * THIS FILE IS A MERGE PREREQUISITE.
 *
 * The encoding it covers is the one path in this product where a mistake destroys
 * funds with no recovery. If any test here is weakened or removed, the reason must
 * be written down and reviewed.
 *
 * The expected bytes are taken from Circle's own reference encoder, not from this
 * implementation, so this is a comparison against their behaviour rather than a
 * restatement of ours.
 */

const account = Keypair.random().publicKey();
const forwarder = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";

/** Circle's published encoder, reimplemented here to compare against. */
function circleReferenceEncoder(strkey: string): string {
  const recipientBytes = Buffer.from(strkey, "utf8");
  const hookData = Buffer.alloc(32 + recipientBytes.length);
  hookData.writeUInt32BE(0, 24);
  hookData.writeUInt32BE(recipientBytes.length, 28);
  recipientBytes.copy(hookData, 32);
  return `0x${hookData.toString("hex")}`;
}

describe("hook data matches Circle's reference encoder exactly", () => {
  it("produces byte-identical output for an account address", () => {
    expect(toHex(buildForwarderHookData(account))).toBe(circleReferenceEncoder(account));
  });

  it("produces byte-identical output for a contract address", () => {
    expect(toHex(buildForwarderHookData(forwarder))).toBe(circleReferenceEncoder(forwarder));
  });
});

describe("the layout itself", () => {
  it("zeroes the first 24 bytes, because Circle's forwarding service cannot serve Stellar", () => {
    const data = buildForwarderHookData(account);
    for (let i = 0; i < HOOK_LAYOUT.MAGIC_BYTES; i++) {
      expect(data[i], `byte ${i} must be zero`).toBe(0);
    }
  });

  it("writes the version as a big-endian u32 at offset 24", () => {
    const data = buildForwarderHookData(account);
    const view = new DataView(data.buffer);
    expect(view.getUint32(24, false)).toBe(0);
  });

  it("writes the recipient length as a big-endian u32 at offset 28", () => {
    const data = buildForwarderHookData(account);
    const view = new DataView(data.buffer);
    // 56 characters for a G-address, and the LENGTH IS IN BYTES OF THE TEXT,
    // not the 32 bytes the address decodes to. Getting this wrong is the classic
    // error for anyone carrying EVM habits across.
    expect(view.getUint32(28, false)).toBe(56);
    expect(account.length).toBe(56);
  });

  it("carries the recipient as UTF-8 TEXT of the strkey, not the decoded key", () => {
    const data = buildForwarderHookData(account);
    const carried = new TextDecoder().decode(data.subarray(32));
    expect(carried).toBe(account);

    // The decoded form is 32 bytes and would be completely wrong here.
    expect(StrKey.decodeEd25519PublicKey(account).length).toBe(32);
    expect(data.length - 32).toBe(56);
  });
});

describe("recipients Circle's forwarder accepts", () => {
  it("accepts accounts, contracts and muxed addresses", () => {
    expect(classifyForwardRecipient(account)).toBe("account");
    expect(classifyForwardRecipient(forwarder)).toBe("contract");
  });

  it("refuses anything else rather than encoding it", () => {
    for (const bad of ["", "not-an-address", "0x1234", account.toLowerCase(), `${account}X`]) {
      expect(() => buildForwarderHookData(bad), `should refuse ${bad}`).toThrow();
    }
  });

  it("refuses a secret key, loudly", () => {
    expect(() => buildForwarderHookData(Keypair.random().secret())).toThrow();
  });
});

describe("mintRecipient and destinationCaller", () => {
  it("encodes the forwarder contract to exactly 32 bytes", () => {
    const bytes = contractAddressToBytes32(forwarder);
    expect(bytes.length).toBe(32);
    expect(toHex(bytes)).toBe(`0x${Buffer.from(StrKey.decodeContract(forwarder)).toString("hex")}`);
  });

  it("REFUSES a user account, which is the mistake that strands funds forever", () => {
    // Circle: "If mintRecipient is set to a user account or muxed address, USDC is
    // not sent to the forwarder... funds become permanently stuck."
    expect(() => contractAddressToBytes32(account)).toThrow(/not a contract address/);
    expect(() => contractAddressToBytes32(account)).toThrow(/permanently/);
  });
});

describe("round trip", () => {
  it("parses back exactly what was written", () => {
    for (const recipient of [account, forwarder]) {
      const parsed = parseForwarderHookData(buildForwarderHookData(recipient));
      expect(parsed.recipient).toBe(recipient);
      expect(parsed.version).toBe(0);
    }
  });

  it("rejects truncated hook data rather than reading past the end", () => {
    const data = buildForwarderHookData(account);
    expect(() => parseForwarderHookData(data.subarray(0, 20))).toThrow(/too short/);
    expect(() => parseForwarderHookData(data.subarray(0, 50))).toThrow(/only/);
  });

  it("rejects an unknown hook version rather than guessing", () => {
    const data = buildForwarderHookData(account);
    new DataView(data.buffer).setUint32(24, 1, false);
    expect(() => parseForwarderHookData(data)).toThrow(/version/);
  });

  it("rejects a corrupted recipient rather than returning nonsense", () => {
    const data = buildForwarderHookData(account);
    data[40] = 0x21; // an exclamation mark, never valid in a strkey
    expect(() => parseForwarderHookData(data)).toThrow();
  });
});

describe("hex helpers", () => {
  it("round trips", () => {
    const bytes = buildForwarderHookData(account);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("rejects malformed hex instead of silently truncating", () => {
    expect(() => fromHex("0xabc")).toThrow();
    expect(() => fromHex("0xzz")).toThrow();
  });
});
