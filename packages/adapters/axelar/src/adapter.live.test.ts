import {
  type Asset,
  MavnaError,
  type QuoteRequest,
  type Route,
  type RouteRejection,
  type StepPhase,
} from "@mavna/core";
import {
  createNetworkConfig,
  PUBLIC_MAINNET_RPC_URLS,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
} from "@mavna/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AxelarAdapter } from "./adapter.js";
import { chainConfig, evmTokenService, loadChains } from "./deployments.js";
import { discoverLiveChains, discoverStellarChain } from "./discovery.js";
import { EvmReader, fetchEthChainId } from "./evm.js";
import { estimateItsFee, priceTransfer } from "./fees.js";
import { PINNED_DEPLOYMENTS } from "./pinned.js";
import { StellarItsReader } from "./stellar-its.js";
import { readHorizonExecution } from "./stellar-receipt.js";
import { chainsTrustEachOther, resolveItsToken, TOKEN_MANAGER } from "./token.js";

/**
 * The adapter, against the real Axelar.
 *
 * Nothing here is worth faking. Every identifier this adapter uses is discovered
 * at runtime precisely because the ones written down went stale, so a recorded
 * response would test the recording rather than Axelar. These tests are the only
 * thing that notices when a chain is redeployed, a token is unlinked, or a four
 * byte selector stops matching the contract it was computed against.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const rpc = new RpcClient({ url: network.rpcUrl });
const adapter = new AxelarAdapter({
  network: "testnet",
  rpc,
  baseReserveStroops: network.baseReserveStroops,
});

/**
 * The one pair that actually moves on testnet today.
 *
 * IXE is registered on base-sepolia and on Stellar, and transfers between them
 * have completed. Neither Axelar's own token list nor the specification mentions
 * it, which is exactly why this adapter asks the contracts rather than a list.
 */
const IXE_BASE_SEPOLIA = "0xA813265d59c9bC06e439E61fA133B5f23134b2Ce";
/** Registered on hyperliquid for Stellar, and the token the specification names. */
const AXE_HYPERLIQUID = "0x671CD182bb1f4f6c7cfcf47D6c6BeDdda1BB1130";

const STELLAR_ACCOUNT = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
/** A custodial address form. Valid on Stellar, refused by Axelar's own encoder. */
const MUXED = "MCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIUAAAAAAAAAAAAHCXE";

const ixe: Asset = {
  chainId: "base-sepolia",
  id: IXE_BASE_SEPOLIA,
  symbol: "IXE",
  decimals: 7,
  curatedBy: "Axelar",
};

const stellarIxe: Asset = {
  chainId: "stellar-testnet",
  id: "CCYDJCO2DQV3YWQJHKZCOKWXWH46KRBJAJLLI7SGRMBYSY65Q2MIASCI",
  symbol: "IXE",
  decimals: 7,
  curatedBy: "Axelar",
};

const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: ixe,
  to: stellarIxe,
  sends: { asset: ixe, baseUnits: "10000000" },
  destination: STELLAR_ACCOUNT,
  maxSlippageBps: 50,
  ...over,
});

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

async function testnetReaders() {
  const stellarChain = await discoverStellarChain("testnet");
  const stellarConfig = await chainConfig("testnet", stellarChain.id);
  const service = stellarConfig.interchainTokenService;
  if (service === undefined) throw new Error("Stellar has no token service in Axelar's config");
  return {
    stellarChain,
    stellar: new StellarItsReader(rpc, service, "testnet"),
  };
}

