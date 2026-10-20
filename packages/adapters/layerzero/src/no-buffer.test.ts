import type { ComposeArrival } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { rpc } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import converted from "./__fixtures__/arrival-event-converted-testnet.json" with { type: "json" };
import {
  arrivalRecipientOf,
  arrivalWantedOf,
  encodeArrivalMessage,
  findArrivalEvent,
} from "./compose.js";
import { bytes32ToStellarContract, stellarRecipientToBytes32 } from "./oft.js";

/**
 * The encoders, run with no `Buffer` global.
 *
 * Browsers have none, and Node does, so code leaning on it passed every test
 * here while every LayerZero quote in the app declined with "cannot be
 * encoded". Taking the global away makes Node fail the same way a browser does.
 *
 * Only for this package's own code. Dependencies still see it, because the
 * Stellar SDK resolves its Node build here (base32.js reaches for the global
 * there) and its browser build in the app, which carries its own polyfill.
 */

const ACCOUNT = "GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL";
const ACCOUNT_BYTES = "0x85e8c67a3bce389d24603743e1a274c504cac13a9a5e71f2d2212609f5443041";
const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDT0_BYTES = "0x649c910ee8bea16a45db1526dee995ba6dd66d0df809b15446c3a6478953391d";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";

const compose: ComposeArrival = {
  contract: ARRIVAL,
  venue: "aquarius",
  arriving: { chainId: "stellar", id: "USDT0:G", symbol: "USDT0", decimals: 7, curatedBy: "t" },
  arrivingContract: USDT0,
  wanted: { chainId: "stellar", id: "USDC:G", symbol: "USDC", decimals: 7, curatedBy: "t" },
  wantedContract: USDC,
  minOut: "990000",
  path: [{ tokens: [USDT0, USDC], poolIndex: "07".repeat(32), tokenOut: USDC }],
  fee: { bps: 30, recipient: ARRIVAL },
  trust: "",
  walletNote: "",
  fallback: "",
};

// built while the global is still there: the double, not the code under test
const node = new RpcClient({ url: "https://rpc.invalid" });
vi.spyOn(node.server, "getHealth").mockResolvedValue({
  status: "healthy",
  latestLedger: converted.result.latestLedger,
  oldestLedger: 5_160_000,
  ledgerRetentionWindow: 120_960,
});
const getEvents = vi
  .spyOn(node.server, "getEvents")
  .mockResolvedValue(
    rpc.parseRawEvents(converted.result as unknown as rpc.Api.RawGetEventsResponse),
  );

const saved = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
const real = globalThis.Buffer;
beforeAll(() => {
  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    get() {
      // frame 0 is the message, 1 this getter, 2 whoever asked
      const caller = new Error().stack?.split("\n")[2] ?? "";
      if (caller.includes("/node_modules/")) return real;
      throw new ReferenceError("Buffer is not defined");
    },
  });
});
afterAll(() => {
  if (saved !== undefined) Object.defineProperty(globalThis, "Buffer", saved);
});

describe("with no Buffer global, as in a browser", () => {
  it("really has none", () => {
    expect(() => (globalThis as { Buffer?: unknown }).Buffer).toThrow(ReferenceError);
  });

  it("encodes a Stellar account and a contract as a LayerZero recipient", () => {
    expect(stellarRecipientToBytes32(ACCOUNT)).toBe(ACCOUNT_BYTES);
    expect(stellarRecipientToBytes32(USDT0)).toBe(USDT0_BYTES);
  });

  it("reads a peer back as a Stellar contract", () => {
    expect(bytes32ToStellarContract(USDT0_BYTES)).toBe(USDT0);
  });

  it("writes and reads the Arrival Contract's message", () => {
    const message = encodeArrivalMessage(ACCOUNT, compose);
    expect(message.startsWith(`0x0100${ACCOUNT_BYTES.slice(2)}`)).toBe(true);
    expect(arrivalRecipientOf(message)).toBe(ACCOUNT);
    expect(arrivalWantedOf(message)).toBe(USDC);
  });

  it("filters the contract's events by a guid", async () => {
    const event = await findArrivalEvent(
      node,
      ARRIVAL,
      "f72ac1608fd43b2bf26d1bc136d897defb82e912ef59a3e6c43c3a9a48e5d3c6",
      5_295_406,
    );
    expect(event?.outcome).toBe("converted");
    expect(getEvents).toHaveBeenCalled();
  });
});
