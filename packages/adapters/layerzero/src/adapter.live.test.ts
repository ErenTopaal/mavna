import type { Asset, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { ADAPTER_QUOTE_TIMEOUT_MS } from "@mavna/core";
import { PUBLIC_MAINNET_RPC_URLS, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { beforeAll, describe, expect, it } from "vitest";
import { LayerZeroAdapter } from "./adapter.js";
import { readArrivalConfig } from "./compose.js";
import { ARRIVAL_CONTRACTS, STELLAR_SIDE } from "./config.js";
import { Discovery, type ResolvedRoute, readStellarOft } from "./discovery.js";
import { isExplicitlyConfigured, verifierThreshold } from "./dvn.js";

/**
 * The adapter, against the real networks.
 *
 * Every address, endpoint id, peer and verifier set below is resolved at run
 * time and then asserted. Nothing is compared against a constant written into
 * this file, because a constant written into this file is exactly what went
 * stale last time: the Stellar testnet addresses the project specification
 * recorded as verified were replaced on 4 August 2026 while remaining live and
 * answering. A test that pinned them would still be green today and still be
 * pointing at the wrong deployment.
 *
 * Mainnet is read here, deliberately. Quoting is a view call and a registry
 * fetch, it moves nothing and costs nothing, and it is the only place a working
 * end-to-end pathway to Stellar exists. Testing only against a testnet with no
 * obtainable token would prove nothing about the rail.
 */

const mainnetRpcUrl = PUBLIC_MAINNET_RPC_URLS[0];
if (mainnetRpcUrl === undefined) throw new Error("no mainnet RPC is configured");

const mainnetRpc = new RpcClient({ url: mainnetRpcUrl });
const testnetRpc = new RpcClient({ url: PUBLIC_TESTNET_RPC_URL });

const mainnet = new LayerZeroAdapter({
  network: "mainnet",
  rpc: mainnetRpc,
  baseReserveStroops: 5_000_000,
});
const testnet = new LayerZeroAdapter({
  network: "testnet",
  rpc: testnetRpc,
  baseReserveStroops: 5_000_000,
});

const discovery = new Discovery({ network: "mainnet", rpc: mainnetRpc });

/** Valid, well formed, and has never existed on either network. */
const UNFUNDED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

/** The request an app would build once it has resolved what a chain can send. */
function askFrom(route: ResolvedRoute, over: Partial<QuoteRequest> = {}): QuoteRequest {
  const from: Asset = {
    chainId: route.chainId,
    id: route.token,
    symbol: route.tokenSymbol,
    decimals: route.tokenDecimals,
    curatedBy: "LayerZero",
  };
  const to: Asset = {
    chainId: STELLAR_SIDE.mainnet.chainId,
    id: "USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    decimals: 7,
    curatedBy: "Tether",
  };
  return {
    from,
    to,
    sends: { asset: from, baseUnits: (25n * 10n ** BigInt(route.tokenDecimals)).toString() },
    destination: UNFUNDED,
    maxSlippageBps: 50,
    ...over,
  };
}

describe("resolving LayerZero from the chains rather than from a table", () => {
  let ethereum: ResolvedRoute;

  beforeAll(async () => {
    ethereum = await discovery.routeFrom("ethereum");
  });

  it("finds the Stellar deployment LayerZero currently advertises", async () => {
    const stellar = await discovery.stellar();
    expect(stellar.eid).toBe(STELLAR_SIDE.mainnet.eid);
    expect(stellar.endpoint).toMatch(/^C[A-Z2-7]{55}$/);
    expect(stellar.sendUln302).toMatch(/^C[A-Z2-7]{55}$/);
    expect(stellar.executor).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("derives the endpoint from the token, not from the registry", async () => {
    // The registry is asked where Stellar is. It is never asked where the EVM
    // endpoint is: that comes from the OFT itself, so a token wired to some
    // other endpoint cannot be quoted as though it were wired to this one.
    expect(ethereum.endpoint).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ethereum.sourceEid).toBeGreaterThan(30000);
    expect(ethereum.sourceEid).toBeLessThan(40000);
  });

  it("reads what the token is from the token", () => {
    expect(ethereum.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ethereum.tokenSymbol).toMatch(/USD/i);
    expect(ethereum.tokenDecimals).toBeGreaterThan(0);
    expect(ethereum.sharedDecimals).toBeGreaterThan(0);
    expect(ethereum.sharedDecimals).toBeLessThanOrEqual(ethereum.tokenDecimals);
  });

  /**
   * The check the whole discovery module is built around.
   *
   * A peer pointing at a Stellar OFT registered on a superseded endpoint looks
   * completely healthy from the EVM side, and sending into one delivers nothing
   * with no error and no recovery. So the Stellar contract is asked which
   * endpoint it is registered on, and it must be the current one.
   */
  it("asks the Stellar peer which endpoint it is on, and insists it is the current one", async () => {
    const stellar = await discovery.stellar();
    expect(ethereum.stellarOft).toMatch(/^C[A-Z2-7]{55}$/);
    expect(ethereum.stellar.endpoint).toBe(stellar.endpoint);
    expect(ethereum.stellar.token).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("agrees with Stellar about how many decimals the asset has", () => {
    // Six shared against Stellar's seven for USDT0, so the contract's own
    // difference must close the gap exactly. Anything else and the amount
    // delivered is not the amount quoted.
    expect(ethereum.sharedDecimals + ethereum.stellar.decimalsDiff).toBe(7);
  });

  /**
   * Four chains, one destination. If any of them peered somewhere else, funds
   * sent from that chain would land in a different contract, and this is the
   * cheapest possible way to notice.
   */
  it("finds the same Stellar contract from every chain that reaches it", async () => {
    const chains = ["ethereum", "arbitrum", "optimism", "polygon"];
    const resolved = await Promise.all(chains.map((c) => discovery.routeFrom(c)));
    const peers = new Set(resolved.map((r) => r.stellarOft));
    expect(peers.size).toBe(1);
    const tokens = new Set(resolved.map((r) => r.token.toLowerCase()));
    // Each chain's own token, never another chain's. A collision would mean one
    // chain's address leaked into another.
    expect(tokens.size).toBe(chains.length);
  });

  /**
   * The reason `approvalRequired` is read rather than assumed. The same token
   * locks real USDT on Ethereum and mints and burns everywhere else, so a rule
   * inferred from the deployment's name would be wrong most of the time.
   */
  it("asks each contract whether an approval is needed instead of assuming", async () => {
    const arbitrum = await discovery.routeFrom("arbitrum");
    expect(ethereum.approvalRequired).toBe(true);
    expect(arbitrum.approvalRequired).toBe(false);
  });

  it("finds a verifier set the application chose, not one it inherited", () => {
    expect(verifierThreshold(ethereum.uln)).toBeGreaterThan(0);
    // The mainnet default names a DVN that is not deployed, so an application
    // relying on it cannot be quoted at all. This one set its own.
    expect(isExplicitlyConfigured(ethereum.appUln)).toBe(true);
    expect(ethereum.uln.requiredDVNs.length).toBe(ethereum.uln.requiredDVNCount);
    expect(Number(ethereum.uln.confirmations)).toBeGreaterThan(0);
  });

  it("finds the send library the application chose", () => {
    expect(ethereum.sendLibrary).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ethereum.sendLibrary).not.toBe(`0x${"0".repeat(40)}`);
  });
});

describe("USDT0 as a send asset, resolved from mainnet", () => {
  /**
   * The one place this file names the classic asset, and only to check the
   * chain against what USDT0 and Stellar publish. The adapter reads it from the
   * Stellar token's own storage.
   */
  it("reads the classic asset USDT0 lands as from the Stellar token itself", async () => {
    const { from, to } = await mainnet.sendableAssets("arbitrum");
    expect(to.id).toBe("USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q");
    expect(to.symbol).toBe("USDT0");
    expect(to.decimals).toBe(7);
    expect(from.id).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("quotes the request an app builds from those assets", async () => {
    const { from, to } = await mainnet.sendableAssets("arbitrum");
    const result = await mainnet.quote({
      from,
      to,
      sends: { asset: from, baseUnits: (25n * 10n ** BigInt(from.decimals)).toString() },
      destination: UNFUNDED,
      maxSlippageBps: 50,
    });
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.deliveredAtLeast.asset.id).toBe(to.id);
    expect(result.steps.some((s) => s.kind === "prepare-account")).toBe(true);
  });
});

describe("quoting a real pathway", () => {
  let ethereum: ResolvedRoute;

  beforeAll(async () => {
    ethereum = await discovery.routeFrom("ethereum");
    // Warms the adapter's own cache so the timing test below measures a quote
    // rather than a first-run discovery.
    await mainnet.quote(askFrom(ethereum));
  });

  it("prices a transfer into an account that does not exist yet", async () => {
    const result = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(result)) throw new Error(result.explanation);

    expect(result.source).toBe("layerzero");
    expect(result.destination).toBe(UNFUNDED);
    expect(result.toChain.id).toBe(STELLAR_SIDE.mainnet.chainId);
    // Six decimals in, seven out. 25 USDT must not become 2.5 or 250.
    expect(result.receives.asset.decimals).toBe(7);
    expect(BigInt(result.receives.baseUnits)).toBe(250_000_000n);
  });

  /**
   * Bounds rather than exact values: the fee is live gas on Ethereum and
   * asserting a number it happens to be today would fail for a reason nobody
   * can fix. What must hold is that it exists, is paid in the right currency,
   * and is not presented as though it came out of the amount.
   */
  it("charges a fee in the source chain's own gas token, said separately", async () => {
    const result = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(result)) throw new Error(result.explanation);

    const gas = result.fees.find((f) => f.kind === "gas");
    expect(gas).toBeDefined();
    expect(BigInt(gas?.total.baseUnits ?? "0")).toBeGreaterThan(0n);
    expect(gas?.total.asset.symbol).toBe("ETH");
    expect(gas?.total.asset.decimals).toBe(18);
    // Not skimmed from the amount. Saying it were would understate what leaves
    // the wallet.
    expect(gas?.includedInQuote).toBe(false);
  });

  it("charges the destination's reserve when the account has to be created", async () => {
    const result = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(result)) throw new Error(result.explanation);
    const reserve = result.fees.find((f) => f.kind === "account-reserve");
    expect(reserve).toBeDefined();
    expect(reserve?.total.asset.symbol).toBe("XLM");
    expect(result.steps.map((s) => s.kind)).toContain("prepare-account");
    expect(result.steps.map((s) => s.kind)).toContain("settle-account");
  });

  /**
   * Unlike a native mint, this rail's contract can take a fee between the quote
   * and the send, so the floor has to be a real promise rather than a copy of
   * the expected figure.
   */
  it("promises a floor drawn from the slippage the user chose", async () => {
    const result = await mainnet.quote(askFrom(ethereum, { maxSlippageBps: 50 }));
    if (!isRoute(result)) throw new Error(result.explanation);
    const floor = BigInt(result.receivesAtLeast.baseUnits);
    const expected = BigInt(result.receives.baseUnits);
    expect(floor).toBeLessThanOrEqual(expected);
    expect(floor).toBe((expected * 9950n) / 10_000n);
  });

  /**
   * The interface's own budget. The routing engine races every rail and drops
   * one that takes longer than this, so a quote that cannot meet it is a rail
   * that never appears.
   */
  it("answers inside the racing budget once its configuration is known", async () => {
    const started = Date.now();
    const result = await mainnet.quote(askFrom(ethereum));
    expect(Date.now() - started).toBeLessThan(ADAPTER_QUOTE_TIMEOUT_MS);
    expect(isRoute(result)).toBe(true);
  });

  it("tells the user how long it will take, worked out from the confirmations asked for", async () => {
    const result = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(result)) throw new Error(result.explanation);
    // 65 confirmations on Ethereum is not seconds and it is not hours. An
    // estimate outside this range means the block time or the confirmations
    // were read wrongly, which is worth catching.
    expect(result.estimatedSeconds).toBeGreaterThan(120);
    expect(result.estimatedSeconds).toBeLessThan(3600);
  });
});

describe("refusing, with a reason", () => {
  let ethereum: ResolvedRoute;

  beforeAll(async () => {
    ethereum = await discovery.routeFrom("ethereum");
  });

  it("declines a chain it does not route from, and names it", async () => {
    const request = askFrom(ethereum);
    const result = await mainnet.quote({
      ...request,
      from: { ...request.from, chainId: "fantom" },
    });
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("chain-unsupported");
    expect(result.explanation).toContain("fantom");
  });

  it("declines a token that is not the one the OFT moves", async () => {
    const request = askFrom(ethereum);
    const result = await mainnet.quote({
      ...request,
      from: { ...request.from, id: "0x0000000000000000000000000000000000000001" },
    });
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("asset-unsupported");
  });

  /**
   * The user says what they want to receive, and it is checked against what the
   * pathway actually credits by deriving the Stellar contract id from the asset
   * itself. A matching code alone must never be enough.
   */
  it("declines a Stellar asset with the right code and the wrong issuer", async () => {
    const request = askFrom(ethereum);
    const result = await mainnet.quote({
      ...request,
      to: {
        ...request.to,
        id: "USDT0:GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      },
    });
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("asset-unsupported");
  });

  it("declines a signer key rather than quoting into a hole", async () => {
    const result = await mainnet.quote(
      askFrom(ethereum, {
        destination: "SAV76USXIJOBMEQXPANUOQM6F5LIOTLPDIDVRJBFFE2MDJXG24TAPUU7",
      }),
    );
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
  });

  /**
   * A muxed address is the one form this rail genuinely cannot carry, and it is
   * refused at quote time rather than discovered at signing time.
   */
  it("declines a muxed address, because 40 bytes do not fit in 32", async () => {
    const result = await mainnet.quote(
      askFrom(ethereum, {
        destination: "MAAAAAAAAAAAJURAAB2X52XFQP6FBXLGT6LWOOWMEXWHEWBDVRZ7V5WH34Y22MPFBHUHY",
      }),
    );
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
    expect(result.explanation).toContain("muxed");
  });
});

describe("building the transactions", () => {
  it("asks for an approval and then a send where the contract locks tokens", async () => {
    const ethereum = await discovery.routeFrom("ethereum");
    const quoted = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(quoted)) throw new Error(quoted.explanation);

    const transactions = await mainnet.buildTransactions(quoted);
    // a reset that clears an earlier smaller allowance, which USDT needs, then the approval
    expect(transactions).toHaveLength(3);

    const [reset, approval, send] = transactions;
    expect(JSON.parse(reset?.payload ?? "{}")).toMatchObject({
      functionName: "approve",
      args: [ethereum.oft, "0"],
    });
    expect(reset?.unnecessaryWhen?.skipAlsoWhenExactly).toBe("0");
    expect(approval?.format).toBe("evm-tx");
    const approvalPayload = JSON.parse(approval?.payload ?? "{}") as {
      functionName: string;
      to: string;
      args: string[];
    };
    expect(approvalPayload.functionName).toBe("approve");
    // The allowance is granted on the token, to the OFT, and for this transfer
    // only. Never unlimited.
    expect(approvalPayload.to.toLowerCase()).toBe(ethereum.token.toLowerCase());
    expect(approvalPayload.args[0]?.toLowerCase()).toBe(ethereum.oft.toLowerCase());
    expect(approvalPayload.args[1]).toBe(quoted.sends.baseUnits);

    // Stated so a caller with an allowance already in place can skip it rather
    // than burning the user's gas to approve what is approved.
    expect(approval?.unnecessaryWhen?.kind).toBe("erc20-allowance");
    expect(approval?.unnecessaryWhen?.token.toLowerCase()).toBe(ethereum.token.toLowerCase());
    expect(approval?.unnecessaryWhen?.spender.toLowerCase()).toBe(ethereum.oft.toLowerCase());
    expect(approval?.unnecessaryWhen?.atLeastBaseUnits).toBe(quoted.sends.baseUnits);

    const sendPayload = JSON.parse(send?.payload ?? "{}") as {
      functionName: string;
      value: string;
      args: [{ dstEid: number; to: string; minAmountLD: string }];
    };
    expect(sendPayload.functionName).toBe("send");
    // `send` is payable and the LayerZero fee rides on the call. A caller who
    // ignored this would have the transaction revert having spent gas.
    expect(BigInt(sendPayload.value)).toBeGreaterThan(0n);
    expect(sendPayload.args[0].dstEid).toBe(STELLAR_SIDE.mainnet.eid);
    expect(BigInt(sendPayload.args[0].minAmountLD)).toBeGreaterThan(0n);
    // Consent needs understanding, so the sentence carries the trust model too.
    expect(send?.describes).toContain(quoted.destination);
    expect(send?.describes).toContain("must agree");
  });

  it("asks for only a send where the contract mints and burns", async () => {
    const arbitrum = await discovery.routeFrom("arbitrum");
    const quoted = await mainnet.quote(askFrom(arbitrum));
    if (!isRoute(quoted)) throw new Error(quoted.explanation);

    const transactions = await mainnet.buildTransactions(quoted);
    // One, not two. There is no allowance to grant when the contract destroys
    // the sender's own balance, and asking for one would cost gas for nothing.
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.unnecessaryWhen).toBeUndefined();
    expect(quoted.steps.map((s) => s.kind)).not.toContain("approve-source");
  });

  it("warns about the approval upfront rather than springing it on the user", async () => {
    const ethereum = await discovery.routeFrom("ethereum");
    const quoted = await mainnet.quote(askFrom(ethereum));
    if (!isRoute(quoted)) throw new Error(quoted.explanation);
    expect(quoted.steps.map((s) => s.kind)).toContain("approve-source");
    const transactions = await mainnet.buildTransactions(quoted);
    const signatures =
      transactions.length + quoted.steps.filter((s) => s.kind.includes("account")).length;
    expect(quoted.signaturesRequired).toBeLessThanOrEqual(signatures);
  });
});