describe("the identifiers, none of which are written down", () => {
  it("finds the Stellar chain under whatever version it is on now", async () => {
    const chain = await discoverStellarChain("testnet");
    expect(chain.id).toMatch(/^stellar/);
    // Versioned on testnet. If this ever equals the bare name, something changed.
    expect(chain.gateway).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("lists chains to send from, and leaves out the ones Axelar retired", async () => {
    const chains = await adapter.supportedChains();
    expect(chains.length).toBeGreaterThan(5);
    expect(chains).toContain("base-sepolia");
    expect(chains).toContain("ethereum-sepolia");

    // Axelar keeps retired chains listed with a flag rather than removing them.
    // Offering one is offering a route nobody is relaying.
    const live = await discoverLiveChains("testnet");
    for (const id of chains) expect(live).toContain(id);
  });

  it("leaves out chains that are running but have no token service", async () => {
    const chains = await adapter.supportedChains();
    const deployed = await loadChains("testnet");
    for (const id of chains) {
      expect(deployed.get(id)?.interchainTokenService).toBeDefined();
    }
    // Published and running, but with no token service deployed on it.
    expect(chains).not.toContain("centrifuge-2");
  });

  it("does NOT assume one deterministic token service address", async () => {
    const chains = await loadChains("testnet");
    const addresses = new Set(
      [...chains.values()]
        .filter((c) => c.family === "evm" && c.interchainTokenService !== undefined)
        .map((c) => c.interchainTokenService),
    );
    // More than one, so reading it per chain is not defensive programming, it is
    // the only thing that works.
    expect(addresses.size).toBeGreaterThan(1);
  });
});

describe("the four bytes that would silently call the wrong function", () => {
  it("every selector is present in the deployed token service", async () => {
    const source = await evmTokenService("testnet", "hyperliquid");
    const response = await fetch(source.rpcUrls[0] ?? "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [source.address, "latest"],
      }),
    });
    const proxy = ((await response.json()) as { result: string }).result;
    expect(proxy.length).toBeGreaterThan(2);

    // The token service reads through a proxy, so the trust and token getters
    // are checked by calling them rather than by grepping the proxy's bytecode.
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    const { stellarChain } = await testnetReaders();
    await expect(evm.trustsChain(source.address, stellarChain.id)).resolves.toBe(true);
  });

  it("reads a token id back as the value the token itself reports", async () => {
    const source = await evmTokenService("testnet", "hyperliquid");
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    const tokenId = await evm.interchainTokenId(AXE_HYPERLIQUID);
    // The identifier the specification records for Stellar's AXE, arrived at
    // from the other end of the route.
    expect(tokenId).toBe("0x1600ee6a7b3810f8a277226b0f3a54cc9f92eb2e0456fc64578a78762ab7f838");
    await expect(evm.registeredTokenAddress(source.address, tokenId)).resolves.toBe(
      AXE_HYPERLIQUID.toLowerCase(),
    );
  });
});

describe("the trust check, which two token service versions answer differently", () => {
  it("gets a real answer from a 2.1.x chain, which has no isTrustedChain at all", async () => {
    const source = await evmTokenService("testnet", "base-sepolia");
    const { stellarChain } = await testnetReaders();
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    // 2.1.x reverts on isTrustedChain and answers trustedAddress with "hub".
    // Reading only the first would decline every route on most of mainnet.
    await expect(evm.trustsChain(source.address, stellarChain.id)).resolves.toBe(true);
  });

  it("gets a real answer from a 2.2.0 chain, which has no useful trustedAddress", async () => {
    const source = await evmTokenService("testnet", "hyperliquid");
    const { stellarChain } = await testnetReaders();
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    await expect(evm.trustsChain(source.address, stellarChain.id)).resolves.toBe(true);
  });

  it("says no to a name that does not exist, rather than erroring", async () => {
    const source = await evmTokenService("testnet", "base-sepolia");
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    await expect(evm.trustsChain(source.address, "not-a-real-chain")).resolves.toBe(false);
  });

  it("catches the unversioned Stellar name, which looks right and is not", async () => {
    const source = await evmTokenService("testnet", "hyperliquid");
    const evm = new EvmReader(source.rpcUrls, undefined, {
      expectedChainId: source.chain.evmChainId,
    });
    // "stellar" is the MAINNET name. On testnet it is a confident no.
    await expect(evm.trustsChain(source.address, "stellar")).resolves.toBe(false);
  });

  it("requires both sides to agree, not just the sending chain", async () => {
    const source = await evmTokenService("testnet", "base-sepolia");
    const { stellarChain, stellar } = await testnetReaders();
    await expect(
      chainsTrustEachOther({
        evm: new EvmReader(source.rpcUrls, undefined, { expectedChainId: source.chain.evmChainId }),
        stellar,
        tokenService: source.address,
        sourceAxelarId: "base-sepolia",
        stellarAxelarId: stellarChain.id,
      }),
    ).resolves.toBe(true);

    // Stellar has never heard of this one, so the pair fails even though the
    // sending chain is perfectly happy.
    await expect(stellar.trustsChain("not-a-real-chain")).resolves.toBe(false);
  });
});

