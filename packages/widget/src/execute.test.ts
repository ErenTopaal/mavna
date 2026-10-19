import { INTERCHAIN_TOKEN_SERVICE_ABI } from "@mavna/adapter-axelar";
import { buildSendParam, OFT_ABI } from "@mavna/adapter-layerzero";
import { type Route, SENDER_ADDRESS, type UnsignedTransaction } from "@mavna/core";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { assertBalanceCovers, parseCall } from "./execute";
import type { Connection } from "./wallet";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const OFT = "0x2222222222222222222222222222222222222222";

// the same shape LayerZeroAdapter.buildTransactions puts in its send payload
function layerZeroPayload(fee: string | undefined): string {
  const sendParam = buildSendParam({
    dstEid: 30_333,
    stellarRecipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    amount: 12_345_678n,
    minAmount: 12_000_000n,
    extraOptions: "0x",
  });
  return JSON.stringify({
    to: OFT,
    abi: OFT_ABI,
    functionName: "send",
    args: [
      { ...sendParam, amountLD: "12345678", minAmountLD: "12000000" },
      { nativeFee: "777", lzTokenFee: "0" },
      SENDER_ADDRESS,
    ],
    ...(fee === undefined ? {} : { value: fee }),
  });
}

// the shape the Axelar adapter builds for interchainTransfer
const TOKEN_ID = `0x${"ab".repeat(32)}`;
const axelarPayload = JSON.stringify({
  to: OFT,
  abi: INTERCHAIN_TOKEN_SERVICE_ABI,
  functionName: "interchainTransfer",
  args: [TOKEN_ID, "stellar", "0x1234", "5000000", "0x", "2500"],
  value: "2500",
});

describe("parseCall", () => {
  it("turns digit strings inside the send param into bigints and keeps hex as text", () => {
    const call = parseCall(layerZeroPayload("777"), SENDER);
    const [param, fee] = call.args as [Record<string, unknown>, Record<string, unknown>, unknown];

    expect(param.amountLD).toBe(12_345_678n);
    expect(param.minAmountLD).toBe(12_000_000n);
    expect(param.dstEid).toBe(30_333);
    expect(typeof param.to).toBe("string");
    expect(param.extraOptions).toBe("0x");
    expect(param.composeMsg).toBe("0x");
    expect(fee).toEqual({ nativeFee: 777n, lzTokenFee: 0n });
  });

  it("replaces the sender sentinel with the connected address", () => {
    const call = parseCall(layerZeroPayload("777"), SENDER);
    expect(call.args[2]).toBe(SENDER);
  });

  it("parses value to a bigint", () => {
    expect(parseCall(layerZeroPayload("777"), SENDER).value).toBe(777n);
    expect(parseCall(axelarPayload, SENDER).value).toBe(2500n);
  });

  it("leaves value undefined when the payload has none", () => {
    expect(parseCall(layerZeroPayload(undefined), SENDER).value).toBeUndefined();
  });

  it("reads the axelar call: amount and gas are bigints, token id and chain name are text", () => {
    const call = parseCall(axelarPayload, SENDER);
    expect(call.args).toEqual([TOKEN_ID, "stellar", "0x1234", 5_000_000n, "0x", 2500n]);
  });

  it("keeps a digit string a string where the abi says string or bytes", () => {
    const abi = [
      {
        type: "function",
        name: "note",
        stateMutability: "nonpayable",
        inputs: [
          { name: "text", type: "string" },
          { name: "amounts", type: "uint256[]" },
          { name: "labels", type: "string[]" },
        ],
        outputs: [],
      },
    ];
    const payload = JSON.stringify({
      to: OFT,
      abi,
      functionName: "note",
      args: ["12345", ["1", "2"], ["3", "4"]],
    });
    expect(parseCall(payload, SENDER).args).toEqual(["12345", [1n, 2n], ["3", "4"]]);
  });

  it("refuses a function the abi does not have", () => {
    const payload = JSON.stringify({ to: OFT, abi: OFT_ABI, functionName: "nope", args: [] });
    expect(() => parseCall(payload, SENDER)).toThrow("Nothing has been sent");
  });
});

describe("assertBalanceCovers", () => {
  const route = { sends: { asset: { symbol: "USDC", decimals: 6 } } } as unknown as Route;
  const nativeCurrency = { name: "Ether", symbol: "ETH", decimals: 18 };

  function transaction(payload: string): UnsignedTransaction {
    return {
      chainId: "evm:1",
      payload,
      format: "evm-tx",
      describes: "send",
      ephemeralSigners: [],
      unnecessaryWhen: undefined,
    } as unknown as UnsignedTransaction;
  }

  // a reader double at the network boundary, with what a node would answer
  function connection(native: bigint): Connection {
    return {
      address: SENDER,
      reader: { getBalance: async () => native },
    } as unknown as Connection;
  }

  it("refuses before any signature when the native balance is under the fee", async () => {
    const check = assertBalanceCovers({
      connection: connection(776n),
      route,
      transactions: [transaction(layerZeroPayload("777"))],
      nativeCurrency,
    });
    await expect(check).rejects.toThrow(/needs 0\.000000000000000777 ETH.*Nothing has been sent/);
  });

  it("passes when the native balance covers the fee", async () => {
    await expect(
      assertBalanceCovers({
        connection: connection(777n),
        route,
        transactions: [transaction(layerZeroPayload("777"))],
        nativeCurrency,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not read the native balance when nothing is payable", async () => {
    const reader = {
      getBalance: async () => {
        throw new Error("should not be read");
      },
    };
    await expect(
      assertBalanceCovers({
        connection: { address: SENDER, reader } as unknown as Connection,
        route,
        transactions: [transaction(layerZeroPayload(undefined))],
        nativeCurrency,
      }),
    ).resolves.toBeUndefined();
  });
});
