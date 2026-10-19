import { randomBytes } from "node:crypto";
import {
  type ComposeContext,
  composePhase,
  encodeArrivalMessage,
  encodeOftComposeMsg,
  findArrivalEvent,
  type ScanMessage,
} from "@mavna/adapter-layerzero";
import type { ComposeArrival, RouteRejection } from "@mavna/core";
import { createNetworkConfig, PUBLIC_TESTNET_RPC_URL, RpcClient } from "@mavna/stellar";
import { AquariusProvider } from "@mavna/swap";
import {
  Address,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  StrKey,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { Composer } from "./compose.js";

/**
 * Finishing a conversion on arrival, on Stellar testnet, end to end.
 *
 * No OFT is peered to Stellar testnet, so a fresh key stands in for one: this
 * test deploys its own Arrival Contract from the wasm already installed on
 * testnet (sha256 below, built from contracts/), allowlists that key, credits
 * the contract and queues the compose on LayerZero's real testnet endpoint
 * exactly as an OFT's lz_receive would. Everything after that is real: the
 * endpoint's queue, Aquarius's router, the contract, the sponsor's finish.
 */

const WASM_HASH = "56e2acc5c2bfe41ff931f00df2e6092ff658e8933c1e313537faa26a1296e35f";
const ENDPOINT = "CALTBA5S6GRJEHAXFP45LGGLKWWAF7HTZCPNUBUJF2HWWRRLQNV35AIV";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const rpc = new RpcClient({ url: network.rpcUrl });
const XLM = Asset.native().contractId(network.passphrase);
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const USDC_SAC = USDC.contractId(network.passphrase);

const sender = Keypair.random();
const recipient = Keypair.random();
const executor = Keypair.random();
let arrival = "";

async function fund(kp: Keypair): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!response.ok) throw new Error(`friendbot answered ${response.status}`);
}

async function run(
  kp: Keypair,
  op: xdr.Operation,
  label: string,
): Promise<{ txHash: string; ledger: number; returned: xdr.ScVal | undefined }> {
  const result = await rpc.submit(label, async () => {
    const account = await rpc.loadAccount(kp.publicKey());
    let tx: Transaction = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: network.passphrase,
    })
      .addOperation(op)
      .setTimeout(120)
      .build();
    if (op.body().switch().name === "invokeHostFunction") tx = await rpc.prepare(tx);
    tx.sign(kp);
    return tx;
  });
  return { txHash: result.txHash, ledger: result.ledger, returned: result.returnValue };
}

beforeAll(async () => {
  await Promise.all([fund(sender), fund(recipient), fund(executor)]);
  const deployed = await run(
    sender,
    Operation.createCustomContract({
      address: new Address(sender.publicKey()),
      wasmHash: Buffer.from(WASM_HASH, "hex"),
      salt: randomBytes(32),
      constructorArgs: [
        new Address(ENDPOINT).toScVal(),
        new Address(ROUTER).toScVal(),
        nativeToScVal([[new Address(sender.publicKey()), new Address(XLM)]]),
      ],
    }),
    "deploy arrival",
  );
  if (deployed.returned === undefined) throw new Error("the deploy returned no address");
  arrival = Address.fromScVal(deployed.returned).toString();
  await run(recipient, Operation.changeTrust({ asset: USDC }), "usdc trustline");
});