describe("resolving a token against both chains", () => {
  it("resolves the pair that actually moves on testnet", async () => {
    const source = await evmTokenService("testnet", "base-sepolia");
    const { stellar } = await testnetReaders();

    const token = await resolveItsToken({
      network: "testnet",
      sourceChainId: "base-sepolia",
      tokenService: source.address,
      tokenAddress: IXE_BASE_SEPOLIA,
      evm: new EvmReader(source.rpcUrls, undefined, { expectedChainId: source.chain.evmChainId }),
      stellar,
    });

    expect(token.tokenId).toBe(
      "0x0a01e213cdbae54f1191c7149ca2333d5fe7ac2658eac1f56e6b331a197dec48",
    );
    expect(token.stellarToken).toBe("CCYDJCO2DQV3YWQJHKZCOKWXWH46KRBJAJLLI7SGRMBYSY65Q2MIASCI");
    // Deployed by the service itself, so it burns through a minter role and
    // there is no allowance anywhere in the path.
    expect(token.tokenManagerType).toBe(TOKEN_MANAGER.nativeInterchainToken);
    expect(token.approvalSpender).toBeUndefined();
  });

  it("resolves the token the specification names, from the chain it lives on", async () => {
    const source = await evmTokenService("testnet", "hyperliquid");
    const { stellar } = await testnetReaders();

    const token = await resolveItsToken({
      network: "testnet",
      sourceChainId: "hyperliquid",
      tokenService: source.address,
      tokenAddress: AXE_HYPERLIQUID,
      evm: new EvmReader(source.rpcUrls, undefined, { expectedChainId: source.chain.evmChainId }),
      stellar,
    });

    expect(token.tokenId).toBe(
      "0x1600ee6a7b3810f8a277226b0f3a54cc9f92eb2e0456fc64578a78762ab7f838",
    );
    // The address the specification records for Stellar's AXE, confirmed by
    // asking Stellar rather than by reading it back out of a document.
    expect(token.stellarToken).toBe("CD4E76AHF7UUBDMEUXCUXGRZENJMSKSFDCIVMBLJMQNJFCT3NQF4X4JT");
  });

  it("refuses a token that is not set up for this route", async () => {
    const source = await evmTokenService("testnet", "base-sepolia");
    const { stellar } = await testnetReaders();
    await expect(
      resolveItsToken({
        network: "testnet",
        sourceChainId: "base-sepolia",
        tokenService: source.address,
        // A real ERC-20 on base-sepolia that was never linked: Circle's USDC.
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        evm: new EvmReader(source.rpcUrls, undefined, { expectedChainId: source.chain.evmChainId }),
        stellar,
      }),
    ).rejects.toThrow();
  });
});

