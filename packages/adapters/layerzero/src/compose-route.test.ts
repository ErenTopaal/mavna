import type { Asset, ComposeQuoteRequest, Route, RouteRejection } from "@mavna/core";
import { isRejection } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import { Keypair, Networks, Asset as StellarAsset, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import entries from "./__fixtures__/testnet-ledger-entries.json" with { type: "json" };
import { LayerZeroAdapter } from "./adapter.js";
import { arrivalRecipientOf } from "./compose.js";
import {
  COMPOSE_FINISH_BASE_STROOPS,
  type ComposeContext,
  composePhase,
  composeSendFor,
  quoteComposeRoute,
} from "./compose-route.js";
import { ARRIVAL_CONTRACTS } from "./config.js";
import type { Discovery, ResolvedRoute } from "./discovery.js";
import type { SendParam } from "./oft.js";

// The testnet harness deployment: its allowlisted sender is a key standing in
// for an OFT, crediting native XLM. Ledger entries are recorded from testnet;
// the EVM side (Discovery's reads) and the venue are the network boundaries
// replaced here.
const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";
const ENDPOINT = "CALTBA5S6GRJEHAXFP45LGGLKWWAF7HTZCPNUBUJF2HWWRRLQNV35AIV";
const SENDER = "GBNCXZUVSV4GCBTYKCUPK46XS5U3CEDP6F54NZIWQ4GN3SWD52D3N2NB";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const READY = "GCC6RRT2HPHDRHJEMA3UHYNCOTCQJSWBHKNF44PS2IQSMCPVIQYEC7AL";
const NO_TRUSTLINE = "GDD7P7D5QG76BS4UNHTGCL4UOIHKASZFKPDP3TQ4GTA7JORM6TYEOK4Y";
// on the testnet contract's path list, but not a wanted asset
const AQUA = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
// a testnet token on neither list (an arbitrary custom token Aquarius routes through)
const STRANGER = "CC52SIPHNMTBMHSBYTUI3R53PPMBGTEOJ566GFMSREBFA3KVJ4MY7OBT";
const OFF_LIST = [
  { tokens: [XLM_SAC, STRANGER], poolIndex: "07".repeat(32), tokenOut: STRANGER },
  { tokens: [STRANGER, USDC_SAC], poolIndex: "08".repeat(32), tokenOut: USDC_SAC },
];

// USDT0's Arbitrum OFT, enforcedOptions(30600, 2) and (30600, 1), read 2026-10-19
const SEND_AND_CALL =
  "0x0003010011010000000000000000000000000007a1200100130300000000000000000000000000000007a120";
const SEND_ONLY = "0x0003010011010000000000000000000000000007a120";

const xlm: Asset = {
  chainId: "stellar-testnet",
  id: "native",
  symbol: "XLM",
  decimals: 7,
  curatedBy: "Stellar",
};
const usdc: Asset = {
  chainId: "stellar-testnet",
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};
const source: Asset = {
  chainId: "arbitrum-sepolia",
  id: "0x0000000000000000000000000000000000000001",
  symbol: "TOFT",
  decimals: 6,
  curatedBy: undefined,
};

/** An account entry, and a USDC trustline with this much room under its limit. */
function accountWithRoom(address: string, room: bigint) {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const at = (key: xdr.LedgerKey, data: xdr.LedgerEntryData) => ({
    key: key.toXdr("base64"),
    xdr: data.toXdr("base64"),
    lastModifiedLedgerSeq: entries.arrival.latestLedger,
  });
  const [code, issuer] = usdc.id.split(":");
  const line = new StellarAsset(code ?? "", issuer).toTrustLineXdrObject();
  return [
    at(
      xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })),
      xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId,
          balance: xdr.Int64.fromString("100000000"),
          seqNum: xdr.Int64.fromString("1"),
          numSubEntries: 1,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        }),
      ),
    ),
    at(
      xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: line })),
      xdr.LedgerEntryData.trustline(
        new xdr.TrustLineEntry({
          accountId,
          asset: line,
          balance: xdr.Int64.fromString("0"),
          limit: xdr.Int64.fromString(room.toString()),
          flags: 1,
          ext: xdr.TrustLineEntryExt.v0(),
        }),
      ),
    ),
  ];
}

