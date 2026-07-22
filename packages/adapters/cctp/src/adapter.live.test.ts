import type { Asset, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { CCTP_CONTRACTS } from "./config.js";

/**
 * The adapter, against the real network.
 *
 * Quoting reaches Circle for the fee and Stellar for the destination's state.
 * Neither is worth faking: the fee is the number the product's pricing rests on,
 * and the destination check is the most valuable read in the whole system. A
 * mocked version of either would pass while telling us nothing.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const rpc = new RpcClient({ url: network.rpcUrl });

const adapter = new CctpAdapter({
  network: "testnet",
  rpc,
  baseReserveStroops: network.baseReserveStroops,
});

const USDC_SEPOLIA: Asset = {
  chainId: "ethereum-sepolia",
  id: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  symbol: "USDC",
  decimals: 6,
  curatedBy: "Circle",
};

const USDC_STELLAR: Asset = {
  chainId: "stellar-testnet",
  id: `USDC:${CCTP_CONTRACTS.testnet.usdcIssuer}`,
  symbol: "USDC",
  decimals: 7,
  curatedBy: "Circle",
};

/** The account the earlier end-to-end transfer actually delivered into. */
const FUNDED = "GCKPC23TA3D6FCZDVMH5U4IPJFZEYUFBVASNLDMM3UEYHJGM3DAIVJSU";
/** Valid, well-formed, and has never existed. */
const UNFUNDED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: USDC_SEPOLIA,
  to: USDC_STELLAR,
  sends: { asset: USDC_SEPOLIA, baseUnits: "25000000" },
  destination: FUNDED,
  maxSlippageBps: 50,
  ...over,
});

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

