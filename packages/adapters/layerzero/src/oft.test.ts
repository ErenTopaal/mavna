import { describe, expect, it } from "vitest";
import {
  buildApproval,
  buildSendParam,
  bytes32ToStellarContract,
  decodeOftMessage,
  executorLzReceiveOption,
  isZeroBytes32,
  localToStellar,
  sharedToStellar,
  stellarRecipientToBytes32,
  stellarToLocal,
} from "./oft.js";

/**
 * The encodings, against fixed vectors rather than against themselves.
 *
 * Every expected value below came from somewhere outside this file: the option
 * bytes from LayerZero's own published encoder and from a live mainnet
 * deployment, the message from a real delivered transfer, the addresses from
 * Stellar's own strkey implementation. A test that re-derives an encoding using
 * the same code it is testing proves only that the code is consistent.
 */

describe("executor options", () => {
  /**
   * Checked twice over. These are the bytes LayerZero's own
   * `@layerzerolabs/lz-v2-utilities` OptionsBuilder produces, and the 500,000
   * gas case is byte for byte what Tether's USDT0 adapter on Ethereum returns
   * from `enforcedOptions(30600, 1)` for the Stellar pathway.
   */
  it("matches LayerZero's own encoder", () => {
    expect(executorLzReceiveOption(200_000n)).toBe(
      "0x00030100110100000000000000000000000000030d40",
    );
    expect(executorLzReceiveOption(65_000n)).toBe("0x0003010011010000000000000000000000000000fde8");
    expect(executorLzReceiveOption(500_000n)).toBe(
      "0x0003010011010000000000000000000000000007a120",
    );
  });

  it("matches it with a native drop too, which changes the declared size", () => {
    // 33, not 17: the size field counts the value as well as the gas, plus the
    // one type byte. Getting it wrong makes the ULN's decoder reject the blob.
    expect(executorLzReceiveOption(200_000n, 1_000_000_000_000_000n)).toBe(
      "0x00030100210100000000000000000000000000030d40000000000000000000038d7ea4c68000",
    );
  });

  it("omits the value entirely when it is zero rather than padding it", () => {
    // The decoder accepts a 16 or 32 byte payload and nothing else, so sixteen
    // zero bytes would be read as a native drop the executor has to fund.
    expect(executorLzReceiveOption(200_000n)).toHaveLength(2 + 22 * 2);
  });

  it("refuses to buy no gas at all", () => {
    expect(() => executorLzReceiveOption(0n)).toThrow(/pays for no delivery/);
  });
});

describe("the Stellar recipient, in 32 bytes", () => {
  it("carries an account as its raw public key", () => {
    expect(
      stellarRecipientToBytes32("GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU"),
    ).toBe("0x94f16b7306c7e28b23ab0fda710f49724c50a1a824d58d8cdd0983a4ccd8c08a");
  });

  it("carries a contract as its raw id", () => {
    expect(
      stellarRecipientToBytes32("CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6"),
    ).toBe("0x5d672cb21b3afcdda54546c7f5b9fd346920e41f8fe8f39e838e5d7bd7435546");
  });

  /**
   * The one address form this rail cannot carry, and the reason it must refuse
   * rather than truncate. A muxed address is an account plus a customer id, and
   * delivering to the account alone hands a custodian money with no idea whose
   * it is.
   */
  it("refuses a muxed address instead of dropping the part that does not fit", () => {
    expect(() =>
      stellarRecipientToBytes32(
        "MAAAAAAAAAAAJURAAB2X52XFQP6FBXLGT6LWOOWMEXWHEWBDVRZ7V5WH34Y22MPFBHUHY",
      ),
    ).toThrow(/muxed address does not fit/);
  });

  it("refuses a secret key loudly, before it can be encoded into anything", () => {
    expect(() =>
      stellarRecipientToBytes32("SAV76USXIJOBMEQXPANUOQM6F5LIOTLPDIDVRJBFFE2MDJXG24TAPUU7"),
    ).toThrow(/secret key/);
  });

  it("refuses an address that cannot receive value at all", () => {
    // A liquidity pool. Well-formed, thirty-two bytes, and not a destination.
    expect(() =>
      stellarRecipientToBytes32("LAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDYRY"),
    ).toThrow(/cannot receive/);
  });
});

describe("peers", () => {
  it("decodes to the Stellar contract it names", () => {
    expect(
      bytes32ToStellarContract(
        "0x5d672cb21b3afcdda54546c7f5b9fd346920e41f8fe8f39e838e5d7bd7435546",
      ),
    ).toBe("CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6");
  });

  it("knows an unset peer from a set one", () => {
    expect(isZeroBytes32(`0x${"0".repeat(64)}`)).toBe(true);
    expect(
      isZeroBytes32("0x5d672cb21b3afcdda54546c7f5b9fd346920e41f8fe8f39e838e5d7bd7435546"),
    ).toBe(false);
  });

  it("refuses anything that is not 32 bytes", () => {
    expect(() => bytes32ToStellarContract("0xdead")).toThrow(/must be 32 bytes/);
  });
});