/** A recipient whose USDC trustline has room for only 0.05 USDC. */
const NEARLY_FULL = Keypair.random().publicKey();

function rpcFromRecording(): RpcClient {
  const client = new RpcClient({ url: "https://rpc.invalid" });
  const known = new Map<string, { readonly xdr: string; readonly lastModifiedLedgerSeq: number }>();
  for (const recorded of Object.values(entries)) {
    for (const e of recorded.entries) known.set(e.key, e);
  }
  for (const e of accountWithRoom(NEARLY_FULL, 500_000n)) known.set(e.key, e);
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => ({
    latestLedger: entries.arrival.latestLedger,
    entries: keys.flatMap((k) => {
      const e = known.get(k.toXdr("base64"));
      return e === undefined
        ? []
        : [
            {
              key: k,
              val: xdr.LedgerEntryData.fromXdr(e.xdr, "base64"),
              lastModifiedLedgerSeq: e.lastModifiedLedgerSeq,
            },
          ];
    }),
  }));
  return client;
}

const resolved = {
  chainId: "arbitrum-sepolia",
  source: { name: "Arbitrum" },
  tokenSymbol: "TOFT",
  tokenDecimals: 6,
  sharedDecimals: 6,
  stellarOft: SENDER,
  stellar: { endpoint: ENDPOINT, token: XLM_SAC, decimalsDiff: 1, kind: "MintBurn" },
} as unknown as ResolvedRoute;

function context(
  overrides: {
    readonly enforced?: string;
    readonly route?: ResolvedRoute;
    readonly venue?: ComposeContext["arrival"]["venue"];
  } = {},
): { ctx: ComposeContext; sent: SendParam[] } {
  const sent: SendParam[] = [];
  const discovery = {
    routeFrom: async () => overrides.route ?? resolved,
    enforcedOptionsFor: async () => overrides.enforced ?? SEND_AND_CALL,
    quoteNativeFee: async (_: unknown, param: SendParam) => {
      sent.push(param);
      return { nativeFee: 7_000n, lzTokenFee: 0n };
    },
  } as unknown as Discovery;
  return {
    sent,
    ctx: {
      network: "testnet",
      rpc: rpcFromRecording(),
      passphrase: Networks.TESTNET,
      discovery,
      arrival: {
        contract: ARRIVAL,
        venue: overrides.venue ?? {
          id: "aquarius",
          quotePath: async () => ({
            provider: "aquarius",
            amountOut: "1000000",
            amountOutMinimum: "990000",
            path: [{ tokens: [XLM_SAC, USDC_SAC], poolIndex: "07".repeat(32), tokenOut: USDC_SAC }],
          }),
        },
      },
      lzReceiveGas: undefined,
      decline: (reason, explanation): RouteRejection => ({
        source: "layerzero",
        reason,
        explanation,
        retryable: false,
      }),
    },
  };
}

const plain = {
  id: "layerzero-arbitrum-sepolia-stellar-testnet",
  source: "layerzero",
  trustModel: "dvn-stack",
  destination: READY,
  sends: { asset: source, baseUnits: "10000000" },
  receives: { asset: xlm, baseUnits: "100000000" },
  receivesAtLeast: { asset: xlm, baseUnits: "99500000" },
  deliveredAtLeast: { asset: xlm, baseUnits: "99500000" },
  fees: [
    {
      kind: "gas",
      total: { asset: { ...source, id: "native", symbol: "ETH" }, baseUnits: "5000" },
      recipients: [
        {
          name: "LayerZero verifiers and executor",
          amount: { asset: { ...source, id: "native", symbol: "ETH" }, baseUnits: "5000" },
          address: undefined,
        },
      ],
      includedInQuote: false,
    },
  ],
  estimatedSeconds: 120,
  steps: [
    {
      id: "bridge-0",
      kind: "bridge",
      source: "layerzero",
      from: { asset: source, baseUnits: "10000000" },
      to: { asset: xlm, baseUnits: "100000000" },
      estimatedSeconds: 120,
      execution: undefined,
    },
  ],
  signaturesRequired: 1,
  expiresAtUnix: 0,
} as unknown as Route;

