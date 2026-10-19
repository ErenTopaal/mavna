import type { ComposeArrival } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import asCame from "./__fixtures__/arrival-event-as-came-testnet.json" with { type: "json" };
import converted from "./__fixtures__/arrival-event-converted-testnet.json" with { type: "json" };
import {
  arrivalAccepts,
  arrivalRecipientOf,
  arrivalWantedOf,
  composeExtraOptions,
  decodeOftComposePayload,
  encodeArrivalMessage,
  encodeOftComposeMsg,
  executorLzComposeOption,
  executorOptionTypes,
  findArrivalEvent,
} from "./compose.js";

const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const RECIPIENT = "GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL";
const ARRIVAL = "CBSWBSELNYEDXQHO4JDXYJ7HFMTSBLVHAKIQ6KFC2NYZUT5PHDSI6252";
// the vector below was written with the first testnet id as fee recipient
const VECTOR_FEE_TO = "CB4B235WXWSGKVKBYD7H3QKUWYQE2B4DXH7U42B67M4ZP2K4KWNCJS7F";

const compose: ComposeArrival = {
  contract: ARRIVAL,
  venue: "aquarius",
  arriving: { chainId: "stellar", id: "USDT0:G", symbol: "USDT0", decimals: 7, curatedBy: "t" },
  arrivingContract: USDT0,
  wanted: { chainId: "stellar", id: "USDC:G", symbol: "USDC", decimals: 7, curatedBy: "t" },
  wantedContract: USDC,
  minOut: "990000",
  path: [{ tokens: [USDT0, USDC], poolIndex: "07".repeat(32), tokenOut: USDC }],
  fee: { bps: 30, recipient: VECTOR_FEE_TO },
  trust: "",
  walletNote: "",
};

// the same bytes are decoded by the contract's own test,
// a_message_the_sdk_writes_decodes_to_what_it_says (contracts/arrival/src/test.rs)
const SDK_VECTOR =
  "0x0100" +
  "85e8c67a3bce389d24603743e1a274c504cac13a9a5e71f2d2212609f5443041" + // recipient
  "adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496" + // wanted, usdc
  "000000000000000000000000000f1b30" + // min_out 990000
  "001e" + // 30 bps
  "01" +
  "781d6fb6bda4655541c0fe7dc154b6204d0783b9ff4e683efb3997e95c559a24" + // fee to the contract id
  "01" + // one hop
  "02" +
  "649c910ee8bea16a45db1526dee995ba6dd66d0df809b15446c3a6478953391d" +
  "adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496" +
  "0707070707070707070707070707070707070707070707070707070707070707" +
  "adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e496";

describe("the message the Arrival Contract follows", () => {
  it("writes the contract's v1 layout", () => {
    expect(encodeArrivalMessage(RECIPIENT, compose)).toBe(SDK_VECTOR);
  });

  it("reads back who it is for and what they want", () => {
    const msg = encodeArrivalMessage(RECIPIENT, compose);
    expect(arrivalRecipientOf(msg)).toBe(RECIPIENT);
    expect(arrivalWantedOf(msg)).toBe(USDC);
    expect(arrivalRecipientOf(encodeArrivalMessage(ARRIVAL, compose))).toBe(ARRIVAL);
  });

  it("names the recipient as the fee recipient when there is no fee", () => {
    const msg = encodeArrivalMessage(RECIPIENT, { ...compose, fee: undefined });
    const raw = msg.slice(2);
    // version, kind, recipient, wanted, min_out, bps, fee kind, then the fee recipient
    const feeAt = (1 + 1 + 32 + 32 + 16 + 2 + 1) * 2;
    expect(raw.slice(feeAt, feeAt + 64)).toBe(raw.slice(4, 68));
    expect(raw.slice((1 + 1 + 32 + 32 + 16) * 2, (1 + 1 + 32 + 32 + 16 + 2) * 2)).toBe("0000");
  });

  it("refuses what the contract could not act on", () => {
    expect(() => encodeArrivalMessage(RECIPIENT, { ...compose, minOut: "0" })).toThrow();
    expect(() => encodeArrivalMessage(RECIPIENT, { ...compose, path: [] })).toThrow();
    expect(() =>
      encodeArrivalMessage(RECIPIENT, { ...compose, fee: { bps: 10_000, recipient: ARRIVAL } }),
    ).toThrow();
    expect(() =>
      encodeArrivalMessage(
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ",
        compose,
      ),
    ).toThrow();
  });
});

