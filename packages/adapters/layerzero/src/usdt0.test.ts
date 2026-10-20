import type { AllowanceCheck, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { RpcClient, XlmPriceSource } from "@mavna/stellar";
import {
  Address,
  Networks,
  nativeToScVal,
  Asset as StellarAsset,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import {
  type Abi,
  decodeFunctionData,
  encodeFunctionResult,
  encodePacked,
  getAddress,
  keccak256,
  pad,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayerZeroAdapter } from "./adapter.js";
import { SEND_ULN_ABI } from "./dvn.js";
import {
  LAYERZERO_DVN_METADATA_URL,
  LAYERZERO_METADATA_URL,
  LAYERZERO_OFT_REGISTRY_URL,
  SCAN_BASE_URL,
} from "./index.js";
import { ENDPOINT_ABI, ERC20_ABI, OFT_ABI, stellarToLocal } from "./oft.js";

/**
 * USDT0 as a send asset, from the token addresses to what lands on Stellar.
 *
 * Every remote answer is held still at its boundary: LayerZero's registries, the
 * EVM node, Horizon and LayerZero Scan through fetch, and the Stellar node
 * through the RpcClient's server. The discovery, the asset resolution, the
 * quote and the build above them are the real code.
 *
 * The Stellar side mirrors what mainnet answered on 19 October 2026: the OFT's
 * token is a Stellar asset contract whose AssetInfo is AlphaNum12 USDT0 issued
 * by GATISXX6...HN6Q, and the code is stored as a twelve-byte string padded
 * with NULs.
 */

const ISSUER = "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q";
const USDT0_ID = `USDT0:${ISSUER}`;
const USDT0_SAC = new StellarAsset("USDT0", ISSUER).contractId(Networks.PUBLIC);
const STELLAR_OFT = StrKey.encodeContract(Buffer.alloc(32, 4));
const STELLAR_ENDPOINT = StrKey.encodeContract(Buffer.alloc(32, 5));
const SOROBAN_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 6));