const request = (destination = READY): ComposeQuoteRequest => ({
  from: source,
  to: usdc,
  sends: plain.sends,
  destination,
  maxSlippageBps: 50,
  plain: { ...plain, destination },
  arriving: xlm,
  arrivingContract: XLM_SAC,
  wantedContract: USDC_SAC,
});

describe("a compose route", () => {
  it("is the plain send delivered to the Arrival Contract, converting on arrival", async () => {
    const { ctx, sent } = context();
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route)) throw new Error(JSON.stringify(route));

    expect(route.compose?.contract).toBe(ARRIVAL);
    expect(route.receives).toEqual({ asset: usdc, baseUnits: "1000000" });
    expect(route.receivesAtLeast).toEqual({ asset: usdc, baseUnits: "990000" });
    // the conversion is a step nobody signs
    expect(route.steps.map((s) => s.kind)).toEqual(["bridge", "compose"]);
    expect(route.signaturesRequired).toBe(1);
    expect(route.compose?.walletNote).toMatch(/No Stellar wallet needed/);
    expect(route.compose?.trust).toMatch(/no administrator/);
    // priced as the send it will be: to the contract, carrying the user's instructions
    expect(sent[0]?.to).toBe(`0x${Buffer.from(StrKey.decodeContract(ARRIVAL)).toString("hex")}`);
    expect(arrivalRecipientOf(sent[0]?.composeMsg ?? "0x")).toBe(READY);
    expect(sent[0]?.minAmountLD).toBe(9_950_000n);
    expect(route.fees.find((f) => f.kind === "gas")?.total.baseUnits).toBe("7000");
  });

  it("asks the venue with a tighter slippage, and says plainly what happens below the minimum", async () => {
    const asked: number[] = [];
    const { ctx } = context({
      venue: {
        id: "aquarius",
        quotePath: async (q) => {
          asked.push(q.maxSlippageBps);
          return {
            provider: "aquarius",
            amountOut: "1000000",
            amountOutMinimum: "998000",
            path: [{ tokens: [XLM_SAC, USDC_SAC], poolIndex: "07".repeat(32), tokenOut: USDC_SAC }],
          };
        },
      },
    });
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route)) throw new Error(JSON.stringify(route));
    expect(asked).toEqual([20]);
    expect(route.compose?.fallback).toBe(
      "If USDC cannot be bought for at least your minimum, you receive XLM as it came instead.",
    );
    expect(route.compose?.trust).toMatch(/expect the minimum/i);
  });

  it("itemises the integrator fee and keeps the user's floor after it", async () => {
    const { ctx } = context();
    const route = await quoteComposeRoute(ctx, {
      ...request(),
      integratorFee: { bps: 100, recipient: READY, recipientName: "Example app" },
    });
    if (route === undefined || isRejection(route)) throw new Error(JSON.stringify(route));
    expect(route.receives.baseUnits).toBe("990000");
    // floor(990000 * 0.99), which the contract turns back into a venue floor of
    // ceil(980100 / 0.99) = 990000, inside the venue's own minimum
    expect(route.receivesAtLeast.baseUnits).toBe("980100");
    expect(route.compose?.fee).toEqual({ bps: 100, recipient: READY });
    const line = route.fees.find((f) => f.kind === "integrator");
    expect(line?.total).toEqual({ asset: usdc, baseUnits: "10000" });
    expect(line?.recipients[0]?.name).toBe("Example app");
  });

  it("is refused when the integrator's fee account is not on Stellar", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, {
      ...request(),
      integratorFee: {
        bps: 30,
        recipient: "0x0000000000000000000000000000000000000001",
        recipientName: "App",
      },
    });
    expect((result as RouteRejection).explanation).toMatch(/not a Stellar account/);
  });

  it("declines a slippage that is not a whole number of basis points under the whole", async () => {
    const { ctx } = context();
    for (const bps of [0.5, -1, 10_000]) {
      const result = await quoteComposeRoute(ctx, { ...request(), maxSlippageBps: bps });
      expect(result).toMatchObject({ reason: "errored", retryable: false });
    }
  });

  it("is refused, readably, for an account that cannot hold the wanted asset", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, request(NO_TRUSTLINE));
    expect(result).toMatchObject({ reason: "destination-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/cannot hold USDC yet/);
  });

  it("is refused for an account whose trustline has no room for what the conversion pays", async () => {
    // the venue quotes 0.1 USDC, twice what the limit leaves room for
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, request(NEARLY_FULL));
    expect(result).toMatchObject({ reason: "destination-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/room for only 0\.05 USDC/);
  });

  it("is refused for a contract id with nothing deployed behind it", async () => {
    const { ctx } = context();
    const empty = StrKey.encodeContract(Buffer.alloc(32, 3));
    const result = await quoteComposeRoute(ctx, request(empty));
    expect(result).toMatchObject({ reason: "destination-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/No contract exists/);
  });

  it("leaves a brand-new account to the plain route", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, request(Keypair.random().publicKey()));
    expect((result as RouteRejection).explanation).toMatch(/does not exist yet/);
    expect((result as RouteRejection).explanation).toMatch(/plain route/);
  });

  it("serves a contract recipient, which needs no trustline", async () => {
    const { ctx } = context();
    const route = await quoteComposeRoute(ctx, request(USDC_SAC));
    expect(route !== undefined && !isRejection(route)).toBe(true);
  });

  it("refuses a muxed address, which does not fit the message", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(
      ctx,
      request("MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ"),
    );
    expect(result).toMatchObject({ reason: "destination-unsupported" });
  });

  it("refuses a token the contract was not built to accept", async () => {
    const { ctx } = context({
      route: { ...resolved, stellarOft: Keypair.random().publicKey() } as ResolvedRoute,
    });
    const result = await quoteComposeRoute(ctx, request());
    expect(result).toMatchObject({ reason: "asset-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/does not accept/);
  });

  it("refuses to guess gas for a compose the OApp does not pay for", async () => {
    const { ctx } = context({ enforced: SEND_ONLY });
    const result = await quoteComposeRoute(ctx, request());
    expect((result as RouteRejection).explanation).toMatch(/lzComposeGas/);
  });

  it("is refused for a wanted asset the contract does not convert into", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, {
      ...request(),
      to: { ...usdc, id: "AQUA:GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER" },
      wantedContract: AQUA,
    });
    expect(result).toMatchObject({ reason: "asset-unsupported" });
    expect((result as RouteRejection).explanation).toMatch(/does not convert into/);
  });

  it("is refused when the venue's path runs through a token off the contract's list", async () => {
    const { ctx } = context({
      venue: {
        id: "aquarius",
        quotePath: async () => ({
          provider: "aquarius",
          amountOut: "1000000",
          amountOutMinimum: "990000",
          path: OFF_LIST,
        }),
      },
    });
    const result = await quoteComposeRoute(ctx, request());
    expect(result).toMatchObject({ reason: "no-liquidity" });
    expect((result as RouteRejection).explanation).toMatch(/does not use/);
  });

  it("says when there is no liquidity to convert", async () => {
    const { ctx } = context({
      venue: {
        id: "aquarius",
        quotePath: async () => {
          throw new Error("no path");
        },
      },
    });
    const result = await quoteComposeRoute(ctx, request());
    expect(result).toMatchObject({ reason: "no-liquidity" });
  });

  it("offers nothing when the wanted asset is what arrives anyway", async () => {
    const { ctx } = context();
    expect(await quoteComposeRoute(ctx, { ...request(), to: xlm })).toBeUndefined();
  });
});