describe("the message on the wire", () => {
  /**
   * A real payload, from a transfer LayerZero delivered from BNB Smart Chain
   * testnet into Stellar testnet. Five million shared units to a Stellar
   * account, which is what the amount looks like at the point it stops being
   * either chain's problem.
   */
  it("decodes a delivered transfer", () => {
    const message = decodeOftMessage(
      "0xe991a744c1b0a000f47c3481ff628fb26b327654dbe87add0bacdd4828434093" + "00000000004c4b40",
    );
    expect(message.amountSd).toBe(5_000_000n);
    expect(message.sendTo).toBe(
      "0xe991a744c1b0a000f47c3481ff628fb26b327654dbe87add0bacdd4828434093",
    );
    expect(message.hasCompose).toBe(false);
  });

  it("notices a composed message rather than reading past the amount", () => {
    const message = decodeOftMessage(
      `0x${"11".repeat(32)}${"00".repeat(7)}05${"22".repeat(32)}beef`,
    );
    expect(message.amountSd).toBe(5n);
    expect(message.hasCompose).toBe(true);
  });

  it("refuses a payload too short to be one", () => {
    expect(() => decodeOftMessage("0xdeadbeef")).toThrow(/at least 40 bytes/);
  });
});

describe("decimals, which is where an amount silently becomes ten times wrong", () => {
  it("scales shared units up into Stellar's seven", () => {
    // USDT0 is six shared decimals against Stellar's seven, so every amount is
    // ten times larger on arrival. 5 USDT0 is 5_000_000 shared, 50_000_000 local.
    expect(sharedToStellar(5_000_000n, 1)).toBe(50_000_000n);
  });

  it("takes a source amount all the way across", () => {
    // USDT on Ethereum has six decimals and six shared, so nothing is lost on
    // the way down and everything is multiplied by ten on the way up.
    expect(localToStellar(25_000_000n, 6, 6, 7)).toBe(250_000_000n);
  });

  /**
   * Dust, and why the order of the two conversions matters. A token with
   * eighteen local decimals against six shared can only carry twelve zeros'
   * worth of granularity, and the contract truncates the rest before it sends.
   * Quoting the untruncated figure would promise an amount that never leaves.
   */
  it("drops the dust the contract drops, rather than quoting it", () => {
    const oneAndABit = 1_000_000_000_000_999_999n;
    expect(localToStellar(oneAndABit, 18, 6, 7)).toBe(10_000_000n);
  });

  it("goes back the other way for the floor the contract enforces", () => {
    expect(stellarToLocal(250_000_000n, 6, 6, 7)).toBe(25_000_000n);
    expect(stellarToLocal(10_000_000n, 18, 6, 7)).toBe(1_000_000_000_000_000_000n);
  });

  it("refuses a token that cannot carry its own shared decimals", () => {
    expect(() => localToStellar(1n, 4, 6, 7)).toThrow(/cannot carry/);
    expect(() => sharedToStellar(1n, -1)).toThrow(/lose precision/);
  });
});

describe("building the send", () => {
  const base = {
    dstEid: 30600,
    stellarRecipient: "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU",
    amount: 1_000_000n,
    minAmount: 995_000n,
    extraOptions: "0x" as const,
  };

  it("names no composer and no command, because this only moves tokens", () => {
    const param = buildSendParam(base);
    expect(param.composeMsg).toBe("0x");
    expect(param.oftCmd).toBe("0x");
    expect(param.dstEid).toBe(30600);
  });

  it("carries the user's floor rather than accepting anything back", () => {
    expect(buildSendParam(base).minAmountLD).toBe(995_000n);
  });

  it("refuses a floor that can never be met", () => {
    expect(() => buildSendParam({ ...base, minAmount: 2_000_000n })).toThrow(/never be met/);
  });

  it("refuses to send nothing", () => {
    expect(() => buildSendParam({ ...base, amount: 0n, minAmount: 0n })).toThrow(/non-positive/);
  });
});

describe("the approval", () => {
  it("names the OFT as spender and this transfer's amount, never more", () => {
    const approval = buildApproval({
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      spender: "0x6c96de32cea08842dcc4058c14d3aaad7fa41dee",
      amount: 25_000_000n,
      decimals: 6,
      symbol: "USDT",
    });
    expect(approval.contract).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    expect(approval.args[0]).toBe("0x6c96de32cea08842dcc4058c14d3aaad7fa41dee");
    expect(approval.args[1]).toBe(25_000_000n);
    // The sentence the user is asked to consent to has to carry the amount they
    // typed, not the machine's integer.
    expect(approval.describes).toContain("25 USDT");
    expect(approval.describes).toContain("does not send anything on its own");
  });

  it("refuses to approve nothing", () => {
    expect(() =>
      buildApproval({
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        spender: "0x6c96de32cea08842dcc4058c14d3aaad7fa41dee",
        amount: 0n,
        decimals: 6,
        symbol: "USDT",
      }),
    ).toThrow(/non-positive/);
  });
});