const OFT = getAddress("0x14e4a1b13bf7f943c8ff7c51fb60fa964a298d92");
const TOKEN = getAddress("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
const ENDPOINT = getAddress("0x1a44076050125825900e736c501f859c50fe728c");
const SEND_LIB = getAddress("0x975bcd720be66659e3eb3c0e4f1866a3020e493a");
const DVN_A = getAddress("0x2f55c492897526677c5b68fb199ea31e2c126416");
const DVN_B = getAddress("0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc");

const READY = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
const NEW_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const HORIZON = "https://horizon.test";
const SEND_HASH = `0x${"ab".repeat(32)}`;

interface World {
  /** What the Stellar OFT's Token slot names. */
  token: string;
  /** How the token contract is deployed, and what its AssetInfo says if it is a SAC. */
  tokenKind: "sac" | "wasm";
  assetInfoCode: string;
  assetInfoIssuer: string;
  account: boolean;
  trustline: boolean;
  /** What LayerZero Scan holds for SEND_HASH. */
  messages: unknown[];
  /** Whether the OFT's verifier set is its own choice or inherited from the network. */
  dvnInherited: boolean;
  /** True for an adapter that locks the token, as USDT0 does on Ethereum. */
  approvalRequired: boolean;
}

let world: World;

const ALL_ABI = [...OFT_ABI, ...ENDPOINT_ABI, ...SEND_ULN_ABI, ...ERC20_ABI] as unknown as Abi;

const uln = {
  confirmations: 20n,
  requiredDVNCount: 2,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: [DVN_A, DVN_B],
  optionalDVNs: [],
};

/** An eth_call, answered the way an Arbitrum USDT0 OFT answers it. */
function answerCall(to: string, data: `0x${string}`): `0x${string}` {
  const { functionName, args } = decodeFunctionData({ abi: ALL_ABI, data });
  const reply = (result: unknown): `0x${string}` =>
    encodeFunctionResult({ abi: ALL_ABI, functionName, result } as never);
  const target = getAddress(to);
  if (target === OFT) {
    switch (functionName) {
      case "peers":
        return reply(`0x${StrKey.decodeContract(STELLAR_OFT).toString("hex")}`);
      case "token":
        return reply(TOKEN);
      case "approvalRequired":
        return reply(world.approvalRequired);
      case "sharedDecimals":
        return reply(6);
      case "endpoint":
        return reply(ENDPOINT);
      case "enforcedOptions":
        return reply("0x00030100110100000000000000000000000000030d40");
      case "quoteSend":
        return reply({ nativeFee: 41_000_000_000_000n, lzTokenFee: 0n });
      case "quoteOFT": {
        const amount = ((args ?? [])[0] as { amountLD: bigint }).amountLD;
        return reply([
          { minAmountLD: 0n, maxAmountLD: 10n ** 30n },
          [],
          { amountSentLD: amount, amountReceivedLD: amount },
        ]);
      }
    }
  }
  if (target === ENDPOINT) {
    switch (functionName) {
      case "eid":
        return reply(30110);
      case "isSupportedEid":
        return reply(true);
      case "getSendLibrary":
        return reply(SEND_LIB);
    }
  }
  if (
    target === SEND_LIB &&
    (functionName === "getUlnConfig" || functionName === "getAppUlnConfig")
  ) {
    // an inherited set reads back from getAppUlnConfig as all zeros
    if (functionName === "getAppUlnConfig" && world.dvnInherited) {
      return reply({ ...uln, requiredDVNCount: 0, requiredDVNs: [] });
    }
    return reply(uln);
  }
  if (target === TOKEN) {
    // The token's own symbol on chain, which is not the registry's spelling.
    if (functionName === "symbol") return reply("USD₮0");
    if (functionName === "decimals") return reply(6);
  }
  throw new Error(`the EVM double has no answer for ${functionName} on ${to}`);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** LayerZero's registries and Scan, the Arbitrum node and Horizon, over fetch. */
function remoteServices(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === LAYERZERO_METADATA_URL) {
      return json({
        "stellar-mainnet": {
          deployments: [
            {
              version: 2,
              eid: "30600",
              endpointV2: { address: STELLAR_ENDPOINT },
              sendUln302: { address: StrKey.encodeContract(Buffer.alloc(32, 8)) },
              executor: { address: StrKey.encodeContract(Buffer.alloc(32, 9)) },
            },
          ],
        },
      });
    }
    if (url === LAYERZERO_OFT_REGISTRY_URL) {
      return json({
        USDT0: [
          { name: "USDT0", deployments: { arbitrum: { address: OFT.toLowerCase() } } },
          // filed under the same symbol and not the token, so never a candidate
          { name: "USDT0 Native Mesh", deployments: { arbitrum: { address: TOKEN } } },
        ],
      });
    }
    if (url === LAYERZERO_DVN_METADATA_URL) {
      // DVN_B left out, as LayerZero's list leaves some out
      return json({
        arbitrum: { dvns: { [DVN_A.toLowerCase()]: { canonicalName: "LayerZero Labs" } } },
      });
    }
    if (url.startsWith(`${HORIZON}/order_book`)) {
      return json({ bids: [{ price: "0.2" }], asks: [{ price: "0.2" }] });
    }
    if (url === `${SCAN_BASE_URL.mainnet}/messages/tx/${SEND_HASH}`) {
      return json({ data: world.messages });
    }
    if (url === "https://arb1.arbitrum.io/rpc") {
      const { method, params } = JSON.parse(init?.body as string) as {
        method: string;
        params: [{ to: string; data: `0x${string}` }];
      };
      if (method === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: "0xa4b1" });
      if (method === "eth_getCode") return json({ jsonrpc: "2.0", id: 1, result: "0x6080" });
      if (method === "eth_call") {
        return json({ jsonrpc: "2.0", id: 1, result: answerCall(params[0].to, params[0].data) });
      }
    }
    throw new Error(`the fetch double has no answer for ${url}`);
  });
}

const STELLAR_OFT_BYTES = `0x${StrKey.decodeContract(STELLAR_OFT).toString("hex")}` as const;

/**
 * A delivered USDT0 message from Arbitrum to Stellar, shaped the way Scan
 * answered for the real Polygon one (guid 0x2dc98848...6dd7): sender and
 * receiver as lowercase hex, the guid the endpoint derived from the pathway.
 */