describe("CctpAdapter", () => {
  it("quotes a real route into an account that already holds USDC", async () => {
    const result = await adapter.quote(ask());
    expect(isRoute(result)).toBe(true);
    if (!isRoute(result)) return;

    expect(result.trustModel).toBe("native-mint");
    expect(result.destination).toBe(FUNDED);
    // Six decimals in, seven out. 25 USDC must not become 2.5 or 250.
    expect(result.receives.asset.decimals).toBe(7);
    expect(BigInt(result.receives.baseUnits)).toBe(250_000_000n);
  });

  /**
   * The commercial argument, checked rather than asserted in a README: the
   * standard path from Sepolia into Stellar costs nothing, so anyone reselling
   * this route adds their margin on top of zero.
   */
  it("charges nothing on the standard path", async () => {
    const result = await adapter.quote(ask());
    if (!isRoute(result)) throw new Error(result.explanation);

    const bridge = result.fees.find((f) => f.kind === "bridge");
    expect(bridge).toBeDefined();
    expect(BigInt(bridge?.total.baseUnits ?? "1")).toBe(0n);
  });

  it("promises exactly what it delivers, because a native mint has no slippage", async () => {
    const result = await adapter.quote(ask());
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.receivesAtLeast.baseUnits).toBe(result.receives.baseUnits);
  });

  it("asks for one signature into a ready account and more into a new one", async () => {
    const ready = await adapter.quote(ask());
    const fresh = await adapter.quote(ask({ destination: UNFUNDED }));
    if (!isRoute(ready)) throw new Error(ready.explanation);
    if (!isRoute(fresh)) throw new Error(fresh.explanation);

    expect(ready.signaturesRequired).toBe(1);
    // Preparing the account is signed by the user; settling it is not, because it
    // was signed in advance before any capital was committed.
    expect(fresh.signaturesRequired).toBe(2);
    expect(fresh.fees.some((f) => f.kind === "account-reserve")).toBe(true);
    expect(ready.fees.some((f) => f.kind === "account-reserve")).toBe(false);
  });

  it("declines a chain it has no verified deployment for, and says so", async () => {
    const result = await adapter.quote(ask({ from: { ...USDC_SEPOLIA, chainId: "fantom" } }));
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("chain-unsupported");
    expect(result.explanation).toContain("fantom");
  });

  it("declines an address that cannot receive rather than quoting into a hole", async () => {
    // A signer key. Well-formed, and catastrophic to send to.
    const result = await adapter.quote({
      ...ask(),
      destination: "SAV76USXIJOBMEQXPANUOQM6F5LIOTLPDIDVRJBFFE2MDJXG24TAPUU7",
    });
    expect(isRoute(result)).toBe(false);
    if (isRoute(result)) return;
    expect(result.reason).toBe("destination-unsupported");
  });

  it("builds a burn naming Circle's forwarder, never the user", async () => {
    const result = await adapter.quote(ask());
    if (!isRoute(result)) throw new Error(result.explanation);

    const [tx] = await adapter.buildTransactions(result);
    expect(tx?.format).toBe("evm-tx");
    expect(tx?.chainId).toBe("ethereum-sepolia");
    expect(tx?.describes).toContain(FUNDED);

    const payload = JSON.parse(tx?.payload ?? "{}") as { args: string[]; functionName: string };
    expect(payload.functionName).toBe("depositForBurnWithHook");
    // mintRecipient and destinationCaller are both the forwarder. Naming the user
    // in either position is what Circle warns is unrecoverable.
    expect(payload.args[2]).toBe(payload.args[4]);
  });

  /**
   * Solana is not EVM, and the burn there is an Anchor instruction rather than a
   * contract call. Quoting is the same either way, because Circle prices by
   * domain; only building differs.
   */
  it("quotes from Solana and builds an instruction rather than a contract call", async () => {
    const result = await adapter.quote(
      ask({ from: { ...USDC_SEPOLIA, chainId: "solana-devnet" } }),
    );
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.fromChain.name).toBe("Solana Devnet");

    const [tx] = await adapter.buildTransactions(result, {
      solana: {
        owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        messageSentEventData: "AaXs7cLGcSVAsEt8QxstVrqhLhYN2iGhFNRemwYnHitV",
      },
    });
    expect(tx?.format).toBe("solana-instruction");
    // Said out loud rather than discovered as a failed signature.
    expect(tx?.ephemeralSigners).toEqual(["message_sent_event_data"]);

    const payload = JSON.parse(tx?.payload ?? "{}") as { keys: unknown[]; programId: string };
    expect(payload.keys).toHaveLength(18);
    expect(payload.programId).toBe("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
  });

  it("refuses to invent a Solana keypair, and says what it needs instead", async () => {
    const result = await adapter.quote(
      ask({ from: { ...USDC_SEPOLIA, chainId: "solana-devnet" } }),
    );
    if (!isRoute(result)) throw new Error(result.explanation);
    // The SDK does not hold keys. Asking for them is better than making one.
    await expect(adapter.buildTransactions(result)).rejects.toThrow(
      /will\s+not\s+create a keypair/,
    );
  });

  it("reports nothing at all for a transfer that was never submitted", async () => {
    const phase = await adapter.status({
      sourceTxHash: undefined,
      depositAddress: undefined,
      destinationAddress: FUNDED,
      sourceChainId: undefined,
    });
    expect(phase.phase).toBe("idle");
  });

  it("reads the real burn from Circle and calls it delivered", async () => {
    const phase = await adapter.status({
      sourceTxHash: "0xa4a4308d0b7692da6f377d9c8f8a131cee8110a32dd218f6c55b1c5a7f046660",
      depositAddress: undefined,
      destinationAddress: FUNDED,
      sourceChainId: "ethereum-sepolia",
    });
    expect(phase.phase).toBe("done");
  });

  /**
   * The recovery path, and the product's stated advantage over the prior art.
   *
   * Someone who closed the tab may have a transaction hash and nothing else.
   * Circle's lookup needs a source domain, so finding the burn means asking every
   * chain we route from at once rather than telling that person it is lost.
   */
  it("finds a burn from the hash alone, with no idea which chain it came from", async () => {
    const phase = await adapter.status({
      sourceTxHash: "0xa4a4308d0b7692da6f377d9c8f8a131cee8110a32dd218f6c55b1c5a7f046660",
      depositAddress: undefined,
      destinationAddress: FUNDED,
      sourceChainId: undefined,
    });
    expect(phase.phase).toBe("done");
  });

  it("offers every chain it has a verified deployment for", async () => {
    const chains = await adapter.supportedChains();
    // Twenty-one, not one. Sepolia was the only one exercised end to end, but
    // every other address here was derived from its own chain and checked.
    expect(chains.length).toBeGreaterThanOrEqual(20);
    expect(chains).toContain("solana-devnet");
    expect(chains).toContain("ethereum-sepolia");
    expect(chains).toContain("base-sepolia");
    expect(chains).toContain("arbitrum-sepolia");
  });

  /**
   * The claim, checked rather than asserted.
   *
   * "Supports every chain Circle routes from" is easy to write in a README and
   * easy to be wrong about. This quotes from every single one and reports which,
   * if any, cannot be quoted, so the number in the documentation is a measurement.
   */
  it("quotes from every chain it says it supports", async () => {
    const chains = await adapter.supportedChains();
    const outcomes = await Promise.all(
      chains.map(async (chainId) => {
        const result = await adapter.quote(ask({ from: { ...USDC_SEPOLIA, chainId } }));
        return { chainId, ok: isRoute(result), why: isRoute(result) ? "" : result.explanation };
      }),
    );

    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length > 0) {
      throw new Error(
        `these chains did not quote: ${failed.map((f) => `${f.chainId} (${f.why})`).join("; ")}`,
      );
    }
    expect(outcomes).toHaveLength(chains.length);
  });

  it("builds a burn on every chain, each with that chain's own USDC", async () => {
    const chains = await adapter.supportedChains();
    const tokens = new Map<string, string>();

    for (const chainId of chains.filter((c) => !c.startsWith("solana"))) {
      const result = await adapter.quote(ask({ from: { ...USDC_SEPOLIA, chainId } }));
      if (!isRoute(result)) throw new Error(`${chainId}: ${result.explanation}`);
      const [tx] = await adapter.buildTransactions(result);
      const payload = JSON.parse(tx?.payload ?? "{}") as { args: string[] };
      tokens.set(chainId, String(payload.args[3]).toLowerCase());
    }

    // Every chain must burn a different token. A collision would mean one chain's
    // USDC address leaked into another, which burns something that is not USDC.
    expect(new Set(tokens.values()).size).toBe(tokens.size);
  });

  it("quotes from a chain other than the one it was built against", async () => {
    const result = await adapter.quote(ask({ from: { ...USDC_SEPOLIA, chainId: "base-sepolia" } }));
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.fromChain.id).toBe("base-sepolia");
    expect(result.fromChain.name).toContain("Base");

    const [tx] = await adapter.buildTransactions(result);
    const payload = JSON.parse(tx?.payload ?? "{}") as { args: string[] };
    // Base Sepolia's own USDC, not Sepolia's.
    expect(payload.args[3]?.toLowerCase()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  });
});