describe("quoting", () => {
  it("prices the route that works, and prices delivery above zero", async () => {
    const result = await adapter.quote(ask());
    expect(isRoute(result)).toBe(true);
    if (!isRoute(result)) return;

    expect(result.source).toBe("axelar");
    expect(result.trustModel).toBe("validator-set");
    expect(result.fromChain.id).toBe("base-sepolia");
    expect(result.destination).toBe(STELLAR_ACCOUNT);

    // Same decimals on both sides for this token, so nothing is lost.
    expect(result.receives.baseUnits).toBe("10000000");
    expect(result.receivesAtLeast.baseUnits).toBe(result.receives.baseUnits);

    const gas = result.fees.find((fee) => fee.kind === "gas");
    expect(gas).toBeDefined();
    // A zero here means Axelar did not recognise the chain, not that it is free.
    expect(BigInt(gas?.total.baseUnits ?? "0")).toBeGreaterThan(0n);
    // Paid alongside the transfer in the sending chain's own currency, not taken
    // out of what arrives.
    expect(gas?.includedInQuote).toBe(false);

    // One signature, because this token needs no approval.
    expect(result.signaturesRequired).toBe(1);

    // IXE lands as Axelar's own Soroban token, read off the ledger as a Wasm
    // contract, so it is named by its contract id and needs no trustline.
    expect(result.deliveredAtLeast.asset.id).toBe(stellarIxe.id);
    expect(result.steps.map((step) => step.kind)).toEqual(["bridge"]);
  });

  it("declines an account that does not exist for a token that lands as a contract", async () => {
    // A fresh key, so the account is certainly not on the ledger.
    const result = await adapter.quote(ask({ destination: Keypair.random().publicKey() }));
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
  });

  it("declines a token that cannot reach Stellar, in words with no jargon in them", async () => {
    const usdc: Asset = {
      chainId: "base-sepolia",
      id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      symbol: "USDC",
      decimals: 6,
      curatedBy: "Circle",
    };
    const result = await adapter.quote(
      ask({ from: usdc, sends: { asset: usdc, baseUnits: "1000000" } }),
    );

    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("asset-unsupported");

    // A user reads this. It must say what happened without naming a protocol,
    // an acronym or a contract.
    const words = result.explanation.toLowerCase();
    for (const jargon of [
      "its",
      "token manager",
      "interchain token service",
      "tokenid",
      "erc-20",
      "erc20",
      "gmp",
      "axelar",
      "contract",
      "revert",
    ]) {
      expect(words).not.toContain(jargon);
    }
    expect(result.explanation).toMatch(/^[A-Z]/);
  });

  it("declines a chain Axelar does not run", async () => {
    const result = await adapter.quote(ask({ from: { ...ixe, chainId: "not-a-real-chain" } }));
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("chain-unsupported");
  });

  it("declines anywhere that is not Stellar", async () => {
    const result = await adapter.quote(ask({ to: { ...stellarIxe, chainId: "ethereum" } }));
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("chain-unsupported");
  });

  it("declines a custodial address, which Axelar's own encoder will not accept", async () => {
    const result = await adapter.quote(ask({ destination: MUXED }));
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
    // Offers the way forward rather than only refusing.
    expect(result.explanation).toMatch(/plain account address/);
  });

  it("declines a destination that cannot receive at all", async () => {
    const result = await adapter.quote({ ...ask(), destination: "not-an-address" });
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
  });
});

describe("building the transactions", () => {
  it("pays for delivery inline, with a value that is never zero", async () => {
    const quote = await adapter.quote(ask());
    expect(isRoute(quote)).toBe(true);
    if (!isRoute(quote)) return;

    const transactions = await adapter.buildTransactions(quote);
    // This token needs no approval, so there is one transaction and one only.
    expect(transactions).toHaveLength(1);

    const transfer = transactions[0];
    expect(transfer?.format).toBe("evm-tx");
    expect(transfer?.chainId).toBe("base-sepolia");
    expect(transfer?.unnecessaryWhen).toBeUndefined();

    const payload = JSON.parse(transfer?.payload ?? "{}") as {
      to: string;
      functionName: string;
      args: string[];
      value: string;
    };
    expect(payload.functionName).toBe("interchainTransfer");
    // The six-argument form, which is the only one deployed on 2.1.1 chains.
    expect(payload.args).toHaveLength(6);
    // The delivery payment, present and positive. Without it the message is
    // still emitted and the transfer strands.
    expect(BigInt(payload.value)).toBeGreaterThan(0n);
    // And it equals the gas value argument exactly.
    expect(payload.args[5]).toBe(payload.value);

    // The Stellar address travels as its own letters.
    expect(Buffer.from((payload.args[2] ?? "").slice(2), "hex").toString("ascii")).toBe(
      STELLAR_ACCOUNT,
    );
  });

  it("refuses to build when the destination is one Axelar cannot encode", async () => {
    const quote = await adapter.quote(ask());
    if (!isRoute(quote)) return;
    await expect(adapter.buildTransactions({ ...quote, destination: MUXED })).rejects.toThrow(
      /muxed/,
    );
  });
});