function delivered(
  pathway: {
    srcEid?: number;
    dstEid?: number;
    sender?: string;
    receiver?: `0x${string}`;
    nonce?: number;
  } = {},
  guid?: string,
): unknown {
  const p = {
    srcEid: 30110,
    dstEid: 30600,
    sender: OFT.toLowerCase(),
    receiver: STELLAR_OFT_BYTES,
    nonce: 43,
    ...pathway,
  };
  return {
    guid:
      guid ??
      keccak256(
        encodePacked(
          ["uint64", "uint32", "bytes32", "uint32", "bytes32"],
          [BigInt(p.nonce), p.srcEid, pad(p.sender as `0x${string}`), p.dstEid, p.receiver],
        ),
      ),
    status: { name: "DELIVERED" },
    pathway: {
      srcEid: p.srcEid,
      dstEid: p.dstEid,
      nonce: p.nonce,
      sender: { address: p.sender, chain: "arbitrum" },
      receiver: { address: p.receiver, chain: p.dstEid === 30600 ? "stellar" : "ethereum" },
    },
    source: {
      // 24.875 in six shared decimals, after the recipient bytes32
      tx: {
        txHash: SEND_HASH,
        payload: `0x${"11".repeat(32)}${24_875_000n.toString(16).padStart(16, "0")}`,
      },
    },
    destination: { tx: { txHash: "cd".repeat(32) } },
  };
}

const sym = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const slot = (name: string, val: xdr.ScVal): xdr.ScMapEntry =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([sym(name)]), val });

function instance(
  contract: string,
  executable: xdr.ContractExecutable,
  storage: xdr.ScMapEntry[],
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage })),
    }),
  );
}

function stellarOftInstance(): xdr.LedgerEntryData {
  return instance(STELLAR_OFT, xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)), [
    slot("DecimalsDiff", nativeToScVal(1, { type: "u32" })),
    slot("Endpoint", new Address(STELLAR_ENDPOINT).toScVal()),
    slot("OftType", xdr.ScVal.scvVec([sym("MintBurn"), new Address(STELLAR_ENDPOINT).toScVal()])),
    slot("Token", new Address(world.token).toScVal()),
  ]);
}

function tokenInstance(): xdr.LedgerEntryData {
  if (world.tokenKind === "wasm") {
    return instance(
      world.token,
      xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 2)),
      [slot("Admin", new Address(STELLAR_ENDPOINT).toScVal())],
    );
  }
  const code = world.assetInfoCode.padEnd(world.assetInfoCode.length <= 4 ? 4 : 12, "\0");
  return instance(world.token, xdr.ContractExecutable.contractExecutableStellarAsset(), [
    slot(
      "AssetInfo",
      xdr.ScVal.scvVec([
        sym(world.assetInfoCode.length <= 4 ? "AlphaNum4" : "AlphaNum12"),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: sym("asset_code"), val: xdr.ScVal.scvString(code) }),
          new xdr.ScMapEntry({
            key: sym("issuer"),
            val: xdr.ScVal.scvBytes(StrKey.decodeEd25519PublicKey(world.assetInfoIssuer)),
          }),
        ]),
      ]),
    ),
  ]);
}

/** A real client whose node is a double, reading whatever `world` says. */
function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://soroban.test",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  vi.spyOn(client.server, "getLedgerEntries").mockImplementation(async (...keys) => {
    const entries: unknown[] = [];
    for (const key of keys) {
      const kind = key.switch().name;
      if (kind === "contractData") {
        const contract = Address.fromScAddress(key.contractData().contract()).toString();
        if (contract === STELLAR_OFT) entries.push({ key, val: stellarOftInstance() });
        if (contract === world.token) entries.push({ key, val: tokenInstance() });
      }
      if (kind === "account" && world.account) {
        entries.push({
          key,
          val: {
            switch: () => ({ name: "account" }),
            account: () => ({ balance: () => 50_000_000n, numSubEntries: () => 1 }),
          },
        });
      }
      if (kind === "trustline" && world.trustline) {
        entries.push({
          key,
          val: {
            switch: () => ({ name: "trustline" }),
            trustLine: () => ({ balance: () => 0n, limit: () => 10n ** 15n, flags: () => 1 }),
          },
        });
      }
    }
    return { entries, latestLedger: 100 } as never;
  });
  return client;
}

