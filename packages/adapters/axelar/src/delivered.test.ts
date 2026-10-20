import { MavnaError, type StepPhase, type TransferHandle } from "@mavna/core";
import { RpcClient } from "@mavna/stellar";
import {
  Address,
  nativeToScVal,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deliveries from "./__fixtures__/mainnet-deliveries.json" with { type: "json" };
import { AxelarAdapter } from "./adapter.js";
import { forgetItsAssets } from "./assets.js";
import { forgetChains } from "./deployments.js";
import { DEPLOYMENTS_COMMIT, PINNED_DEPLOYMENTS } from "./pinned.js";

/**
 * Two delivered mainnet transfers, replayed from what Axelar and Stellar
 * actually returned (see the fixture's `source`). Axelar's Stellar-leg record
 * for the WETH transfer carries no amount at all, and the BCB one states six
 * decimals for a token that has seven. What arrived is read from the delivery
 * transaction on Stellar instead.
 */

type Name = keyof typeof deliveries.transfers;

const ITS = PINNED_DEPLOYMENTS.mainnet.stellar?.interchainTokenService ?? "";
const ETH = PINNED_DEPLOYMENTS.mainnet.ethereum;
const GATEWAY = "CD6VSKXB4HY2DWU7EP2PUIYTBJBJ36LDJXEZN4NSXFYF5YP37DDFX6NF";
const CONFIG_URL = `https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${DEPLOYMENTS_COMMIT}/axelar-chains-config/info/mainnet.json`;

let transfer: (typeof deliveries.transfers)[Name];
/** What the Stellar node answers for the delivery transaction. */
let stellarTx: unknown;
/** What Horizon answers for the delivery transaction's operations. */
let horizonOperations: unknown;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function services(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.axelarscan.io/api/getChains") {
      return json([
        { id: "ethereum", chain_type: "evm" },
        { id: "stellar", chain_type: "vm", gateway: { address: GATEWAY } },
      ]);
    }
    if (url === CONFIG_URL) {
      return json({
        chains: {
          ethereum: {
            name: "Ethereum",
            axelarId: "Ethereum",
            chainId: 1,
            chainType: "evm",
            rpc: "https://ethereum-rpc.publicnode.com",
            tokenSymbol: "ETH",
            decimals: 18,
            contracts: {
              InterchainTokenService: { address: ETH?.interchainTokenService },
              AxelarGasService: { address: ETH?.gasService },
            },
          },
          stellar: {
            name: "Stellar",
            axelarId: "stellar",
            chainType: "stellar",
            tokenSymbol: "XLM",
            decimals: 7,
            contracts: { InterchainTokenService: { address: ITS } },
          },
        },
      });
    }
    if (url === "https://api.axelarscan.io/api/getITSAssets") return json(deliveries.itsAssets);
    if (url === `https://horizon.stellar.org/transactions/${transfer.stellarTx}/operations`) {
      return json(horizonOperations);
    }
    if (url === "https://api.gmp.axelarscan.io/searchGMP") {
      const query = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return json({ data: query.messageId === undefined ? transfer.first : transfer.second });
    }
    throw new Error(`the fetch double has no answer for ${url}`);
  });
}

/** A real client whose node answers from the fixture. */
function stellarNode(): RpcClient {
  const client = new RpcClient({
    url: "https://stellar.test",
    baseDelayMs: 0,
    sleep: async () => {},
  });
  vi.spyOn(client.server, "_getTransaction").mockImplementation(async () => stellarTx as never);
  vi.spyOn(client.server, "_getLedgerEntries").mockImplementation(
    async () => transfer.token.instance as never,
  );
  vi.spyOn(client.server, "simulateTransaction").mockImplementation(async (tx) => {
    const op = (tx as Transaction).operations[0];
    if (op?.type !== "invokeHostFunction") throw new Error("not a contract call");
    const call = op.func.value;
    const invoke = call as unknown as xdr.InvokeContractArgs;
    const method = invoke.functionName.toString();
    const target = Address.fromScAddress(invoke.contractAddress).toString();
    const answer = (value: xdr.ScVal) => ({ result: { retval: value }, latestLedger: 100 });
    if (target === ITS && method === "registered_token_address") {
      const id = Buffer.from(scValToNative(invoke.args[0] as xdr.ScVal) as Uint8Array).toString(
        "hex",
      );
      if (id !== tokenIdOf(transfer)) throw new Error(`unexpected token id ${id}`);
      return answer(new Address(transfer.token.id).toScVal()) as never;
    }
    if (target === transfer.token.id && method === "decimals") {
      return answer(nativeToScVal(transfer.token.decimals, { type: "u32" })) as never;
    }
    if (target === transfer.token.id && method === "symbol") {
      return answer(nativeToScVal(transfer.token.symbol, { type: "string" })) as never;
    }
    if (target === transfer.token.id && method === "name") {
      return answer(nativeToScVal(transfer.token.name, { type: "string" })) as never;
    }
    throw new Error(`the Stellar double has no answer for ${method} on ${target}`);
  });
  return client;
}

function tokenIdOf(t: (typeof deliveries.transfers)[Name]): string {
  const it = (t.first[0] as { interchain_transfer?: { tokenId?: string } }).interchain_transfer;
  return (it?.tokenId ?? "").replace(/^0x/, "").toLowerCase();
}

function use(name: Name): void {
  transfer = deliveries.transfers[name];
  stellarTx = transfer.getTransaction;
  horizonOperations = transfer.horizonOperations;
}

