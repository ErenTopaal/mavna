import { describe, expect, it } from "vitest";
import { parseQuoteReply } from "./api.js";
import { decodeTransfer } from "./evm.js";

const TO = "76b4c56085ed136a8744d52be956396624a730e8";

describe("decodeTransfer", () => {
  it("reads the recipient and amount out of transfer calldata", () => {
    const input = `0xa9059cbb${TO.padStart(64, "0")}${(10_000_000).toString(16).padStart(64, "0")}`;
    expect(decodeTransfer(input)).toEqual({ to: `0x${TO}`, amount: 10_000_000n });
  });

  it("refuses anything that is not exactly a transfer", () => {
    const word = TO.padStart(64, "0");
    // transferFrom shares nothing, approve shares the shape, and trailing bytes
    // mean some other call: none of them paid a deposit address.
    expect(decodeTransfer(`0x23b872dd${word}${word}${"0".repeat(64)}`)).toBeUndefined();
    expect(decodeTransfer(`0x095ea7b3${word}${"0".repeat(64)}`)).toBeUndefined();
    expect(decodeTransfer(`0xa9059cbb${word}${"0".repeat(64)}00`)).toBeUndefined();
    expect(decodeTransfer(`0xa9059cbb${"f".repeat(64)}${"0".repeat(64)}`)).toBeUndefined();
  });
});

describe("parseQuoteReply", () => {
  const reply = (quote: Record<string, unknown>) => ({
    quote: {
      amountIn: "1",
      minAmountIn: "1",
      amountOut: "1",
      minAmountOut: "1",
      timeEstimate: 10,
      ...quote,
    },
    quoteRequest: { refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" },
  });

  it("refuses amounts that are not integer base units", () => {
    expect(() => parseQuoteReply(reply({ amountOut: "9.95" }), true)).toThrow(/amountOut/);
    expect(() => parseQuoteReply(reply({ minAmountOut: 99 }), true)).toThrow(/minAmountOut/);
  });

  it("requires a real quote to carry an EVM deposit address", () => {
    expect(() => parseQuoteReply(reply({}), false)).toThrow(/depositAddress is missing/);
    expect(() => parseQuoteReply(reply({ depositAddress: "GABC" }), false)).toThrow(
      /not an EVM address/,
    );
    expect(parseQuoteReply(reply({ depositAddress: `0x${TO}` }), false).quote.depositAddress).toBe(
      `0x${TO}`,
    );
  });
});
