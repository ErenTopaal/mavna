import type { Asset, QuoteRequest, Route, RouteRejection } from "@mavna/core";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CctpAdapter } from "./adapter.js";
import { sourceUsdcFor } from "./assets.js";
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

/** The canonical USDC on a source chain, since the adapter matches by address. */
const usdcOn = (chainId: string): Asset => {
  const usdc = sourceUsdcFor("testnet", chainId);
  if (usdc === undefined) throw new Error(`no USDC known for ${chainId}`);
  return { ...USDC_SEPOLIA, chainId, id: usdc.address };
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

const ask = (over: Partial<QuoteRequest> = {}): QuoteRequest => {
  const from = over.from ?? USDC_SEPOLIA;
  return {
    from,
    to: USDC_STELLAR,
    sends: { asset: from, baseUnits: "25000000" },
    destination: FUNDED,
    maxSlippageBps: 50,
    ...over,
  };
};

const isRoute = (result: Route | RouteRejection): result is Route => "receives" in result;

/**
 * Quote, retrying only the rejection that says to.
 *
 * Sweeping every chain in one run makes many reads of the same Stellar
 * destination in quick succession, and the freshness guard refuses any taken from
 * a node that has fallen behind. That is the guard working. A real caller answers
 * "try again in a moment" by trying again in a moment, so the test does too, and
 * every other rejection still fails the run immediately.
 */
async function quoteRetrying(request: QuoteRequest): Promise<Route | RouteRejection> {
  let last: Route | RouteRejection = await adapter.quote(request);
  for (let attempt = 0; attempt < 4 && !isRoute(last); attempt += 1) {
    if (last.reason !== "temporarily-unavailable") return last;
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    last = await adapter.quote(request);
  }
  return last;
}

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

  it("asks for two signatures into a ready account and more into a new one", async () => {
    const ready = await adapter.quote(ask());
    const fresh = await adapter.quote(ask({ destination: UNFUNDED }));
    if (!isRoute(ready)) throw new Error(ready.explanation);
    if (!isRoute(fresh)) throw new Error(fresh.explanation);

    // Two, not one. This said one until the approval was found missing: on EVM the
    // messenger pulls the funds with transferFrom, so the allowance is signed for
    // separately. The old number was a promise the flow could not keep.
    expect(ready.steps.map((s) => s.kind)).toEqual(["approve-source", "bridge"]);
    expect(ready.signaturesRequired).toBe(2);
    // Preparing the account is signed by the user; settling it is not, because it
    // was signed in advance before any capital was committed.
    expect(fresh.steps.map((s) => s.kind)).toEqual([
      "prepare-account",
      "approve-source",
      "bridge",
      "settle-account",
    ]);
    expect(fresh.signaturesRequired).toBe(3);
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

    // Approval first, then the burn. The messenger takes the funds with
    // transferFrom, so without the allowance the burn reverts having spent gas.
    const [approval, tx] = await adapter.buildTransactions(result);
    expect(approval?.format).toBe("evm-tx");
    const approvalPayload = JSON.parse(approval?.payload ?? "{}") as { functionName: string };
    expect(approvalPayload.functionName).toBe("approve");
    // Stated so a caller with an allowance already in place can skip it rather
    // than burning the user's gas to approve what is approved.
    expect(approval?.unnecessaryWhen?.kind).toBe("erc20-allowance");

    expect(tx?.format).toBe("evm-tx");
    expect(tx?.chainId).toBe("ethereum-sepolia");
    expect(tx?.describes).toContain(FUNDED);

    const payload = JSON.parse(tx?.payload ?? "{}") as { args: string[]; functionName: string };
    expect(payload.functionName).toBe("depositForBurnWithHook");
    // mintRecipient and destinationCaller are both the forwarder. Naming the user
    // in either position is what Circle warns is unrecoverable.
    expect(payload.args[2]).toBe(payload.args[4]);
  });

  it("tells the user about the approval signature rather than springing it on them", async () => {
    const result = await adapter.quote(ask());
    if (!isRoute(result)) throw new Error(result.explanation);
    // Two on EVM: approve, then burn. This was one, which meant promising a count
    // and then asking for more than it.
    expect(result.steps.map((s) => s.kind)).toContain("approve-source");
    expect(result.signaturesRequired).toBeGreaterThanOrEqual(2);
  });

  /**
   * Solana is not EVM, and the burn there is an Anchor instruction rather than a
   * contract call. Quoting is the same either way, because Circle prices by
   * domain; only building differs.
   */
  it("quotes from Solana and builds an instruction rather than a contract call", async () => {
    const result = await adapter.quote(ask({ from: usdcOn("solana-devnet") }));
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
    const result = await adapter.quote(ask({ from: usdcOn("solana-devnet") }));
    if (!isRoute(result)) throw new Error(result.explanation);
    // The SDK does not hold keys. Asking for them is better than making one.
    await expect(adapter.buildTransactions(result)).rejects.toThrow(
      /will\s+not\s+create a keypair/,
    );
  });

  it("quotes from Starknet and builds an invoke rather than a contract call", async () => {
    const result = await adapter.quote(ask({ from: usdcOn("starknet-sepolia") }));
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.fromChain.name).toBe("Starknet Sepolia");

    const [tx] = await adapter.buildTransactions(result);
    expect(tx?.format).toBe("starknet-invoke");
    // Nothing ephemeral to sign here, unlike Solana.
    expect(tx?.ephemeralSigners).toEqual([]);

    const calls = JSON.parse(tx?.payload ?? "[]") as { entrypoint: string }[];
    // Approve, then burn. One signature, two calls, which is ordinary on Starknet.
    expect(calls.map((c) => c.entrypoint)).toEqual(["approve", "deposit_for_burn_with_hook"]);
  });

  it("reports nothing at all for a transfer that was never submitted", async () => {
    // A brand new address, so there is genuinely nothing to find. This test
    // used FUNDED until the address-only lookup became real, at which point it
    // started correctly finding the delivery that account actually received.
    const phase = await adapter.status({
      sourceTxHash: undefined,
      depositAddress: undefined,
      destinationAddress: Keypair.random().publicKey(),
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
    expect(chains).toContain("starknet-sepolia");
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
    // Sequential on purpose. Quoting them all at once means twenty-four
    // simultaneous reads of the same Stellar destination, and the freshness guard
    // rightly refuses a read from a node that has fallen behind. That is the
    // guard working, not a chain failing, so the test does not provoke it.
    const outcomes = [];
    for (const chainId of chains) {
      const result = await quoteRetrying(ask({ from: usdcOn(chainId) }));
      outcomes.push({
        chainId,
        ok: isRoute(result),
        why: isRoute(result) ? "" : result.explanation,
      });
    }

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

    for (const chainId of chains.filter(
      (c) => !c.startsWith("solana") && !c.startsWith("starknet"),
    )) {
      const result = await quoteRetrying(ask({ from: usdcOn(chainId) }));
      if (!isRoute(result)) throw new Error(`${chainId}: ${result.explanation}`);
      // Index 1 is the burn; index 0 is its approval.
      const [, burn] = await adapter.buildTransactions(result);
      const payload = JSON.parse(burn?.payload ?? "{}") as { args: string[] };
      const token = payload.args[3];
      if (token === undefined) throw new Error(`${chainId}: the burn named no token`);
      tokens.set(chainId, token.toLowerCase());
    }

    // Every chain must burn a different token. A collision would mean one chain's
    // USDC address leaked into another, which burns something that is not USDC.
    expect(new Set(tokens.values()).size).toBe(tokens.size);
  });

  it("quotes from a chain other than the one it was built against", async () => {
    const result = await adapter.quote(ask({ from: usdcOn("base-sepolia") }));
    if (!isRoute(result)) throw new Error(result.explanation);
    expect(result.fromChain.id).toBe("base-sepolia");
    expect(result.fromChain.name).toContain("Base");

    const [approval, burn] = await adapter.buildTransactions(result);
    const payload = JSON.parse(burn?.payload ?? "{}") as { args: string[] };
    // Base Sepolia's own USDC, not Sepolia's, in both the burn and its approval.
    expect(payload.args[3]?.toLowerCase()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
    const approvalPayload = JSON.parse(approval?.payload ?? "{}") as { to: string };
    expect(approvalPayload.to.toLowerCase()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  });
});

describe("a destination that has never existed", () => {
  /**
   * The product's whole reason for being, checked at the quoting layer.
   *
   * The promise is on the route: prepare, approve, burn, settle, three
   * signatures. The source-chain builder returns the two EVM legs and no more,
   * because the Stellar side is DELIBERATELY not built here: the cost decision
   * requires preparation after Circle's attestation exists, minutes from now,
   * and the sponsor service builds it at that moment with a fresh sequence.
   * An earlier version built the preparation upfront, which violated the
   * lateness rule that §6.1 of the cost decision calls the only mitigation for
   * the one permanent loss in the design.
   */
  const fresh = (): string => Keypair.random().publicKey();

  it("promises the whole plan, and builds exactly the source-chain legs", async () => {
    const result = await adapter.quote(ask({ destination: fresh() }));
    if (!isRoute(result)) throw new Error(result.explanation);

    expect(result.steps.map((s) => s.kind)).toEqual([
      "prepare-account",
      "approve-source",
      "bridge",
      "settle-account",
    ]);
    expect(result.signaturesRequired).toBe(3);

    const built = await adapter.buildTransactions(result);
    // Two here, and the third signature is the Stellar preparation, whose
    // builder is the sponsor service at attestation time.
    expect(built.map((t) => t.format)).toEqual(["evm-tx", "evm-tx"]);
    expect(built.every((t) => t.chainId === "ethereum-sepolia")).toBe(true);
  });

  it("measures the floor in the asset arriving, not in XLM", async () => {
    // Five dollars is comfortably above the floor for a new account. It was
    // being refused because the floor is an amount of XLM and the arriving
    // amount is USDC, and both are seven decimal integers that look alike.
    const result = await adapter.quote(ask({ destination: fresh() }));
    expect(isRoute(result)).toBe(true);
  });
});

describe("two ways this adapter could lie", () => {
  it("refuses to build a route another rail quoted", async () => {
    // Without this, picking an Axelar route and pressing send produced a Circle
    // burn priced against a fee Axelar never charged, while the interface said
    // the user had chosen Axelar. It was hidden only because the other rails
    // happen to decline the pairs this app asks about.
    const result = await adapter.quote(ask());
    if (!isRoute(result)) throw new Error(result.explanation);

    const borrowed = { ...result, source: "axelar" };
    await expect(adapter.buildTransactions(borrowed)).rejects.toThrow(/came from axelar/);
  });

  it("calls a transfer done on the forwarder's delivery of it, not on a balance", async () => {
    // The real transfer moved 5 USDC into an account that ended up holding 6.
    // Reading the balance would report 6 as "received", and would have reported
    // done before the money arrived, because the account already held some.
    // August is far outside RPC retention, so this is proven through Horizon.
    const phase = await adapter.status({
      sourceTxHash: "0x8b05173c947f416c508d783139e1cf2083ebb005e727d1c12a2845ca38254a2d",
      sourceChainId: "ethereum-sepolia",
      depositAddress: undefined,
      destinationAddress: FUNDED,
    });

    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    expect(phase.received.baseUnits).toBe("50000000");
  });

  it("proves a delivery inside RPC retention from the transmitter's event", async () => {
    // Delivered at ledger 5261151 on 2026-10-18. This leaves RPC's seven-day
    // window around 2026-10-25, after which the same answer comes from Horizon.
    const phase = await adapter.status({
      sourceTxHash: "0x2811c73382906496ddcef99121fa54713e8482e73767b56dd5ab517d0ed927a8",
      sourceChainId: "ethereum-sepolia",
      depositAddress: undefined,
      destinationAddress: "GAM7ZOID2YK4SVLN4LNOBWCKLXAXRIXPQMBCKGRA3C37EHQ3NFX7I4CO",
    });

    expect(phase.phase).toBe("done");
    if (phase.phase !== "done") return;
    expect(phase.received.baseUnits).toBe("10000000");
  });
});

describe("finding a transfer from nothing but the address it went to", () => {
  it("points at the real delivery without calling any transfer done", async () => {
    // The prior art refuses a destination address as a lookup key outright.
    // An address alone cannot say which transfer arrived, so this finds the
    // delivery that actually happened and offers it, while only a burn hash
    // can prove a particular transfer is done.
    const phase = await adapter.status({
      sourceTxHash: undefined,
      sourceChainId: undefined,
      depositAddress: undefined,
      destinationAddress: FUNDED,
    });

    expect(phase.phase).toBe("pending");
    if (phase.phase !== "pending") return;
    expect(phase.ref.txHash).toBe(
      "1d7a7e152bf95193d2933971deb712de682e862da15beb8631e89a5c96a17174",
    );
  });

  it("does not mistake USDC from elsewhere for a delivery", async () => {
    // The sponsor account holds USDC bought on the exchange. None of it came
    // through Circle's forwarder, so none of it is this product's delivery, and
    // calling it one would invent a transfer that never happened.
    const phase = await adapter.status({
      sourceTxHash: undefined,
      sourceChainId: undefined,
      depositAddress: undefined,
      destinationAddress: "GDDS36IOD3FK6AJPFJTMBECSGSTP357B2VOXQBZFALCJQGNLNY54LCUY",
    });
    expect(phase.phase).toBe("idle");
  });
});