function mainnet(): LayerZeroAdapter {
  return new LayerZeroAdapter({
    network: "mainnet",
    rpc: stellarNode(),
    baseReserveStroops: 5_000_000,
    prices: new XlmPriceSource({ horizonUrl: HORIZON }),
  });
}

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

function routeOf(result: Route | RouteRejection): Route {
  if (!isRoute(result)) throw new Error(`declined: ${result.reason}: ${result.explanation}`);
  return result;
}

beforeEach(() => {
  world = {
    token: USDT0_SAC,
    tokenKind: "sac",
    assetInfoCode: "USDT0",
    assetInfoIssuer: ISSUER,
    account: true,
    trustline: true,
    messages: [delivered()],
    dvnInherited: false,
    approvalRequired: false,
  };
  remoteServices();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what a user sends and what lands, read from the deployment", () => {
  it("names the token the OFT moves on that chain, by address", async () => {
    const { from } = await mainnet().sendableAssets("arbitrum");
    expect(from).toEqual({
      chainId: "arbitrum",
      id: TOKEN,
      symbol: "USD₮0",
      decimals: 6,
      curatedBy: "LayerZero",
    });
  });

  it("names the classic asset the Stellar OFT credits, from the token's own storage", async () => {
    const { to } = await mainnet().sendableAssets("arbitrum");
    expect(to).toEqual({
      chainId: "stellar",
      id: USDT0_ID,
      symbol: "USDT0",
      decimals: 7,
      curatedBy: "LayerZero",
    });
  });

  it("refuses a delivered token that is not a Stellar asset contract, in words", async () => {
    world.token = SOROBAN_TOKEN;
    world.tokenKind = "wasm";
    await expect(mainnet().sendableAssets("arbitrum")).rejects.toThrow(
      /not a Stellar asset with a code and an issuer/,
    );
  });

  it("refuses an asset contract whose AssetInfo does not derive its own address", async () => {
    world.assetInfoIssuer = READY;
    await expect(mainnet().sendableAssets("arbitrum")).rejects.toMatchObject({
      retryable: false,
      message: expect.stringMatching(/does not derive/),
    });
  });

  it("says plainly that the test network has no USDT0", async () => {
    const testnet = new LayerZeroAdapter({
      network: "testnet",
      rpc: stellarNode(),
      baseReserveStroops: 5_000_000,
      prices: new XlmPriceSource({ horizonUrl: HORIZON }),
    });
    await expect(testnet.sendableAssets("arbitrum-sepolia")).rejects.toThrow(
      /no token on the test network/,
    );
  });
});

describe("quoting USDT0 into Stellar", () => {
  async function ask(destination: string, baseUnits = "25000000"): Promise<QuoteRequest> {
    const { from, to } = await mainnet().sendableAssets("arbitrum");
    return { from, to, sends: { asset: from, baseUnits }, destination, maxSlippageBps: 50 };
  }

  it("labels what arrives with the asset read from the chain", async () => {
    const adapter = mainnet();
    const request = await ask(READY);
    const route = routeOf(
      await adapter.quote({ ...request, to: { ...request.to, symbol: "anything" } }),
    );
    expect(route.receives.asset.id).toBe(USDT0_ID);
    expect(route.receives.asset.symbol).toBe("USDT0");
    expect(route.deliveredAtLeast.asset.id).toBe(USDT0_ID);
    // 25 at six decimals is 250000000 at Stellar's seven, less the 0.5% floor
    expect(route.receives.baseUnits).toBe("250000000");
    expect(route.deliveredAtLeast.baseUnits).toBe("248750000");
    expect(route.steps.some((s) => s.kind === "prepare-account")).toBe(false);
  });

  it("plans an account setup for an address that does not exist yet", async () => {
    world.account = false;
    world.trustline = false;
    const route = routeOf(await mainnet().quote(await ask(NEW_ACCOUNT)));
    expect(route.steps.some((s) => s.kind === "prepare-account")).toBe(true);
    expect(route.fees.some((f) => f.kind === "account-reserve")).toBe(true);
  });

  it("declines a Stellar asset with the same code and another issuer", async () => {
    const request = await ask(READY);
    const result = await mainnet().quote({
      ...request,
      to: { ...request.to, id: `USDT0:${READY}` },
    });
    expect(isRoute(result)).toBe(false);
    expect((result as RouteRejection).reason).toBe("asset-unsupported");
  });

  it("builds a send whose on-chain minimum is the quoted floor", async () => {
    const adapter = mainnet();
    const route = routeOf(await adapter.quote(await ask(READY)));
    const txs = await adapter.buildTransactions(route);
    // USDT0 on Arbitrum mints and burns, so there is no allowance to grant
    expect(txs).toHaveLength(1);
    const payload = JSON.parse(txs[0]?.payload ?? "{}") as {
      to: string;
      functionName: string;
      args: [{ minAmountLD: string; amountLD: string; to: string }];
    };
    expect(payload.to.toLowerCase()).toBe(OFT.toLowerCase());
    expect(payload.functionName).toBe("send");
    expect(payload.args[0].amountLD).toBe("25000000");
    expect(payload.args[0].minAmountLD).toBe(
      stellarToLocal(BigInt(route.deliveredAtLeast.baseUnits), 6, 6, 7).toString(),
    );
    expect(payload.args[0].minAmountLD).toBe("24875000");
    expect(payload.args[0].to).toBe(`0x${StrKey.decodeEd25519PublicKey(READY).toString("hex")}`);
    // the verifiers are named, by LayerZero's name or else by address
    expect(txs[0]?.describes).toContain(`2 verifiers must all agree (LayerZero Labs, ${DVN_B})`);
  });
});