/** The node has dropped the transaction: it answers NOT_FOUND, kept back to a later ledger. */
function agedOut(): void {
  const t = transfer.getTransaction as Record<string, unknown>;
  stellarTx = {
    status: "NOT_FOUND",
    latestLedger: Number(t.ledger) + 200_000,
    latestLedgerCloseTime: String(Number(t.latestLedgerCloseTime) + 1_200_000),
    oldestLedger: Number(t.ledger) + 100_000,
    oldestLedgerCloseTime: String(Number(t.latestLedgerCloseTime) + 600_000),
  };
}

function handle(destination?: string): TransferHandle {
  return {
    sourceTxHash: transfer.sourceTxHash,
    depositAddress: undefined,
    destinationAddress: destination,
    sourceChainId: "ethereum",
  };
}

async function statusOf(destination?: string): Promise<StepPhase> {
  const adapter = new AxelarAdapter({
    network: "mainnet",
    rpc: stellarNode(),
    baseReserveStroops: 5_000_000,
  });
  return adapter.status(handle(destination));
}

beforeEach(() => {
  forgetChains();
  forgetItsAssets();
  services();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what a delivered Axelar transfer brought, read from Stellar", () => {
  it("is done for WETH, whose Stellar-leg record carries no amount", async () => {
    use("weth");
    const phase = await statusOf();
    if (phase.phase !== "done") throw new Error(`expected done, got ${phase.phase}`);
    // the token's own mint and the token service's receipt both say this
    expect(phase.received.baseUnits).toBe("149500000000000000");
    expect(phase.received.asset.id).toBe(
      "CDTRXQUOFLCNAEC7DBZT36MBVQ2EDUNUKT4GYOZHOMYOFR7QWTC5IIRV",
    );
    expect(phase.received.asset.decimals).toBe(18);
    expect(phase.received.asset.chainId).toBe("stellar");
  });

  it("is done for BCB in the token's own seven decimals, not the six Axelar states", async () => {
    use("bcb");
    const phase = await statusOf("GDKFBTJPAU74CNX64RTM47ESQR4QSYSXC2NMHB7BHQTSGLDZQTS6CAXL");
    if (phase.phase !== "done") throw new Error(`expected done, got ${phase.phase}`);
    expect(phase.received.baseUnits).toBe("30000000000");
    expect(phase.received.asset.id).toBe(
      "BCB:GD7P2H4MSVW3V6L34YFX7YZBIMWAOSSZVXELJANBPKMDRO34DYV37BCB",
    );
    expect(phase.received.asset.decimals).toBe(7);
    expect(phase.received.asset.symbol).toBe("BCB");
  });

  it("is not done when the transaction Axelar names did not deliver this message", async () => {
    // the BCB delivery's transaction, offered as the WETH one
    use("weth");
    stellarTx = deliveries.transfers.bcb.getTransaction;
    const failure = await statusOf().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
  });

  it("is not done for a recipient other than the one the transfer was for", async () => {
    use("bcb");
    const failure = await statusOf(
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
  });

  it("is not done when Stellar has not seen the transaction yet", async () => {
    use("weth");
    const t = transfer.getTransaction as Record<string, unknown>;
    stellarTx = {
      status: "NOT_FOUND",
      latestLedger: t.latestLedger,
      latestLedgerCloseTime: t.latestLedgerCloseTime,
      oldestLedger: t.oldestLedger,
      oldestLedgerCloseTime: t.oldestLedgerCloseTime,
    };
    const phase = await statusOf().catch((cause: unknown) => cause);
    expect((phase as StepPhase).phase === "done").toBe(false);
  });
});

describe("a delivery older than the Stellar node keeps", () => {
  it("is done for a Stellar asset, proven from Horizon's record of the execution", async () => {
    use("bcb");
    agedOut();
    const phase = await statusOf("GDKFBTJPAU74CNX64RTM47ESQR4QSYSXC2NMHB7BHQTSGLDZQTS6CAXL");
    if (phase.phase !== "done") throw new Error(`expected done, got ${phase.phase}`);
    expect(phase.received.baseUnits).toBe("30000000000");
    expect(phase.received.asset.id).toBe(
      "BCB:GD7P2H4MSVW3V6L34YFX7YZBIMWAOSSZVXELJANBPKMDRO34DYV37BCB",
    );
    expect(phase.received.asset.decimals).toBe(7);
  });

  it("is never done for a token that is its own contract, which Horizon cannot show moving", async () => {
    use("weth");
    agedOut();
    const phase = await statusOf();
    if (phase.phase !== "delivered-unverified") {
      throw new Error(`expected delivered-unverified, got ${phase.phase}`);
    }
    expect(phase.ref.txHash).toBe(transfer.stellarTx);
    expect(phase.ref.chainId).toBe("stellar");
    expect(phase.ref.explorerUrl).toBe(
      `https://stellar.expert/explorer/public/tx/${transfer.stellarTx}`,
    );
    expect(phase.because).toMatch(/Axelar/);
  });

  it("is not done when Horizon's record is of another message", async () => {
    use("bcb");
    agedOut();
    horizonOperations = deliveries.transfers.weth.horizonOperations;
    const failure = await statusOf().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
  });

  it("is not done when Horizon shows the asset paid to someone else", async () => {
    use("bcb");
    agedOut();
    const failure = await statusOf(
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MavnaError);
  });
});