describe("pricing, and the zero that means something else", () => {
  it("prices the transfer above zero for a chain it knows", async () => {
    const { stellarChain } = await testnetReaders();
    const fee = await priceTransfer("testnet", "base-sepolia", stellarChain.id, "ETH");
    expect(BigInt(fee.baseUnits)).toBeGreaterThan(0n);
    expect(fee.pricedIn).toEqual({ symbol: "ETH", decimals: 18 });
  });

  it("prices in the sending chain's own currency, at a size that pays for gas there", async () => {
    // The fee is sent as wei. Priced in XLM it came back in stroops, around a
    // million, which is less than one unit of gas on base-sepolia. A plain value
    // transfer there costs 21000 gas, so any real delivery payment exceeds that.
    const { stellarChain } = await testnetReaders();
    const base = await chainConfig("testnet", "base-sepolia");
    const symbol = base.nativeCurrency?.symbol;
    expect(symbol).toBe("ETH");
    const response = await fetch(base.rpcUrls[0] ?? "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const gasPrice = BigInt(((await response.json()) as { result: string }).result);
    const fee = await priceTransfer("testnet", "base-sepolia", stellarChain.id, symbol ?? "");
    expect(BigInt(fee.baseUnits)).toBeGreaterThan(21_000n * gasPrice);
  });

  it("fails closed on a chain name it does not know, rather than quoting free", async () => {
    // "stellar" is the MAINNET name and does not exist on testnet. Paying for a
    // name nobody recognises strands the message with no automatic recovery.
    await expect(priceTransfer("testnet", "base-sepolia", "stellar", "ETH")).rejects.toThrow();
    await expect(
      priceTransfer("testnet", "base-sepolia", "made-up-chain", "ETH"),
    ).rejects.toThrow();
  });

  it("shows WHY the transfer estimator alone cannot be trusted to catch that", async () => {
    // It answers an unrecognised destination with a plausible non-zero number
    // rather than the zero the mandatory assertion looks for. So the name is
    // checked with the estimator that does return zero, and this one only says
    // how much to pay. Left as a test because if Axelar ever fixes it, the
    // reason for the two-call arrangement has gone and someone should know.
    const bogus = await estimateItsFee("testnet", "base-sepolia", "made-up-chain", "ETH");
    expect(BigInt(bogus)).toBeGreaterThan(0n);
  });

  it("pays the two-message price, not the one-message one", async () => {
    // A transfer is two messages because it routes through a hub. Pricing it as
    // one underpays, and underpaying is what strands transfers on this rail.
    const { estimateGasFee } = await import("./fees.js");
    const { stellarChain } = await testnetReaders();
    const [single, paid] = await Promise.all([
      estimateGasFee("testnet", "base-sepolia", stellarChain.id, "ETH"),
      priceTransfer("testnet", "base-sepolia", stellarChain.id, "ETH"),
    ]);
    expect(BigInt(paid.baseUnits)).toBeGreaterThan(BigInt(single.totalFee));
  });
});

describe("status, across both legs", () => {
  /** A transfer that completed, base-sepolia to Stellar, IXE. */
  const DELIVERED = "0x6d2b4dd58e2501708cd6bd73ca578097cec519fe634bc9fbadf6e86e9b05ca7f";

  it("reports a finished transfer as done, having checked the second leg too", async () => {
    const phase = await doneOrUnverified(() =>
      adapter.status({
        sourceTxHash: DELIVERED,
        sourceChainId: "base-sepolia",
        depositAddress: undefined,
        destinationAddress: undefined,
      }),
    );
    if (phase === "unverified") return;
    expect(phase.received.baseUnits).toBe("10000000000");
    expect(phase.received.asset.symbol).toBe("IXE");
    // Axelar's own explorer, because it is the only view showing both legs.
    expect(phase.ref.explorerUrl).toContain("axelarscan.io/gmp/");
  });

  it("says idle when there is nothing to look up", async () => {
    const phase = await adapter.status({
      sourceTxHash: undefined,
      sourceChainId: undefined,
      depositAddress: undefined,
      destinationAddress: undefined,
    });
    expect(phase.phase).toBe("idle");
  });

  it("says pending, not failed, for a hash Axelar has never seen", async () => {
    // Reporting failure without evidence is how somebody is talked into paying
    // a second time.
    const phase = await adapter.status({
      sourceTxHash: `0x${"ab".repeat(32)}`,
      sourceChainId: "base-sepolia",
      depositAddress: undefined,
      destinationAddress: undefined,
    });
    expect(phase.phase).toBe("pending");
  });
});

describe("recovery", () => {
  it("refuses to add gas to a transfer that was paid enough", async () => {
    await expect(
      adapter.recover({
        sourceTxHash: "0x6d2b4dd58e2501708cd6bd73ca578097cec519fe634bc9fbadf6e86e9b05ca7f",
        sourceChainId: "base-sepolia",
        depositAddress: undefined,
        destinationAddress: undefined,
      }),
    ).rejects.toThrow(/not underpaid/);
  });

  it("refuses when Axelar has no record to add gas against", async () => {
    await expect(
      adapter.recover({
        sourceTxHash: `0x${"ab".repeat(32)}`,
        sourceChainId: "base-sepolia",
        depositAddress: undefined,
        destinationAddress: undefined,
      }),
    ).rejects.toThrow(/no record/);
  });
});

describe("mainnet, where the assets people actually hold are", () => {
  const mainnetRpc = new RpcClient({ url: PUBLIC_MAINNET_RPC_URLS[0] ?? "" });

  it("needs an approval for a token the service has to pull, naming the service", async () => {
    const source = await evmTokenService("mainnet", "ethereum");
    const stellarChain = await discoverStellarChain("mainnet");
    const stellarConfig = await chainConfig("mainnet", stellarChain.id);
    const service = stellarConfig.interchainTokenService;
    if (service === undefined) throw new Error("no Stellar token service on mainnet");

    const token = await resolveItsToken({
      network: "mainnet",
      sourceChainId: "ethereum",
      tokenService: source.address,
      // Real USDC. A plain ERC-20 that has no idea it is an interchain token, so
      // its identifier can only come from Axelar's published list.
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      evm: new EvmReader(source.rpcUrls, undefined, { expectedChainId: source.chain.evmChainId }),
      stellar: new StellarItsReader(mainnetRpc, service, "mainnet"),
    });

    expect(token.tokenManagerType).toBe(TOKEN_MANAGER.lockUnlock);
    // The service, not the token manager. The tokens land in the manager but the
    // transfer runs as the service, so the allowance is read against it.
    expect(token.approvalSpender).toBe(source.address);
    expect(token.approvalSpender).not.toBe(token.tokenManager);
    expect(token.stellarToken).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("finds the Stellar chain under its unversioned mainnet name", async () => {
    const chain = await discoverStellarChain("mainnet");
    expect(chain.id).toBe("stellar");
  });

  it("asks the contracts by the name the CONTRACTS use, not the one the APIs use", async () => {
    const chains = await loadChains("mainnet");
    const ethereum = chains.get("ethereum");
    // The two names differ here, and this is the whole reason both are carried.
    expect(ethereum?.id).toBe("ethereum");
    expect(ethereum?.axelarId).toBe("Ethereum");

    const stellarChain = await discoverStellarChain("mainnet");
    const stellarConfig = await chainConfig("mainnet", stellarChain.id);
    const service = stellarConfig.interchainTokenService;
    if (service === undefined) throw new Error("no Stellar token service on mainnet");
    const stellar = new StellarItsReader(mainnetRpc, service, "mainnet");

    // The failure this guards against, demonstrated rather than described: the
    // API name is not an error, it is a confident no. Using it would silently
    // decline the largest route this rail has.
    await expect(stellar.trustsChain(ethereum?.axelarId ?? "")).resolves.toBe(true);
    await expect(stellar.trustsChain(ethereum?.id ?? "")).resolves.toBe(false);
  });

  it("looks a chain up by either of its names", async () => {
    const byApiName = await chainConfig("mainnet", "ethereum");
    const byContractName = await chainConfig("mainnet", "Ethereum");
    expect(byContractName.id).toBe(byApiName.id);
  });
});

/**
 * Done, or, for a token that is its own contract once its delivery has aged out
 * of what public Stellar RPC keeps, the honest "executed, cannot re-verify"
 * answer. Never done without an amount, never another amount.
 */
async function doneOrUnverified(
  ask: () => Promise<StepPhase>,
): Promise<Extract<StepPhase, { phase: "done" }> | "unverified"> {
  // Axelar's search rate limits a burst with 429, which the adapter rightly
  // reports as a retry, so a retry is what this does before judging.
  let outcome: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    outcome = await ask().catch((cause: unknown) => cause);
    if (!(outcome instanceof MavnaError && outcome.retryable)) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (outcome instanceof Error) throw outcome;
  const phase = outcome as StepPhase;
  if (phase.phase === "delivered-unverified") {
    expect(phase.ref.explorerUrl).toContain(phase.ref.txHash);
    return "unverified";
  }
  expect(phase.phase).toBe("done");
  if (phase.phase !== "done") throw new Error(`expected done, got ${phase.phase}`);
  return phase;
}

describe("mainnet transfers whose Stellar-leg record misstates the amount", () => {
  // Read-only. Axelar's record for the WETH leg carries no amount, and for BCB
  // it says six decimals for a seven-decimal token. Both were delivered.
  const mainnet = new AxelarAdapter({
    network: "mainnet",
    rpc: new RpcClient({ url: PUBLIC_MAINNET_RPC_URLS[0] ?? "" }),
    baseReserveStroops: 5_000_000,
  });

  it("reads the WETH delivery from Stellar", async () => {
    const phase = await doneOrUnverified(() =>
      mainnet.status({
        sourceTxHash: "0xa41f1ccdbf2f5261e98007fb688338696d6bbfa62eacb55ef74d7dc2d5a96ffc",
        sourceChainId: "ethereum",
        depositAddress: undefined,
        destinationAddress: "GAY4QJXQ43JXXTUX3KKARXJS7ARPTK5KF5IK4R2B5CYKIEFY2Q4RCVNA",
      }),
    );
    if (phase === "unverified") return;
    expect(phase.received.baseUnits).toBe("149500000000000000");
    expect(phase.received.asset.id).toBe(
      "CDTRXQUOFLCNAEC7DBZT36MBVQ2EDUNUKT4GYOZHOMYOFR7QWTC5IIRV",
    );
    expect(phase.received.asset.decimals).toBe(18);
  });

  it("reads the BCB delivery from Stellar in the token's own seven decimals", async () => {
    const phase = await doneOrUnverified(() =>
      mainnet.status({
        sourceTxHash: "0x8d9e3dd8d6ebf65e91e951974d72339d0e4bcb901e60347db01b6713d9d43315",
        sourceChainId: "ethereum",
        depositAddress: undefined,
        destinationAddress: "GDKFBTJPAU74CNX64RTM47ESQR4QSYSXC2NMHB7BHQTSGLDZQTS6CAXL",
      }),
    );
    // a Stellar asset: done however old, from Horizon once RPC has dropped it
    if (phase === "unverified")
      throw new Error("a Stellar asset must be proven, not left unverified");
    expect(phase.received.baseUnits).toBe("30000000000");
    expect(phase.received.asset.id).toBe(
      "BCB:GD7P2H4MSVW3V6L34YFX7YZBIMWAOSSZVXELJANBPKMDRO34DYV37BCB",
    );
    expect(phase.received.asset.decimals).toBe(7);
  });
});

describe("the nodes the adapter reads each confirmed chain through", () => {
  it("never answer as another chain, and at least one answers as each chain", async () => {
    // a node that cannot be reached from here is allowed (the reader moves on);
    // one that answers as a different chain, or a chain with no node answering,
    // is not
    for (const network of ["testnet", "mainnet"] as const) {
      const chains = await loadChains(network);
      const wrong: string[] = [];
      for (const chain of chains.values()) {
        if (chain.family !== "evm" || chain.interchainTokenService === undefined) continue;
        let answered = false;
        for (const url of PINNED_DEPLOYMENTS[network][chain.id]?.rpcUrls ?? []) {
          const id = await fetchEthChainId(url).catch(() => undefined);
          if (id === undefined) continue;
          if (id === chain.evmChainId) answered = true;
          else wrong.push(`${network}/${chain.id} ${url} answers ${id}`);
        }
        if (!answered) wrong.push(`${network}/${chain.id}: no node answered`);
      }
      expect(wrong, wrong.join("\n")).toEqual([]);
    }
  });
});

describe("quoting from Base mainnet, whose config node does not resolve", () => {
  it("reads Base through its confirmed nodes and gives a real answer, not a retry", async () => {
    // RMRK is an interchain token on Base (Axelar's list, token id 0xb689de70...).
    // No token in that list is on both Base and Stellar, so the quote declines:
    // it has to read Base's token service through the node list to do so, and
    // Stellar's service also says false to is_trusted_chain("base"). Before the
    // node list it said "did not answer just now" every time, because
    // developer-access-mainnet.base.org has no address record.
    const mainnet = new AxelarAdapter({
      network: "mainnet",
      rpc: new RpcClient({ url: PUBLIC_MAINNET_RPC_URLS[0] ?? "" }),
      baseReserveStroops: 5_000_000,
    });
    const from: Asset = {
      chainId: "base",
      id: "0x524d524B4c9366be706D3A90dcf70076ca037aE3",
      symbol: "RMRK",
      decimals: 18,
      curatedBy: "Axelar",
    };
    const result = await mainnet.quote({
      from,
      to: {
        chainId: "stellar",
        id: "native",
        symbol: "XLM",
        decimals: 7,
        curatedBy: "Stellar",
      },
      sends: { asset: from, baseUnits: "1000000000000000000" },
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      maxSlippageBps: 50,
    });
    if (!("reason" in result)) throw new Error("expected a decline");
    expect(result.reason, result.explanation).not.toBe("temporarily-unavailable");
    expect(result.retryable).toBe(false);
  });
});

describe("Horizon's record of the two mainnet deliveries", () => {
  // Read-only, against horizon.stellar.org, which keeps every transaction.
  const ITS = "CBDBMIOFHGWUFRYH3D3STI2DHBOWGDDBCRKQEUB4RGQEBVG74SEED6C6";

  it("shows the BCB execution, its message and the asset paid to the recipient", async () => {
    const execution = await readHorizonExecution({
      horizonUrl: "https://horizon.stellar.org",
      txHash: "02a227c90a4e07f9b8e0b30e117f568120642bb813210af409c9f178cd273a77",
      tokenService: ITS,
      messageId: "0x9d3069da301b63f9a36def269200fa2e71e2b3fc0fc5ed69f1450ad90e6471ee-7510447",
    });
    expect(execution.tokenId).toBe(
      "950977f4434f471408edcad1a60e9d7fb392504dab2bc599edc7ad42a6a2ea1f",
    );
    expect(execution.recipient).toBe("GDKFBTJPAU74CNX64RTM47ESQR4QSYSXC2NMHB7BHQTSGLDZQTS6CAXL");
    expect(execution.amount).toBe(30_000_000_000n);
    expect(execution.balanceChanges).toContainEqual(
      expect.objectContaining({
        asset_code: "BCB",
        asset_issuer: "GD7P2H4MSVW3V6L34YFX7YZBIMWAOSSZVXELJANBPKMDRO34DYV37BCB",
        to: "GDKFBTJPAU74CNX64RTM47ESQR4QSYSXC2NMHB7BHQTSGLDZQTS6CAXL",
        amount: "3000.0000000",
      }),
    );
  });

  it("shows the WETH execution and its message, and no balance change to prove the amount", async () => {
    const execution = await readHorizonExecution({
      horizonUrl: "https://horizon.stellar.org",
      txHash: "25013b849de4e95bd8b351eebd61babc3374da8797d9d0d23212f65e82914ee6",
      tokenService: ITS,
      messageId: "0x2d41427908386c3f8df9caa949796cfa921edd063c8dcbc020c4714b8a9b39c9-7519579",
    });
    expect(execution.amount).toBe(149_500_000_000_000_000n);
    expect(execution.balanceChanges).toEqual([]);
  });
});