describe("the approval, where the OFT locks the token", () => {
  /**
   * How a caller reads a transaction's condition, written from the documented
   * fields: skipped when the allowance is at least `atLeastBaseUnits`, or
   * exactly `skipAlsoWhenExactly` when that is set.
   */
  function skipped(condition: AllowanceCheck | undefined, allowance: bigint): boolean {
    if (condition === undefined) return false;
    if (allowance >= BigInt(condition.atLeastBaseUnits)) return true;
    return (
      condition.skipAlsoWhenExactly !== undefined &&
      allowance === BigInt(condition.skipAlsoWhenExactly)
    );
  }

  /**
   * Tether's USDT `approve`, as mainnet answered it on 20 October 2026 for an
   * eth_call with the allowance slot overridden: a non-zero value over a
   * non-zero allowance reverts, anything else is accepted.
   */
  function usdtApprove(allowance: bigint, value: bigint): bigint {
    if (allowance !== 0n && value !== 0n) throw new Error("execution reverted");
    return value;
  }

  /** What the caller's loop does: skip what it may, send the rest in order. */
  async function runApprovals(allowance: bigint): Promise<{ sent: string[]; allowance: bigint }> {
    world.approvalRequired = true;
    const adapter = mainnet();
    const { from, to } = await adapter.sendableAssets("arbitrum");
    const route = routeOf(
      await adapter.quote({
        from,
        to,
        sends: { asset: from, baseUnits: "150000000" },
        destination: READY,
        maxSlippageBps: 50,
      }),
    );
    const txs = await adapter.buildTransactions(route);
    const sent: string[] = [];
    let current = allowance;
    for (const tx of txs) {
      if (skipped(tx.unnecessaryWhen, current)) continue;
      const call = JSON.parse(tx.payload) as { functionName: string; args: string[] };
      if (call.functionName !== "approve") {
        sent.push(`${call.functionName}()`);
        continue;
      }
      sent.push(`approve(${call.args[1]})`);
      current = usdtApprove(current, BigInt(call.args[1] ?? ""));
    }
    return { sent, allowance: current };
  }

  it("clears a smaller allowance first, since USDT refuses to change one in place", async () => {
    // approved 100 earlier, declined the send, now sending 150
    const { sent, allowance } = await runApprovals(100_000_000n);
    expect(sent.slice(0, 2)).toEqual(["approve(0)", "approve(150000000)"]);
    expect(allowance).toBe(150_000_000n);
  });

  it("asks for no reset when there is no allowance to clear", async () => {
    const { sent } = await runApprovals(0n);
    expect(sent.slice(0, 1)).toEqual(["approve(150000000)"]);
  });

  it("asks for neither when the allowance already covers the send", async () => {
    const { sent } = await runApprovals(150_000_000n);
    expect(sent).toEqual(["send()"]);
  });

  it("says what the reset is for, and names the same token and spender", async () => {
    world.approvalRequired = true;
    const adapter = mainnet();
    const { from, to } = await adapter.sendableAssets("arbitrum");
    const route = routeOf(
      await adapter.quote({
        from,
        to,
        sends: { asset: from, baseUnits: "150000000" },
        destination: READY,
        maxSlippageBps: 50,
      }),
    );
    const [reset, approve] = await adapter.buildTransactions(route);
    expect(reset?.describes).toMatch(/clear/i);
    expect(reset?.unnecessaryWhen).toEqual({
      kind: "erc20-allowance",
      token: TOKEN,
      spender: OFT.toLowerCase(),
      atLeastBaseUnits: "150000000",
      skipAlsoWhenExactly: "0",
    });
    expect(approve?.unnecessaryWhen).toEqual({
      kind: "erc20-allowance",
      token: TOKEN,
      spender: OFT.toLowerCase(),
      atLeastBaseUnits: "150000000",
    });
  });
});

