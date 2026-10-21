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
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  StrKey,
  scValToNative,
  rpc as stellarRpc,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { Composer, KEEP_ALIVE_LEDGERS } from "./compose.js";

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

const WASM_HASH = "d8cc3923a6605ada3ad761f2f0545a15dc7b0715bbd4ce8a93caef6267acf9a6";
const ENDPOINT = "CALTBA5S6GRJEHAXFP45LGGLKWWAF7HTZCPNUBUJF2HWWRRLQNV35AIV";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });
const rpc = new RpcClient({ url: network.rpcUrl });
const XLM = Asset.native().contractId(network.passphrase);
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const USDC_SAC = USDC.contractId(network.passphrase);
const AQUA = new Asset("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const AQUA_SAC = AQUA.contractId(network.passphrase);

const sender = Keypair.random();
const recipient = Keypair.random();
// pays the fees; the executor is its own key, created by the Composer itself
const payer = Keypair.random();
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
    if (op.body.type === "invokeHostFunction") tx = await rpc.prepare(tx);
    tx.sign(kp);
    return tx;
  });
  return { txHash: result.txHash, ledger: result.ledger, returned: result.returnValue };
}

async function readRouter(method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal | undefined> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "100",
    networkPassphrase: network.passphrase,
  })
    .addOperation(new Contract(ROUTER).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await rpc.server.simulateTransaction(tx);
  return stellarRpc.Api.isSimulationError(sim) ? undefined : sim.result?.retval;
}

/**
 * The best direct pool between two classic assets, by the router's own estimate.
 * Aquarius's quoting service routes testnet through arbitrary custom tokens,
 * which the contract now refuses, so the path is built from the router directly.
 */
async function directPath(
  from: string,
  to: string,
  amount: bigint,
): Promise<{ out: bigint; path: ComposeArrival["path"] }> {
  const tokens = [from, to].sort();
  const tokensVal = xdr.ScVal.scvVec(tokens.map((t) => new Address(t).toScVal()));
  const pools = await readRouter("get_pools", tokensVal);
  let best: { out: bigint; index: Uint8Array } | undefined;
  for (const entry of pools?.type === "scvMap" ? (pools.map ?? []) : []) {
    const index = xdr.expectUnionVariant(entry.key, "scvBytes").bytes.toBytes();
    const est = await readRouter(
      "estimate_swap",
      tokensVal,
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      xdr.ScVal.scvBytes(index),
      nativeToScVal(amount, { type: "u128" }),
    );
    if (est === undefined) continue;
    const out = BigInt(scValToNative(est) as bigint);
    if (best === undefined || out > best.out) best = { out, index };
  }
  if (best === undefined) throw new Error(`no pool between ${from} and ${to}`);
  return {
    out: best.out,
    path: [{ tokens, poolIndex: xdr.encodeBytes(best.index, "hex"), tokenOut: to }],
  };
}

beforeAll(async () => {
  await Promise.all([fund(sender), fund(recipient), fund(payer)]);
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
        // converting into USDC, at most 10,000 XLM per arrival, as the shared testnet instance does
        xdr.ScVal.scvVec([
          xdr.ScVal.scvVec([
            new Address(USDC_SAC).toScVal(),
            nativeToScVal(100_000_000_000n, { type: "i128" }),
          ]),
        ]),
        xdr.ScVal.scvVec([]),
      ],
    }),
    "deploy arrival",
  );
  if (deployed.returned === undefined) throw new Error("the deploy returned no address");
  arrival = Address.fromScVal(deployed.returned).toString();
  await run(recipient, Operation.changeTrust({ asset: USDC }), "usdc trustline");
  await run(recipient, Operation.changeTrust({ asset: AQUA }), "aqua trustline");
});

const asset = (a: Asset): ComposeArrival["wanted"] => ({
  chainId: "stellar-testnet",
  id: a.isNative() ? "native" : a.toString(),
  symbol: a.isNative() ? "XLM" : a.getCode(),
  decimals: 7,
  curatedBy: undefined,
});