describe("the Arrival Contract never pays itself", () => {
  // funds the contract sends to itself sit in it with no one able to take them out
  it("declines the contract's own id as the recipient", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, request(ARRIVAL));
    expect(result).toMatchObject({ reason: "destination-unsupported" });
  });

  it("declines the contract's own id as the integrator's fee account", async () => {
    const { ctx } = context();
    const result = await quoteComposeRoute(ctx, {
      ...request(),
      integratorFee: { bps: 100, recipient: ARRIVAL, recipientName: "Example app" },
    });
    expect(result).toMatchObject({ reason: "destination-unsupported" });
  });

  it("refuses either again when a route naming it is built", async () => {
    const { ctx } = context();
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route) || route.compose === undefined) {
      throw new Error("expected a route");
    }
    await expect(
      composeSendFor(ctx, { ...route, compose: route.compose, destination: ARRIVAL }, resolved),
    ).rejects.toThrow(/Arrival Contract itself/);
    await expect(
      composeSendFor(
        ctx,
        { ...route, compose: { ...route.compose, fee: { bps: 100, recipient: ARRIVAL } } },
        resolved,
      ),
    ).rejects.toThrow(/Arrival Contract itself/);
  });
});

describe("building a compose send", () => {
  it("refuses a route naming any contract but the configured one", async () => {
    const { ctx } = context();
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route) || route.compose === undefined) {
      throw new Error("expected a route");
    }
    await expect(
      composeSendFor(
        ctx,
        { ...route, compose: { ...route.compose, contract: USDC_SAC } },
        resolved,
      ),
    ).rejects.toThrow(/not the Arrival Contract/);
    await expect(
      composeSendFor(ctx, { ...route, compose: { ...route.compose, path: OFF_LIST } }, resolved),
    ).rejects.toThrow(/would not convert/);
    // checked again when built, not only when quoted: a compose to a recipient that
    // cannot take what arrives would sit in the contract with no one to rescue it
    await expect(
      composeSendFor(
        ctx,
        { ...route, compose: route.compose, destination: Keypair.random().publicKey() },
        resolved,
      ),
    ).rejects.toThrow(/does not exist yet/);
    await expect(
      composeSendFor(ctx, { ...route, compose: route.compose, destination: NEARLY_FULL }, resolved),
    ).rejects.toThrow(/room for only/);
    await expect(
      composeSendFor(
        ctx,
        {
          ...route,
          compose: route.compose,
          destination: "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAGZFQ",
        },
        resolved,
      ),
    ).rejects.toThrow();
    const built = await composeSendFor(ctx, { ...route, compose: route.compose }, resolved);
    expect(built.to).toBe(ARRIVAL);
    expect(built.extraOptions).toBe("0x");
    expect(arrivalRecipientOf(built.composeMsg)).toBe(READY);
  });
});

