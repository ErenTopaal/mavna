import { describe, expect, it } from "vitest";
import {
  decodeAddress,
  decodeBool,
  decodeString,
  decodeUint,
  encodeCall,
  encodeStellarDestination,
  encodeStringCall,
  SELECTORS,
} from "./abi.js";
import { scaleAcrossDecimals } from "./adapter.js";
import { buildAddGas } from "./gmp.js";
import { needsApproval, TOKEN_MANAGER } from "./token.js";
import { buildApproval, buildInterchainTransfer, readable } from "./transfer.js";

/**
 * The parts that decide where money goes, tested without a network.
 *
 * Everything the adapter learns at runtime is checked against the live chains in
 * `adapter.live.test.ts`, because a recorded answer from Axelar proves nothing
 * about Axelar. What is here is the arithmetic and the encoding: things with one
 * right answer that can be stated in advance, and where being wrong is silent.
 */

const STELLAR_ACCOUNT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
const AXE_TOKEN_ID = "0x1600ee6a7b3810f8a277226b0f3a54cc9f92eb2e0456fc64578a78762ab7f838";
const TOKEN_SERVICE = "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C";

describe("the destination encoding", () => {
  it("matches the worked example Axelar publishes", () => {
    // Straight from their own `common/README.md`, which the token service's
    // source links to as the encoding reference. Their output, not ours.
    expect(encodeStellarDestination("CC6FYRUBDJVTATQ55KGPMD2JQFY775BTSJQMRNJEWPEJFUXPOBFSMEOX")).toBe(
      "0x4343364659525542444a565441545135354b47504d44324a5146593737354254534a514d524e4a455750454a465558504f4246534d454f58",
    );
  });

  it("matches what a real delivered transfer actually carried", () => {
    // Read off Axelar's record of a transfer that landed on Stellar testnet, so
    // this is the encoding as the contract accepted it rather than as documented.
    expect(encodeStellarDestination("CBCUM3NTEZJ3HJIKUWRLF45VH5VIP4DDRYZNURG45V6J6KETUNCYBESE")).toBe(
      "0x434243554d334e54455a4a33484a494b5557524c46343556483556495034444452595a4e555247343556364a364b4554554e435942455345",
    );
  });

  it("encodes an account address as its own letters, not as decoded bytes", () => {
    const encoded = encodeStellarDestination(STELLAR_ACCOUNT);
    expect(Buffer.from(encoded.slice(2), "hex").toString("ascii")).toBe(STELLAR_ACCOUNT);
    // 56 characters in, 56 bytes out. A base32 decode would give 32.
    expect((encoded.length - 2) / 2).toBe(56);
  });

  it("refuses anything that is not a strkey", () => {
    expect(() => encodeStellarDestination("0x1234")).toThrow(/strkey/);
    expect(() => encodeStellarDestination("")).toThrow(/strkey/);
  });
});