/** What an OFT's lz_receive does: credit the composer and queue the compose. */
async function queue(wanted: Asset, wantedContract: string) {
  const amount = 100_000_000n;
  const { out, path } = await directPath(XLM, wantedContract, amount);
  const compose: ComposeArrival = {
    contract: arrival,
    venue: "aquarius",
    arriving: asset(Asset.native()),
    arrivingContract: XLM,
    wanted: asset(wanted),
    wantedContract,
    minOut: ((out * 97n) / 100n).toString(),
    path,
    fee: undefined,
    trust: "",
    walletNote: "",
    fallback: "",
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
  return { compose, guid, queued, delivery, message };
}

function context(): ComposeContext {
  // the EVM side of discovery, the one boundary replaced: the sender key is the OFT
  return {
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
}

const composer = () =>
  new Composer({
    rpc,
    network,
    contract: arrival,
    payerSecret: payer.secret(),
    executorSecret: executor.secret(),
  });

async function xlmOf(account: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "100",
    networkPassphrase: network.passphrase,
  })
    .addOperation(new Contract(XLM).call("balance", new Address(account).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await rpc.server.simulateTransaction(tx);
  if (stellarRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return BigInt(scValToNative(sim.result?.retval as xdr.ScVal) as bigint);
}

/** The Stellar OFT the message was delivered through: the sender key stands in for it. */
const through = () => ({ stellarOft: sender.publicKey(), endpoint: ENDPOINT, decimalsDiff: 0 });

describe("an overdue conversion on arrival", () => {
  it("shows as pending, is finished by the sponsor, and cannot be finished twice", async () => {
    const { compose, guid, queued, delivery, message } = await queue(USDC, USDC_SAC);
    const ctx = context();
    const ref = { chainId: "stellar-testnet", txHash: delivery.txHash, explorerUrl: "" };

    const before = await composePhase(ctx, message, through(), ref);
    expect(before?.phase).toBe("delivered-conversion-pending");
    if (before?.phase !== "delivered-conversion-pending" || before.finish === undefined) {
      throw new Error(`expected a finishable conversion, got ${JSON.stringify(before)}`);
    }
    expect(before.finish.message).toBe(queued);

    const finished = await composer().finish(before.finish);
    expect(finished.kind).toBe("composed");

    const after = await composePhase(ctx, message, through(), ref);
    expect(after?.phase).toBe("delivered-and-converted");
    if (after?.phase === "delivered-and-converted") {
      expect(after.received.asset.id).toBe(USDC.toString());
      expect(BigInt(after.received.baseUnits)).toBeGreaterThanOrEqual(BigInt(compose.minOut));
    }
    const event = await findArrivalEvent(rpc, arrival, guid, delivery.ledger);
    expect(event?.recipient).toBe(recipient.publicKey());

    // the executor signed one authorization and paid nothing
    expect(await xlmOf(executor.publicKey())).toBe(10_000_000n);

    // twice cannot deliver twice
    expect((await composer().finish(before.finish)).kind).toBe("already-composed");
    // a message the endpoint never queued is answered before anything is paid
    expect(
      (await composer().finish({ ...before.finish, guid: randomBytes(32).toString("hex") })).kind,
    ).toBe("not-queued");
  });

  it("delivers as it came, without calling it, when the wanted asset is off the list", async () => {
    const { message, delivery } = await queue(AQUA, AQUA_SAC);
    const ctx = context();
    const ref = { chainId: "stellar-testnet", txHash: delivery.txHash, explorerUrl: "" };
    const before = await composePhase(ctx, message, through(), ref);
    if (before?.phase !== "delivered-conversion-pending" || before.finish === undefined) {
      throw new Error(`expected a finishable conversion, got ${JSON.stringify(before)}`);
    }
    expect((await composer().finish(before.finish)).kind).toBe("composed");
    const after = await composePhase(ctx, message, through(), ref);
    expect(after?.phase).toBe("delivered-as-came");
  });
});

describe("keeping the contract alive", () => {
  it("extends the contract's instance and code so it is never archived between arrivals", async () => {
    const result = await composer().keepAlive();
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(arrival).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const entries = await rpc.server.getLedgerEntries(key);
    const liveUntil = entries.entries[0]?.liveUntilLedgerSeq ?? 0;
    expect(liveUntil).toBeGreaterThanOrEqual(result.ledger + KEEP_ALIVE_LEDGERS - 1);
  });
});