describe("what finishing a compose route by hand would cost", () => {
  it("carries the simulated renewal of the contract's storage plus the run itself", async () => {
    const { ctx } = context();
    // the recording carries no TTLs, so both entries read as due for renewal
    vi.spyOn(ctx.rpc.server, "simulateTransaction").mockResolvedValue({
      latestLedger: entries.arrival.latestLedger,
      minResourceFee: "307009123",
    } as never);
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route)) throw new Error(JSON.stringify(route));
    expect(route.compose?.finishCostStroops).toBe(
      (307_009_123n + COMPOSE_FINISH_BASE_STROOPS).toString(),
    );
  });

  it("says nothing rather than a guess when the renewal cannot be priced", async () => {
    const { ctx } = context();
    vi.spyOn(ctx.rpc.server, "simulateTransaction").mockResolvedValue({
      latestLedger: entries.arrival.latestLedger,
      error: "HostError: something",
    } as never);
    const route = await quoteComposeRoute(ctx, request());
    if (route === undefined || isRejection(route)) throw new Error(JSON.stringify(route));
    expect(route.compose?.finishCostStroops).toBeUndefined();
  });
});

describe("the conversion path a compose route asks for", () => {
  it("is built only through the tokens the contract lists, never whatever the quoting service picks", async () => {
    const asked: Array<readonly string[] | undefined> = [];
    const { ctx } = context({
      venue: {
        id: "aquarius",
        quotePath: async (q) => {
          asked.push(q.via);
          return {
            provider: "aquarius",
            amountOut: "1000000",
            amountOutMinimum: "998000",
            path: [{ tokens: [XLM_SAC, USDC_SAC], poolIndex: "07".repeat(32), tokenOut: USDC_SAC }],
          };
        },
      },
    });
    await quoteComposeRoute(ctx, request());
    // the testnet contract's path tokens, read from its storage
    expect(asked).toEqual([[AQUA, "CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN"]]);
  });
});