describe("an overdue conversion on arrival", () => {
  it("shows as pending, is finished by the sponsor, and cannot be finished twice", async () => {
    const amount = 100_000_000n;
    const quote = await new AquariusProvider("testnet").quotePath({
      assetIn: XLM,
      assetOut: USDC_SAC,
      amountIn: amount.toString(),
      maxSlippageBps: 300,
    });
    const compose: ComposeArrival = {
      contract: arrival,
      venue: quote.provider,
      arriving: {
        chainId: "stellar-testnet",
        id: "native",
        symbol: "XLM",
        decimals: 7,
        curatedBy: "Stellar",
      },
      arrivingContract: XLM,
      wanted: {
        chainId: "stellar-testnet",
        id: USDC.toString(),
        symbol: "USDC",
        decimals: 7,
        curatedBy: "Circle",
      },
      wantedContract: USDC_SAC,
      minOut: quote.amountOutMinimum,
      path: quote.path,
      fee: undefined,
      trust: "",
      walletNote: "",
    };
    const instructions = encodeArrivalMessage(recipient.publicKey(), compose);
    const guid = randomBytes(32).toString("hex");
    const composeFrom = `0x${randomBytes(32).toString("hex")}` as const;
    const nonce = 1n;
    const srcEid = 40161;
    const queued = encodeOftComposeMsg({
      nonce,
      srcEid,
      amountLd: amount,
      composeFrom,
      composeMsg: instructions,
    });

    // what an OFT's lz_receive does: credit the composer, queue the compose
    await run(
      sender,
      new Contract(XLM).call(
        "transfer",
        new Address(sender.publicKey()).toScVal(),
        new Address(arrival).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ),
      "credit arrival",
    );
    const delivery = await run(
      sender,
      new Contract(ENDPOINT).call(
        "send_compose",
        new Address(sender.publicKey()).toScVal(),
        new Address(arrival).toScVal(),
        nativeToScVal(Buffer.from(guid, "hex")),
        nativeToScVal(0, { type: "u32" }),
        nativeToScVal(Buffer.from(queued.slice(2), "hex")),
      ),
      "send_compose",
    );

    // LayerZero's record of the message, as Scan would carry it
    const message: ScanMessage = {
      guid: `0x${guid}`,
      pathway: { nonce: Number(nonce), srcEid },
      source: {
        tx: {
          payload: `0x${Buffer.from(StrKey.decodeContract(arrival)).toString("hex")}${amount
            .toString(16)
            .padStart(16, "0")}${composeFrom.slice(2)}${instructions.slice(2)}`,
        },
      },
      destination: { tx: { txHash: delivery.txHash, blockTimestamp: 0 } },
    };
    // the EVM side of discovery, the one boundary replaced: this key is the OFT
    const ctx: ComposeContext = {
      network: "testnet",
      rpc,
      passphrase: network.passphrase,
      discovery: {
        routeFrom: async () => ({
          stellarOft: sender.publicKey(),
          stellar: { endpoint: ENDPOINT, token: XLM, decimalsDiff: 0, kind: "test" },
        }),
      } as unknown as ComposeContext["discovery"],
      arrival: { contract: arrival, venue: new AquariusProvider("testnet") },
      lzReceiveGas: undefined,
      decline: (reason, explanation): RouteRejection => ({
        source: "layerzero",
        reason,
        explanation,
        retryable: false,
      }),
    };
    const ref = { chainId: "stellar-testnet", txHash: delivery.txHash, explorerUrl: "" };

    const before = await composePhase(ctx, message, "test", ref);
    expect(before?.phase).toBe("delivered-conversion-pending");
    if (before?.phase !== "delivered-conversion-pending" || before.finish === undefined) {
      throw new Error(`expected a finishable conversion, got ${JSON.stringify(before)}`);
    }
    expect(before.finish.message).toBe(queued);

    const composer = new Composer({
      rpc,
      network,
      contract: arrival,
      payerSecret: executor.secret(),
    });
    const finished = await composer.finish(before.finish);
    expect(finished.kind).toBe("composed");

    const after = await composePhase(ctx, message, "test", ref);
    expect(after?.phase).toBe("delivered-and-converted");
    if (after?.phase === "delivered-and-converted") {
      expect(after.received.asset.id).toBe(USDC.toString());
      expect(BigInt(after.received.baseUnits)).toBeGreaterThanOrEqual(BigInt(compose.minOut));
    }
    const event = await findArrivalEvent(rpc, arrival, guid, delivery.ledger);
    expect(event?.recipient).toBe(recipient.publicKey());

    // twice cannot deliver twice
    expect((await composer.finish(before.finish)).kind).toBe("already-composed");
    // a message the endpoint never queued is answered before anything is paid
    expect(
      (await composer.finish({ ...before.finish, guid: randomBytes(32).toString("hex") })).kind,
    ).toBe("not-queued");
  });
});