describe("status, read from LayerZero's own indexer", () => {
  it("reports nothing at all for a transfer that was never submitted", async () => {
    const phase = await mainnet.status({
      sourceTxHash: undefined,
      depositAddress: undefined,
      destinationAddress: UNFUNDED,
      sourceChainId: undefined,
    });
    expect(phase.phase).toBe("idle");
  });

  /**
   * An unindexed hash is not a failed transfer. Reporting one as failed is how
   * somebody is talked into sending a second payment, so this pins the
   * behaviour rather than leaving it to chance.
   */
  it("calls an unknown hash pending rather than failed", async () => {
    const phase = await mainnet.status({
      sourceTxHash: `0x${"ab".repeat(32)}`,
      depositAddress: undefined,
      destinationAddress: UNFUNDED,
      sourceChainId: "ethereum",
    });
    expect(phase.phase).toBe("pending");
  });

  it("reports a real Polygon to Stellar USDT0 transfer as delivered, with its amount", async () => {
    const phase = await mainnet.status({
      sourceTxHash: "0x7f531e1dfe096968f03551411c717f698d98576c7f42829a0e600e8d7016131f",
      depositAddress: undefined,
      destinationAddress: UNFUNDED,
      sourceChainId: undefined,
    });
    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    // one USDT0, seven decimals on Stellar
    expect(phase.received.baseUnits).toBe("10000000");
    expect(phase.received.asset.symbol).toBe("USDT0");
    expect(phase.ref.txHash).toBe(
      "ace3893f10405ef834b1408e778223985f17ed7b03c2641f901d92f01a41e340",
    );
  }, 30_000);

  it("does not answer for a USDT0 transfer from Polygon to Ethereum", async () => {
    const phase = await mainnet.status({
      sourceTxHash: "0xa9658a797e99f86d8b5d1080184042301badc53e1a7e308bdee9510f62f3f0e0",
      depositAddress: undefined,
      destinationAddress: UNFUNDED,
      sourceChainId: undefined,
    });
    expect(phase).toEqual({ phase: "idle" });
  }, 30_000);
});