describe("the OFT side of a compose", () => {
  it("splits an OFT message into what is credited and what is queued", () => {
    const payload = `0x${"ab".repeat(32)}00000000000f4240${"cd".repeat(32)}${SDK_VECTOR.slice(2)}`;
    const decoded = decodeOftComposePayload(payload);
    expect(decoded?.sendTo).toBe(`0x${"ab".repeat(32)}`);
    expect(decoded?.amountSd).toBe(1_000_000n);
    expect(decoded?.composeFrom).toBe(`0x${"cd".repeat(32)}`);
    expect(decoded?.composeMsg).toBe(SDK_VECTOR);
    expect(decodeOftComposePayload(`0x${"ab".repeat(32)}00000000000f4240`)).toBeUndefined();
  });

  it("rebuilds the message the Stellar OFT queues, with a sixteen byte amount", () => {
    const msg = encodeOftComposeMsg({
      nonce: 7n,
      srcEid: 30110,
      amountLd: 10_000_000n,
      composeFrom: `0x${"cd".repeat(32)}`,
      composeMsg: "0x01",
    });
    expect(msg).toBe(
      // nonce 7 | eid 30110 | 10,000,000 in sixteen bytes | compose from | message
      `0x${"0000000000000007"}${"0000759e"}${"00000000000000000000000000989680"}${"cd".repeat(32)}01`,
    );
  });
});

describe("executor options for a compose", () => {
  // USDT0's Arbitrum OFT, enforcedOptions(30600, 1) and (30600, 2), read 2026-10-19
  const SEND = "0x0003010011010000000000000000000000000007a120";
  const SEND_AND_CALL =
    "0x0003010011010000000000000000000000000007a1200100130300000000000000000000000000000007a120";

  it("encodes lzCompose the way USDT0's own enforced options do", () => {
    expect(SEND_AND_CALL.endsWith(executorLzComposeOption(0, 500_000n).slice(2))).toBe(true);
    expect(executorOptionTypes(SEND_AND_CALL)).toEqual([1, 3]);
    expect(executorOptionTypes(SEND)).toEqual([1]);
  });

  it("adds nothing when the OApp already pays for both calls", () => {
    expect(composeExtraOptions(SEND_AND_CALL, { lzReceive: undefined, lzCompose: undefined })).toBe(
      "0x",
    );
  });

  it("buys only what the OApp does not enforce, and refuses to guess", () => {
    expect(composeExtraOptions(SEND, { lzReceive: undefined, lzCompose: undefined })).toBe(
      undefined,
    );
    expect(composeExtraOptions(SEND, { lzReceive: undefined, lzCompose: 500_000n })).toBe(
      `0x0003${executorLzComposeOption(0, 500_000n).slice(2)}`,
    );
    expect(composeExtraOptions("0x", { lzReceive: undefined, lzCompose: 500_000n })).toBe(
      undefined,
    );
    expect(composeExtraOptions("0x", { lzReceive: 500_000n, lzCompose: 500_000n })).toBe(
      SEND_AND_CALL,
    );
  });
});

describe("the contract's allowlist", () => {
  const config = {
    endpoint: "CENDPOINT",
    router: "CROUTER",
    ofts: [["COFT", "CTOKEN"]] as const,
  };
  it("accepts only an allowlisted OFT and token on the same endpoint", () => {
    expect(arrivalAccepts(config, { oft: "COFT", token: "CTOKEN", endpoint: "CENDPOINT" })).toBe(
      true,
    );
    expect(arrivalAccepts(config, { oft: "COFT", token: "COTHER", endpoint: "CENDPOINT" })).toBe(
      false,
    );
    expect(arrivalAccepts(config, { oft: "CNOPE", token: "CTOKEN", endpoint: "CENDPOINT" })).toBe(
      false,
    );
    expect(arrivalAccepts(config, { oft: "COFT", token: "CTOKEN", endpoint: "COLD" })).toBe(false);
  });
});

describe("proof of arrival from the contract's own event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // recorded from testnet: CBSWBSEL..., the harness runs in the arrival report
  const client = (events: { result: { events: unknown[]; latestLedger: number } }) => {
    const c = new RpcClient({ url: "https://rpc.invalid" });
    vi.spyOn(c.server, "getHealth").mockResolvedValue({
      status: "healthy",
      latestLedger: events.result.latestLedger,
      oldestLedger: 5_160_000,
      ledgerRetentionWindow: 120_960,
    });
    vi.spyOn(c.server, "getEvents").mockResolvedValue(
      rpc.parseRawEvents(events.result as unknown as rpc.Api.RawGetEventsResponse),
    );
    return c;
  };

  it("reads a conversion", async () => {
    const event = await findArrivalEvent(
      client(converted),
      ARRIVAL,
      "5e10ae34a80c088f29a7a7c9efe8d64f5a24a1ef2f46834403e59b534df0ebcc",
      5_281_548,
    );
    expect(event).toMatchObject({
      outcome: "converted",
      recipient: RECIPIENT,
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: 719_684_384n,
      fee: 0n,
      arrivedAmount: 100_000_000n,
      txHash: "f465283c233bc4f245b2f251bc421c6a3e00ac5e096dabe7b9f0930cc0b2a306",
    });
  });

  it("reads a delivery as it came", async () => {
    const event = await findArrivalEvent(
      client(asCame),
      ARRIVAL,
      "4da45bffcf9b3338763a2d45f767683d3a18a527499d87704e64fbd8895e7a40",
      5_281_557,
    );
    expect(event).toMatchObject({
      outcome: "as_came",
      asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: 100_000_000n,
    });
  });
});