describe("status, for a USDT0 transfer", () => {
  it("reports what arrived as the classic asset, not the asset contract", async () => {
    const phase = await mainnet().status({
      sourceTxHash: SEND_HASH,
      depositAddress: undefined,
      destinationAddress: READY,
      sourceChainId: undefined,
    });
    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    expect(phase.received.asset.id).toBe(USDT0_ID);
    expect(phase.received.asset.symbol).toBe("USDT0");
    expect(phase.received.baseUnits).toBe("248750000");
    expect(phase.ref.chainId).toBe("stellar");
  });

  const lookUp = () =>
    mainnet().status({
      sourceTxHash: SEND_HASH,
      depositAddress: undefined,
      destinationAddress: READY,
      sourceChainId: undefined,
    });

  it("does not answer for a message bound for another chain", async () => {
    // the shape of 0xa9658a79...f0e0, USDT0 Polygon to Ethereum, which was once
    // reported here as delivered on Stellar
    world.messages = [delivered({ dstEid: 30101 })];
    expect(await lookUp()).toEqual({ phase: "idle" });
  });

  it("does not answer for another contract's message to Stellar", async () => {
    world.messages = [delivered({ sender: `0x${"77".repeat(20)}` })];
    expect(await lookUp()).toEqual({ phase: "idle" });
  });

  it("does not answer for a message delivered to another Stellar contract", async () => {
    world.messages = [delivered({ receiver: `0x${"99".repeat(32)}` })];
    expect(await lookUp()).toEqual({ phase: "idle" });
  });

  it("does not answer for a message from another endpoint", async () => {
    world.messages = [delivered({ srcEid: 30109 })];
    expect(await lookUp()).toEqual({ phase: "idle" });
  });

  it("does not believe a record whose guid is not the one its pathway derives", async () => {
    world.messages = [delivered({}, `0x${"ee".repeat(32)}`)];
    expect(await lookUp()).toEqual({ phase: "idle" });
  });

  it("picks the Stellar-bound message out of several in one transaction", async () => {
    world.messages = [delivered({ dstEid: 30101 }), delivered()];
    const phase = await lookUp();
    expect(phase.phase).toBe("done");
  });

  it("still calls an unindexed hash pending", async () => {
    world.messages = [];
    expect((await lookUp()).phase).toBe("pending");
  });

  it("still reads a delivered transfer when a send-time gate fails today", async () => {
    // a new send would be refused, and yesterday's delivery is still a delivery
    world.dvnInherited = true;
    await expect(mainnet().sendableAssets("arbitrum")).rejects.toThrow();
    const phase = await lookUp();
    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    expect(phase.received.baseUnits).toBe("248750000");
    expect(phase.received.asset.id).toBe(USDT0_ID);
  });

  it("says it could not read the amount rather than calling it pending", async () => {
    // a token whose storage cannot be read is an error, never a quiet pending
    world.token = StrKey.encodeContract(Buffer.alloc(32, 12));
    await expect(lookUp()).rejects.toThrow(/does not derive its own address/);
  });
});