/**
 * Testnet, reported as it actually is.
 *
 * The pathway exists at the protocol level and has carried real transfers:
 * Ethereum Sepolia, Arbitrum Sepolia and BNB Smart Chain testnet all have the
 * Stellar pathway configured on their endpoints, and LayerZero's indexer records
 * delivered OFT transfers on it through July 2026. What does not exist is a
 * token anyone can obtain. LayerZero publishes no OFT registry for any testnet,
 * and every OFT peered to Stellar testnet is a private deployment.
 *
 * So these tests assert the honest state rather than pretending at a route.
 */
describe("testnet, where the pathway exists and the token does not", () => {
  it("offers the three chains whose endpoints carry the Stellar pathway", async () => {
    const chains = await testnet.supportedChains();
    expect(chains).toContain("ethereum-sepolia");
    expect(chains).toContain("arbitrum-sepolia");
    expect(chains).toContain("bsc-testnet");
  });

  it("declines, and explains that the missing piece is a token and not a pathway", async () => {
    const from: Asset = {
      chainId: "ethereum-sepolia",
      id: "0xE1ed976146aA14126cF86df1F7c041D78F74159F",
      symbol: "savETH",
      decimals: 18,
      curatedBy: undefined,
    };
    const result = await testnet.quote({
      from,
      to: {
        chainId: "stellar-testnet",
        id: "savETH:GCE43LBAIMFCYZEOSGANDVL2UAXGFRORHVG6EO3BBPO6NVATAB6YVVRK",
        symbol: "savETH",
        decimals: 7,
        curatedBy: undefined,
      },
      sends: { asset: from, baseUnits: "1000000000000000" },
      destination: UNFUNDED,
      maxSlippageBps: 50,
    });

    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    // Written for whoever reads it on screen. The reason it happens belongs in a
    // comment; what a person needs is that this is not their input being wrong
    // and that another route may work.
    expect(result.explanation).toContain("carries no token on the test network");
    expect(result.explanation).toContain("Another route may work here");
    // And no jargon leaks into a consumer surface.
    for (const word of ["OFT", "registry", "DVN", "endpoint", "`"]) {
      expect(result.explanation).not.toContain(word);
    }
  });

  /**
   * The regression this rail most needs, run against a real deployment.
   *
   * savETH is an OFT genuinely peered to Stellar testnet and it has carried
   * delivered transfers in both directions. It also fails two of this package's
   * gates, which is why it makes such a good test: its Stellar side is
   * registered on the endpoint LayerZero deployed in April and stopped
   * advertising in August, and it set no DVN configuration of its own.
   *
   * Either refusal is correct and the order between them is not the point. What
   * must never happen is a route resolving with a peer on a superseded
   * endpoint, because that is a transfer that vanishes with no error.
   */
  it("refuses a real OFT that fails a safety gate, and never resolves one that does", async () => {
    const named = new Discovery({
      network: "testnet",
      rpc: testnetRpc,
      ofts: [
        {
          chainId: "ethereum-sepolia",
          address: "0x925a1f6c01beb2870960a2b7c6f030271a7bb0e3",
          symbol: "savETH",
        },
      ],
    });

    const current = await named.stellar();
    let resolved: ResolvedRoute | undefined;
    let refusal: unknown;
    try {
      resolved = await named.routeFrom("ethereum-sepolia");
    } catch (cause) {
      refusal = cause;
    }

    if (resolved !== undefined) {
      // Should it ever be rewired, it must be rewired to the current endpoint.
      expect(resolved.stellar.endpoint).toBe(current.endpoint);
      return;
    }

    const message = String((refusal as Error).message);
    expect(message).toContain("0x925a1f6c01beb2870960a2b7c6f030271a7bb0e3");
    expect(message).toMatch(/verifier set nobody chose|registered on endpoint/);
  });

  /**
   * The endpoint check on its own, against the contract that fails it.
   *
   * Asserted separately from the refusal above so it cannot be masked by
   * whichever gate happens to run first. This reads the Stellar contract savETH
   * points at and shows it is registered somewhere LayerZero no longer names.
   */
  it("sees that a live Stellar OFT is on an endpoint the registry has moved off", async () => {
    const testnetDiscovery = new Discovery({ network: "testnet", rpc: testnetRpc });
    const current = await testnetDiscovery.stellar();
    expect(current.eid).toBe(STELLAR_SIDE.testnet.eid);

    const peer = await readStellarOft(
      testnetRpc,
      "CAEDHIBRKOEPXSPQF4P6QWO6GTQHJM5T4RB2IBGOEP7VVQJJA3AX5XCY",
    );
    expect(peer.endpoint).toMatch(/^C[A-Z2-7]{55}$/);
    expect(peer.token).toMatch(/^C[A-Z2-7]{55}$/);
    // Both contracts are real and both are live. They are not the same one, and
    // that is the entire hazard this package refuses to walk into.
    expect(peer.endpoint).not.toBe(current.endpoint);
  });
});

describe("the Arrival Contract recorded for testnet", () => {
  it("is the one deployed there, with the same lists", async () => {
    const recorded = ARRIVAL_CONTRACTS.testnet;
    if (recorded === undefined) throw new Error("no testnet Arrival Contract is recorded");
    const stored = await readArrivalConfig(
      new RpcClient({ url: PUBLIC_TESTNET_RPC_URL }),
      recorded.contract,
    );
    const { contract: _contract, wasmSha256: _hash, ...lists } = recorded;
    expect(stored).toEqual(lists);
  }, 60_000);
});