describe("the ABI coding, against calldata produced independently", () => {
  it("encodes a bytes32 argument", () => {
    expect(encodeCall(SELECTORS.registeredTokenAddress, [AXE_TOKEN_ID.slice(2)])).toBe(
      "0xb90d6afd1600ee6a7b3810f8a277226b0f3a54cc9f92eb2e0456fc64578a78762ab7f838",
    );
  });

  it("encodes a string argument with its offset and padding", () => {
    expect(encodeStringCall(SELECTORS.isTrustedChain, "stellar-2026-q1-2")).toBe(
      "0xcaca8dbe0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000011" +
        "7374656c6c61722d323032362d71312d32000000000000000000000000000000",
    );
  });

  it("pads a string that spills past one word", () => {
    // Thirty-three characters, so the data occupies two words and the second is
    // mostly padding. Getting this wrong shifts every byte after it.
    expect(encodeStringCall(SELECTORS.isTrustedChain, "abcdefghijklmnopqrstuvwxyz0123456")).toBe(
      "0xcaca8dbe0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000021" +
        "6162636465666768696a6b6c6d6e6f707172737475767778797a3031323334353600000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("decodes an address out of its word", () => {
    expect(
      decodeAddress("0x000000000000000000000000671cd182bb1f4f6c7cfcf47d6c6beddda1bb1130"),
    ).toBe("0x671cd182bb1f4f6c7cfcf47d6c6beddda1bb1130");
  });

  it("decodes the second word of a two-value return", () => {
    // getImplementationTypeAndTokenAddress, as hyperliquid actually answered it.
    const answer =
      "0x0000000000000000000000000000000000000000000000000000000000000000" +
      "000000000000000000000000671cd182bb1f4f6c7cfcf47d6c6beddda1bb1130";
    expect(decodeUint(answer, 0)).toBe(0n);
    expect(decodeAddress(answer, 1)).toBe("0x671cd182bb1f4f6c7cfcf47d6c6beddda1bb1130");
  });

  it("decodes a bool", () => {
    expect(
      decodeBool("0x0000000000000000000000000000000000000000000000000000000000000001"),
    ).toBe(true);
    expect(
      decodeBool("0x0000000000000000000000000000000000000000000000000000000000000000"),
    ).toBe(false);
  });

  it("decodes a string, honouring its offset", () => {
    // The live answer to `symbol()` on hyperliquid's AXE.
    const answer =
      "0x0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "4158450000000000000000000000000000000000000000000000000000000000";
    expect(decodeString(answer)).toBe("AXE");
  });

  it("refuses a response that is not whole words", () => {
    expect(() => decodeUint("0x1234")).toThrow(/partial word/);
  });

  it("refuses to read past the end of a response", () => {
    const oneWord = `0x${"00".repeat(32)}`;
    expect(() => decodeAddress(oneWord, 1)).toThrow(/past the end/);
  });
});

describe("gas, which cannot be left out", () => {
  const base = {
    tokenService: TOKEN_SERVICE,
    tokenId: AXE_TOKEN_ID,
    destinationChain: "stellar-2026-q1-2",
    destination: STELLAR_ACCOUNT,
    amount: 10_000_000n,
    symbol: "AXE",
    decimals: 7,
  };

  it("refuses to build a transfer that pays nothing for delivery", () => {
    // The contract emits the message anyway when the gas value is zero, taking
    // the tokens and leaving nothing to pay for moving them.
    expect(() => buildInterchainTransfer({ ...base, gasValue: 0n })).toThrow(/no delivery payment/);
    expect(() => buildInterchainTransfer({ ...base, gasValue: -1n })).toThrow(
      /no delivery payment/,
    );
  });

  it("carries the gas value as the call's value, exactly", () => {
    const call = buildInterchainTransfer({ ...base, gasValue: 842_003n });
    // Sending more than the gas value leaves the surplus in the contract, and
    // sending less reverts. They are the same number on purpose.
    expect(call.value).toBe(842_003n);
    expect(call.args[5]).toBe(842_003n);
  });

  it("sends empty metadata, so nothing is executed at the far end", () => {
    const call = buildInterchainTransfer({ ...base, gasValue: 1n });
    expect(call.args[4]).toBe("0x");
  });

  it("uses the six-argument form, which is the one deployed everywhere", () => {
    const call = buildInterchainTransfer({ ...base, gasValue: 1n });
    expect(call.args).toHaveLength(6);
    expect(call.functionName).toBe("interchainTransfer");
  });

  it("refuses a non-positive amount", () => {
    expect(() => buildInterchainTransfer({ ...base, amount: 0n, gasValue: 1n })).toThrow(
      /non-positive/,
    );
  });

  it("refuses an empty destination chain, which would be a stale name", () => {
    expect(() =>
      buildInterchainTransfer({ ...base, destinationChain: "", gasValue: 1n }),
    ).toThrow(/destination chain/);
  });

  it("says what it will do in terms a person can weigh", () => {
    const call = buildInterchainTransfer({ ...base, gasValue: 1n });
    expect(call.describes).toContain("1 AXE");
    expect(call.describes).toContain(STELLAR_ACCOUNT);
    expect(call.describes).not.toMatch(/gasValue|tokenId|interchainTransfer/);
  });
});

describe("the approval, and who it names", () => {
  it("is needed only for the kinds the service pulls with an allowance", () => {
    // The enum ordering is not the obvious one, which is the whole point of
    // testing every value rather than a representative two.
    expect(needsApproval(TOKEN_MANAGER.nativeInterchainToken)).toBe(false);
    expect(needsApproval(TOKEN_MANAGER.mintBurn)).toBe(false);
    expect(needsApproval(TOKEN_MANAGER.mintBurnFrom)).toBe(true);
    expect(needsApproval(TOKEN_MANAGER.lockUnlock)).toBe(true);
    expect(needsApproval(TOKEN_MANAGER.lockUnlockFee)).toBe(true);
  });

  it("keeps Axelar's own enum ordering, which is not alphabetical or obvious", () => {
    expect(TOKEN_MANAGER.nativeInterchainToken).toBe(0);
    expect(TOKEN_MANAGER.mintBurnFrom).toBe(1);
    expect(TOKEN_MANAGER.lockUnlock).toBe(2);
    expect(TOKEN_MANAGER.lockUnlockFee).toBe(3);
    expect(TOKEN_MANAGER.mintBurn).toBe(4);
  });

  it("names the token service as spender, never the token manager", () => {
    const approval = buildApproval({
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      spender: TOKEN_SERVICE,
      amount: 1_000_000n,
      symbol: "USDC",
      decimals: 6,
    });
    // The tokens land in the token manager but the transfer runs as the service,
    // so the allowance is read against the service. Naming the manager here
    // leaves the transfer reverting with the user's gas spent.
    expect(approval.args[0]).toBe(TOKEN_SERVICE);
  });

  it("approves exactly this transfer and never an unlimited amount", () => {
    const approval = buildApproval({
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      spender: TOKEN_SERVICE,
      amount: 1_000_000n,
      symbol: "USDC",
      decimals: 6,
    });
    expect(approval.args[1]).toBe(1_000_000n);
    expect(approval.args[1]).not.toBe(2n ** 256n - 1n);
  });
});

describe("rescaling between two chains that count differently", () => {
  it("leaves an amount alone when both sides agree", () => {
    expect(scaleAcrossDecimals(12_345_678n, 7, 7)).toBe(12_345_678n);
  });

  it("truncates going down, because the remainder is destroyed rather than held", () => {
    // solvBTC is eighteen on Ethereum and eight on Stellar. Everything below the
    // tenth decimal place does not arrive, and nothing gives it back.
    expect(scaleAcrossDecimals(10n ** 18n, 18, 8)).toBe(10n ** 8n);
    expect(scaleAcrossDecimals(10n ** 18n + 9_999_999_999n, 18, 8)).toBe(10n ** 8n);
  });

  it("scales up exactly", () => {
    expect(scaleAcrossDecimals(1_000_000n, 6, 18)).toBe(1_000_000n * 10n ** 12n);
  });

  it("collapses a dust amount to nothing, which the adapter must refuse to quote", () => {
    expect(scaleAcrossDecimals(999n, 18, 8)).toBe(0n);
  });
});

describe("adding gas to a stuck transfer", () => {
  const base = {
    gasService: "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6",
    txHash: "0x6d2b4dd58e2501708cd6bd73ca578097cec519fe634bc9fbadf6e86e9b05ca7f",
    logIndex: 125,
    refundAddress: "0xF8d2A61C3809e7cC051b8036AeaDa06B65c2F9E7",
    amount: 1_000_000n,
  };

  it("refuses to add nothing", () => {
    expect(() => buildAddGas({ ...base, amount: 0n })).toThrow(/add nothing/);
  });

  it("refuses without a log index, because a wrong one is spent and not refunded", () => {
    // The gas service only emits an event. It checks neither argument and never
    // reverts, so guessing here costs the money and credits no message.
    expect(() => buildAddGas({ ...base, logIndex: -1 })).toThrow(/log index/);
    expect(() => buildAddGas({ ...base, logIndex: 1.5 })).toThrow(/log index/);
  });

  it("pays against the receipt log index, not Axelar's event counter", () => {
    const call = buildAddGas(base);
    expect(call.args[1]).toBe(125n);
    expect(call.value).toBe(1_000_000n);
  });

  it("explains that the funds are still recoverable", () => {
    expect(buildAddGas(base).describes).toMatch(/still in the transfer/);
  });
});

describe("amounts as a person reads them", () => {
  it("does not go through a float", () => {
    expect(readable(10_000_000n, 7)).toBe("1");
    expect(readable(12_345_678n, 7)).toBe("1.2345678");
    expect(readable(1n, 18)).toBe("0.000000000000000001");
    expect(readable(0n, 7)).toBe("0");
  });
});
