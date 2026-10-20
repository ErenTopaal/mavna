import type { ComposeArrival } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { Address, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import asCame from "./__fixtures__/arrival-event-as-came-testnet.json" with { type: "json" };
import converted from "./__fixtures__/arrival-event-converted-testnet.json" with { type: "json" };
import {
  arrivalAccepts,
  arrivalConverts,
  arrivalRecipientOf,
  arrivalWantedOf,
  composeExtraOptions,
  decodeOftComposePayload,
  encodeArrivalMessage,
  encodeOftComposeMsg,
  estimateFinishRent,
  executorLzComposeOption,
  executorOptionTypes,
  findArrivalEvent,
} from "./compose.js";

const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const RECIPIENT = "GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL";
const ARRIVAL = "CDAIQ522QK5AFCCVGENKVE7SDF6KRCDCAPRFGUWQ4GXO4NJZRVOHQN6X";
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
  fallback: "",
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
    wanted: ["CWANT"],
    pathTokens: ["CVIA"],
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

  it("converts only into listed assets, through listed tokens, within the caps", () => {
    const hop = (a: string, b: string) => ({ tokens: [a, b], tokenOut: b });
    expect(arrivalConverts(config, "CTOKEN", "CWANT", [hop("CTOKEN", "CWANT")])).toBe(true);
    expect(
      arrivalConverts(config, "CTOKEN", "CWANT", [hop("CTOKEN", "CVIA"), hop("CVIA", "CWANT")]),
    ).toBe(true);
    expect(arrivalConverts(config, "CTOKEN", "CEVIL", [hop("CTOKEN", "CEVIL")])).toBe(false);
    expect(
      arrivalConverts(config, "CTOKEN", "CWANT", [hop("CTOKEN", "CEVIL"), hop("CEVIL", "CWANT")]),
    ).toBe(false);
    expect(
      arrivalConverts(config, "CTOKEN", "CWANT", [
        { tokens: ["CTOKEN", "CVIA", "CWANT", "CVIA"], tokenOut: "CWANT" },
      ]),
    ).toBe(false);
    const five = [1, 2, 3, 4, 5].map(() => hop("CTOKEN", "CWANT"));
    expect(arrivalConverts(config, "CTOKEN", "CWANT", five)).toBe(false);
  });
});

describe("proof of arrival from the contract's own event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // recorded from testnet: CDAIQ522..., the harness runs in the contract-stellar fixes
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
      "352de4ea9ce8951912124c0c4cb8617a4436df3f5a3c5f0461bc2b3270b8178e",
      5_293_946,
    );
    expect(event).toMatchObject({
      outcome: "converted",
      recipient: RECIPIENT,
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: 53_894_409n,
      fee: 0n,
      arrivedAmount: 100_000_000n,
      txHash: "0bc786344aa92e4523d3a16f9f016997e9c812fc78dcc59dc4477a19cb73dab3",
    });
  });

  it("reads a delivery as it came", async () => {
    const event = await findArrivalEvent(
      client(asCame),
      ARRIVAL,
      "25193ab76099e7004d76d1e66542b67c8858b11ac6cee640c979240eb0c7aabb",
      5_293_952,
    );
    expect(event).toMatchObject({
      outcome: "as_came",
      asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: 100_000_000n,
    });
  });
});

describe("what finishing a compose would pay to renew the contract's storage", () => {
  const CONTRACT = "CDAIQ522QK5AFCCVGENKVE7SDF6KRCDCAPRFGUWQ4GXO4NJZRVOHQN6X";
  const WASM = Buffer.from(
    "66948b257be56b7c7d4ba4b853ad347e730eae4da37953fc919d1cc79b4a06ab",
    "hex",
  );
  const LATEST = 1_000_000;

  function node(instanceLeft: number, codeLeft: number, rentFee: string) {
    const client = new RpcClient({
      url: "https://rpc.invalid",
      baseDelayMs: 0,
      sleep: async () => {},
    });
    const simulated: string[] = [];
    vi.spyOn(client.server, "getLedgerEntries").mockImplementation(
      async (...keys) =>
        ({
          latestLedger: LATEST,
          entries: keys.map((key) =>
            key.switch().name === "contractCode"
              ? {
                  key,
                  val: xdr.LedgerEntryData.contractCode(
                    new xdr.ContractCodeEntry({
                      ext: new xdr.ContractCodeEntryExt(0),
                      hash: WASM,
                      code: Buffer.alloc(1),
                    }),
                  ),
                  lastModifiedLedgerSeq: 1,
                  liveUntilLedgerSeq: LATEST + codeLeft,
                }
              : {
                  key,
                  val: xdr.LedgerEntryData.contractData(
                    new xdr.ContractDataEntry({
                      ext: new xdr.ExtensionPoint(0),
                      contract: new Address(CONTRACT).toScAddress(),
                      key: xdr.ScVal.scvLedgerKeyContractInstance(),
                      durability: xdr.ContractDataDurability.persistent(),
                      val: xdr.ScVal.scvContractInstance(
                        new xdr.ScContractInstance({
                          executable: xdr.ContractExecutable.contractExecutableWasm(WASM),
                          storage: null,
                        }),
                      ),
                    }),
                  ),
                  lastModifiedLedgerSeq: 1,
                  liveUntilLedgerSeq: LATEST + instanceLeft,
                },
          ),
        }) as never,
    );
    vi.spyOn(client.server, "simulateTransaction").mockImplementation(async (tx) => {
      const data = (tx as { toEnvelope(): xdr.TransactionEnvelope }).toEnvelope().v1().tx().ext();
      const keys = data.switch() === 1 ? data.sorobanData().resources().footprint().readOnly() : [];
      simulated.push(keys.map((k) => k.switch().name).join(","));
      return { latestLedger: LATEST, minResourceFee: rentFee, transactionData: undefined } as never;
    });
    return { client, simulated };
  }

  it("is nothing while the contract and its code have half their 30 days left or more", async () => {
    const { client, simulated } = node(17_280 * 20, 17_280 * 16, "999");
    expect(await estimateFinishRent(client, Networks.TESTNET, CONTRACT)).toBe(0n);
    expect(simulated).toEqual([]);
  });

  it("is the simulated renewal of whatever has less, which the next run pays", async () => {
    const { client, simulated } = node(17_280 * 20, 17_280 * 3, "307009123");
    expect(await estimateFinishRent(client, Networks.TESTNET, CONTRACT)).toBe(307_009_123n);
    expect(simulated).toEqual(["contractCode"]);
  });
});