describe("the Arrival Contract each network has", () => {
  it("names the testnet deployment with the lists it was built with", () => {
    expect(ARRIVAL_CONTRACTS.testnet).toEqual({
      contract: ARRIVAL,
      wasmSha256: "468af775ca15d3c8acdffeccaeee9053c73f580831acff590f1d5d15e7f0db7b",
      endpoint: ENDPOINT,
      router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
      ofts: [[SENDER, XLM_SAC]],
      wanted: [USDC_SAC],
      pathTokens: [AQUA, "CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN"],
    });
  });

  it("has none on mainnet, and a rail there says so instead of staying silent", async () => {
    expect(ARRIVAL_CONTRACTS.mainnet).toBeUndefined();
    const rail = new LayerZeroAdapter({
      network: "mainnet",
      rpc: new RpcClient({ url: "https://example.invalid" }),
      baseReserveStroops: 5_000_000,
    });
    const answer = await rail.quoteCompose(request());
    expect(answer !== undefined && isRejection(answer)).toBe(true);
    if (answer === undefined || !isRejection(answer)) return;
    expect(answer.reason).toBe("chain-unsupported");
    expect(answer.retryable).toBe(false);
    expect(answer.explanation).toMatch(/no Arrival Contract on mainnet.*plain route/);
  });
});

describe("reading a compose's status from LayerZero's record", () => {
  // what Scan carries for a compose to the Arrival Contract: recipient, amount, from, message
  const payloadTo = (contract: string) =>
    `0x${Buffer.from(StrKey.decodeContract(contract)).toString("hex")}${100_000_000n.toString(16).padStart(16, "0")}${"ab".repeat(32)}0102`;
  const scan = (contract: string, blockTimestamp?: number) => ({
    guid: `0x${"cd".repeat(32)}`,
    pathway: { nonce: 1, srcEid: 30110 },
    source: { tx: { payload: payloadTo(contract) } },
    destination: {
      tx: { txHash: "7e37", ...(blockTimestamp === undefined ? {} : { blockTimestamp }) },
    },
  });
  const ref = { chainId: "stellar-testnet", txHash: "7e37", explorerUrl: "" };

  it("dates a delivery Scan did not time from the Stellar transaction itself", async () => {
    const { ctx } = context();
    vi.spyOn(ctx.rpc.server, "getTransaction").mockResolvedValue({
      status: "SUCCESS",
      ledger: 5,
      createdAt: 1_700_000_000,
    } as never);
    vi.spyOn(ctx.rpc.server, "getHealth").mockResolvedValue({
      oldestLedger: 1,
      latestLedger: 9,
    } as never);
    vi.spyOn(ctx.rpc.server, "getEvents").mockResolvedValue({
      events: [],
      latestLedger: 9,
    } as never);
    vi.spyOn(ctx.rpc.server, "simulateTransaction").mockResolvedValue({
      latestLedger: 9,
      result: { retval: xdr.ScVal.scvBytes(Buffer.alloc(32, 3)), auth: [] },
    } as never);
    const phase = await composePhase(ctx, scan(ARRIVAL) as never, "arbitrum-sepolia", ref);
    expect(phase).toMatchObject({
      phase: "delivered-conversion-pending",
      deliveredAtUnix: 1_700_000_000,
    });
  });

  it("says plainly that a compose went to another Arrival Contract rather than calling it delivered", async () => {
    const { ctx } = context();
    const phase = await composePhase(ctx, scan(STRANGER) as never, "arbitrum-sepolia", ref);
    expect(phase?.phase).toBe("stalled");
    if (phase?.phase !== "stalled") return;
    expect(phase.remedy).toMatchObject({ kind: "contact" });
    expect(phase.remedy.because).toMatch(/another Arrival Contract/);
  });
});
