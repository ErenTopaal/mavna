import { INTERCHAIN_TOKEN_SERVICE_ABI } from "@mavna/adapter-axelar";
import { ERC20_ABI } from "@mavna/adapter-cctp";
import { buildSendParam, OFT_ABI } from "@mavna/adapter-layerzero";
import {
  type AllowanceCheck,
  type Route,
  SENDER_ADDRESS,
  type UnsignedTransaction,
} from "@mavna/core";
import { type Address, type Hash, WaitForTransactionReceiptTimeoutError } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertBalanceCovers,
  type ExecutionEvent,
  execute,
  parseCall,
  ReceiptTimedOut,
} from "./execute";
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

  it("states raw base units when the chain's native currency is unknown", async () => {
    // Guessing 18 decimals would print a plausible and wrong amount on a chain
    // that uses some other number.
    const check = assertBalanceCovers({
      connection: connection(776n),
      route,
      transactions: [transaction(layerZeroPayload("777"))],
      nativeCurrency: undefined,
    });
    await expect(check).rejects.toThrow(
      "This transfer needs 777 base units of this chain's native currency to pay for " +
        "delivery, plus gas, and this wallet holds 776. Nothing has been sent.",
    );
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

describe("execute", () => {
  const TOKEN = "0x3333333333333333333333333333333333333333";
  const SPENDER = "0x4444444444444444444444444444444444444444";
  const APPROVE_HASH = `0x${"a1".repeat(32)}` as Hash;
  const SEND = `0x${"b2".repeat(32)}` as Hash;
  const FASTER = `0x${"c3".repeat(32)}` as Hash;
  const route = { sends: { asset: { symbol: "USDC", decimals: 6 } } } as unknown as Route;

  const approve = (extra: Partial<AllowanceCheck> = {}): UnsignedTransaction => ({
    chainId: "arbitrum-sepolia",
    format: "evm-tx",
    describes: "Allow the transfer to move 5 USDC",
    ephemeralSigners: [],
    payload: JSON.stringify({
      to: TOKEN,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SPENDER, "5000000"],
    }),
    unnecessaryWhen: {
      kind: "erc20-allowance",
      token: TOKEN,
      spender: SPENDER,
      atLeastBaseUnits: "5000000",
      ...extra,
    },
  });
  const send: UnsignedTransaction = {
    chainId: "arbitrum-sepolia",
    format: "evm-tx",
    describes: "Send 5 USDC",
    ephemeralSigners: [],
    payload: layerZeroPayload(undefined),
    unnecessaryWhen: undefined,
  };

  /** The wallet and its node, at their boundary, answering what a test scripts. */
  function wallet(script: {
    allowance?: bigint;
    reject?: boolean;
    receipt?: (hash: Hash, onReplaced?: (r: { reason: string }) => void) => Promise<unknown>;
  }) {
    const seen: string[] = [];
    const waits: Array<{ timeout: number | undefined }> = [];
    const connection = {
      address: SENDER,
      chainId: 421_614,
      wallet: {
        writeContract: async (call: { functionName: string }) => {
          seen.push(`sign ${call.functionName}`);
          if (script.reject === true) throw Object.assign(new Error("denied"), { code: 4001 });
          return call.functionName === "approve" ? APPROVE_HASH : SEND;
        },
      },
      reader: {
        getBalance: async () => 10n ** 18n,
        readContract: async (call: { functionName: string }) =>
          call.functionName === "allowance" ? (script.allowance ?? 0n) : 10n ** 12n,
        waitForTransactionReceipt: async (args: {
          hash: Hash;
          timeout?: number;
          onReplaced?: (r: { reason: string }) => void;
        }) => {
          seen.push(`wait ${args.hash.slice(0, 4)}`);
          waits.push({ timeout: args.timeout });
          return script.receipt === undefined
            ? { status: "success", transactionHash: args.hash }
            : script.receipt(args.hash, args.onReplaced);
        },
      },
    } as unknown as Connection;
    return { connection, seen, waits };
  }

  function run(
    connection: Connection,
    transactions: readonly UnsignedTransaction[],
    signal?: AbortSignal,
    onEvent?: (event: ExecutionEvent) => void,
  ) {
    const events: ExecutionEvent[] = [];
    const done = execute({
      connection,
      route,
      transactions,
      chainName: "Arbitrum Sepolia",
      evmChainId: 421_614,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      onEvent: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return { done, events };
  }

  it("approves, waits for it, then sends, and tells each step as it happens", async () => {
    const { connection, seen } = wallet({});
    const { done, events } = run(connection, [approve(), send]);
    await expect(done).resolves.toEqual([APPROVE_HASH, SEND]);
    expect(seen).toEqual(["sign approve", "wait 0xa1", "sign send", "wait 0xb2"]);
    expect(events.map((e) => `${e.kind} ${e.index}`)).toEqual([
      "awaiting-signature 0",
      "sent 0",
      "confirmed 0",
      "awaiting-signature 1",
      "sent 1",
      "confirmed 1",
    ]);
  });

  it("skips an approval the allowance already covers", async () => {
    const { connection, seen } = wallet({ allowance: 5_000_000n });
    const { done, events } = run(connection, [approve(), send]);
    await expect(done).resolves.toEqual([SEND]);
    expect(seen).toEqual(["sign send", "wait 0xb2"]);
    expect(events[0]?.kind).toBe("skipped");
  });

  it("skips a reset to zero when the allowance is already exactly zero, and runs it otherwise", async () => {
    const reset = approve({ skipAlsoWhenExactly: "0" });
    const none = wallet({ allowance: 0n });
    await expect(run(none.connection, [reset, send]).done).resolves.toEqual([SEND]);
    const some = wallet({ allowance: 7n });
    await expect(run(some.connection, [reset, send]).done).resolves.toEqual([APPROVE_HASH, SEND]);
  });

  it("says a declined approval sent nothing", async () => {
    const { connection } = wallet({ reject: true });
    await expect(run(connection, [approve(), send]).done).rejects.toThrow(
      "You did not approve, so nothing was sent.",
    );
  });

  it("says a reverted send moved nothing", async () => {
    const { connection } = wallet({ receipt: async () => ({ status: "reverted" }) });
    await expect(run(connection, [send]).done).rejects.toThrow(
      "The transfer was rejected by the network. Your funds have not moved.",
    );
  });

  it("waits far longer than viem's three minutes, and a send that outlasts it is still in flight with its hash", async () => {
    const { connection, waits } = wallet({
      receipt: async (hash) => {
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
    });
    const { done, events } = run(connection, [send]);
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptTimedOut);
    expect((error as ReceiptTimedOut).hash).toBe(SEND);
    expect(events.map((e) => e.kind)).toEqual(["awaiting-signature", "sent"]);
    expect(waits[0]?.timeout).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("follows a send the wallet sped up to the transaction that landed", async () => {
    const { connection } = wallet({
      receipt: async (_hash, onReplaced) => {
        onReplaced?.({ reason: "repriced" });
        return { status: "success", transactionHash: FASTER };
      },
    });
    const { done, events } = run(connection, [send]);
    await expect(done).resolves.toEqual([FASTER]);
    expect(events).toContainEqual({ kind: "replaced", index: 0, hash: FASTER, was: SEND });
    expect(events.at(-1)).toEqual({ kind: "confirmed", index: 0, hash: FASTER });
  });

  it("treats a send cancelled in the wallet as not sent, even though the cancel succeeded", async () => {
    const { connection } = wallet({
      receipt: async (_hash, onReplaced) => {
        onReplaced?.({ reason: "cancelled" });
        return { status: "success", transactionHash: FASTER };
      },
    });
    await expect(run(connection, [send]).done).rejects.toThrow(
      "The transfer was cancelled in your wallet, so nothing was sent.",
    );
  });

  describe("a page closed partway, said by what actually confirmed", () => {
    const reset = () => approve({ skipAlsoWhenExactly: "0" });

    it("says nothing was approved when only a reset with nothing to reset went by", async () => {
      const gone = new AbortController();
      const { connection } = wallet({ allowance: 0n });
      const { done } = run(connection, [reset(), approve(), send], gone.signal, (event) => {
        if (event.kind === "skipped") gone.abort();
      });
      await expect(done).rejects.toThrow(
        "This page closed before anything was signed. Nothing has been sent.",
      );
    });

    it("says the old allowance was cleared, not that anything was approved", async () => {
      const gone = new AbortController();
      const { connection } = wallet({ allowance: 7n });
      const { done } = run(connection, [reset(), approve(), send], gone.signal, (event) => {
        if (event.kind === "confirmed" && event.index === 0) gone.abort();
      });
      const error = await done.catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/allowance was cleared.*nothing was approved/);
      expect((error as Error).message).not.toMatch(/approval went through/);
    });

    it("says the approval went through only when it did", async () => {
      const gone = new AbortController();
      const { connection } = wallet({});
      const { done } = run(connection, [approve(), send], gone.signal, (event) => {
        if (event.kind === "confirmed" && event.index === 0) gone.abort();
      });
      await expect(done).rejects.toThrow(/The approval went through, but no funds moved/);
    });
  });
});
