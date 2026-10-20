import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBurn,
  buildDelivery,
  CCTP_CONTRACTS,
  contractAddressToBytes32,
  EVM_DEPLOYMENTS,
  NON_EVM_CHAINS,
  SOLANA_PROGRAMS,
  STARKNET_DEPLOYMENTS,
  solanaAddressToBytes32,
  toHex,
} from "@mavna/adapter-cctp";
import { composeMessageHash } from "@mavna/adapter-layerzero";
import { MavnaError } from "@mavna/core";
import {
  createNetworkConfig,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
  type SubmitOptions,
  SubmitRejected,
  XlmPriceSource,
} from "@mavna/stellar";
import {
  Account,
  Asset,
  type FeeBumpTransaction,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  rpc,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import arrivalEntries from "../../../packages/adapters/layerzero/src/__fixtures__/testnet-ledger-entries.json" with {
  type: "json",
};
import { signedBy } from "./built.js";
import { CapLedger, type CapUsage, DEFAULT_CAPS, InMemoryCapStore } from "./caps.js";
import { ChannelPool } from "./channels.js";
import type { ChainSponsorshipView } from "./reconcile.js";
import { createSponsorServer, type SponsorServer, type SponsorServerOptions } from "./server.js";
import { createSoroswapProxy } from "./soroswap.js";
import { DirectSpendQuote } from "./spend.js";
import { DocumentCapStore, FileDocumentStore, MemoryDocumentStore } from "./state.js";

/**
 * The sponsor's endpoints, driven over real HTTP against a real server.
 *
 * The only double is the RPC boundary: it remembers what it was asked to
 * submit, so every attack can be judged by the one thing that matters, whether
 * anything signed by the funded key would have reached the network.
 */

const network = createNetworkConfig({ id: "testnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });

const NO_SETTLEMENT =
  "No settlement is held for this account. The deposit is a loan, and the " +
  "repayment is signed before the loan is made, not after.";

const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

// Unroutable on purpose: a method this double does not override fails at once
// instead of quietly reaching testnet.
const NOWHERE = "https://127.0.0.1:9";

/** Where the server is told Circle's attestation service lives. Only the fetch double answers it. */
const IRIS = "https://iris.invalid";

/** A thousand USDC in stroops: far more than any settlement here spends. */
const PLENTY = 10_000_000_000n;

/**
 * A stand-in for the network, behind the real RpcClient. Accounts carry real
 * sequence numbers: a transaction lands only on its source's next sequence and
 * advances it, so a spent sequence is refused the way the network refuses it.
 */
const RECORDED_CONTRACT_ENTRIES = new Map<string, string>(
  Object.values(arrivalEntries).flatMap((recorded) =>
    recorded.entries.map((e) => [e.key, e.xdr] as const),
  ),
);

class RecordingRpc extends RpcClient {
  readonly accounts = new Map<string, bigint>();
  /** Every transaction the network accepted, in order. */
  readonly submissions: { label: string; tx: Transaction | FeeBumpTransaction }[] = [];
  /** Set to make the next submission fail the way a network rejection does. */
  rejectNext: MavnaError | undefined;
  /**
   * While set, accepted transactions wait unincluded until `includePending`,
   * the way a busy network leaves them in its queue.
   */
  holdInclusion = false;

  /** USDC trustline balances in stroops, by account. */
  readonly trustlines = new Map<string, bigint>();
  /** USDC promised to the account's own open offers, in stroops, by account. */
  readonly sellingLiabilities = new Map<string, bigint>();
  /** XLM balances in stroops, by account; ten XLM when not set. */
  readonly nativeBalances = new Map<string, bigint>();

  private readonly landed = new Map<string, rpc.Api.GetSuccessfulTransactionResponse>();
  private readonly pending = new Map<string, Transaction | FeeBumpTransaction>();
  /** What each transaction was submitted as, by hash. */
  private readonly labels = new Map<string, string>();
  /** Sends held back before they reach the network, by label. */
  private readonly stalls = new Map<string, () => Promise<void>>();

  constructor() {
    // the pause between polls yields to the event loop and nothing more
    super({ url: NOWHERE, baseDelayMs: 0, sleep: () => new Promise((r) => setImmediate(r)) });
    // The ledger read every balance check goes through, answered from the maps
    // above instead of a node.
    this.server.getLedgerEntries = async (...keys: xdr.LedgerKey[]) => ({
      latestLedger: 1,
      entries: keys.flatMap((key) => {
        const val = this.entryFor(key);
        return val === undefined ? [] : [{ key, val, lastModifiedLedgerSeq: 1 }];
      }),
    });
    // the endpoint's compose_queue, the one contract read the compose path makes
    this.server.simulateTransaction = (async (tx: Transaction) => {
      const op = tx.operations[0] as Operation.InvokeHostFunction | undefined;
      const call =
        op?.func.type === "hostFunctionTypeInvokeContract" ? op.func.invokeContract : undefined;
      if (call?.functionName.toString() !== "compose_queue") {
        return { error: "this node only answers compose_queue", latestLedger: 1 };
      }
      const guidArg = call.args[2];
      const guid =
        guidArg?.type === "scvBytes" ? xdr.encodeBytes(guidArg.bytes.toBytes(), "hex") : "";
      const slot = this.queuedComposes.get(guid);
      return {
        latestLedger: 1,
        result: {
          retval: slot === undefined ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(slot),
          auth: [],
        },
      };
    }) as never;
    this.server.sendTransaction = async (tx) => {
      const label = this.labels.get(xdr.encodeBytes(tx.hash(), "hex"));
      const stall = label === undefined ? undefined : this.stalls.get(label);
      if (label !== undefined && stall !== undefined) {
        this.stalls.delete(label);
        await stall();
      }
      return this.send(tx);
    };
    this.server.getNetwork = async () =>
      ({ passphrase: this.networkPassphrase, protocolVersion: 23 }) as never;
    this.server.getTransaction = async (hash) =>
      this.landed.get(hash) ?? {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        txHash: hash,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      };
  }

  /** The network the node says it serves. */
  networkPassphrase: string = Networks.TESTNET;

  /** Compose slots LayerZero's endpoint holds, by guid hex: the message hash in each. */
  readonly queuedComposes = new Map<string, Buffer>();

  private entryFor(key: xdr.LedgerKey): xdr.LedgerEntryData | undefined {
    // the Arrival Contract's own storage, replayed from a testnet recording
    const recorded = RECORDED_CONTRACT_ENTRIES.get(key.toXdr("base64"));
    if (recorded !== undefined) return xdr.LedgerEntryData.fromXdr(recorded, "base64");
    if (key.type === "account") {
      const accountId = key.account.accountId;
      const holder = StrKey.encodeEd25519PublicKey(accountId.ed25519.toBytes());
      const sequence = this.accounts.get(holder);
      if (sequence === undefined) return undefined;
      return xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId,
          balance: this.nativeBalances.get(holder) ?? 100_000_000n,
          seqNum: xdr.Int64.fromString(sequence.toString()),
          numSubEntries: 1,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        }),
      );
    }
    if (key.type === "trustline") {
      const line = key.trustLine;
      if (line.asset.toXdr("hex") !== USDC.toTrustLineXdrObject().toXdr("hex")) return undefined;
      const holder = StrKey.encodeEd25519PublicKey(line.accountId.ed25519.toBytes());
      const balance = this.trustlines.get(holder);
      if (balance === undefined) return undefined;
      const selling = this.sellingLiabilities.get(holder);
      return xdr.LedgerEntryData.trustline(
        new xdr.TrustLineEntry({
          accountId: line.accountId,
          asset: line.asset,
          balance: xdr.Int64.fromString(balance.toString()),
          limit: xdr.Int64.fromString("9223372036854775807"),
          flags: 1,
          ext:
            selling === undefined
              ? xdr.TrustLineEntryExt.v0()
              : xdr.TrustLineEntryExt.v1(
                  new xdr.TrustLineEntryV1({
                    liabilities: new xdr.Liabilities({
                      buying: xdr.Int64.fromString("0"),
                      selling: xdr.Int64.fromString(selling.toString()),
                    }),
                    ext: xdr.TrustLineEntryV1Ext.v0(),
                  }),
                ),
        }),
      );
    }
    return undefined;
  }

  /** The user's account after the preparation landed and a delivery arrived. */
  holding(user: Keypair, usdcStroops: bigint): void {
    if (!this.accounts.has(user.publicKey())) this.accounts.set(user.publicKey(), 1n);
    this.trustlines.set(user.publicKey(), usdcStroops);
  }

  /** Simulation is a network call; what it would add does not matter to these tests. */
  override async prepare(tx: Transaction): Promise<Transaction> {
    return tx;
  }

  override async submit(
    label: string,
    build: () => Promise<Transaction | FeeBumpTransaction>,
    options?: SubmitOptions,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const rejection = this.rejectNext;
    if (rejection !== undefined) {
      await build();
      this.rejectNext = undefined;
      throw rejection;
    }
    const labelled = async () => {
      const tx = await build();
      this.labels.set(xdr.encodeBytes(tx.hash(), "hex"), label);
      return tx;
    };
    return super.submit(label, labelled, options);
  }

  /**
   * Hold the next transaction submitted under this label before it reaches the
   * network, the way a slow connection does, until released.
   */
  stallNext(label: string): { reached: Promise<void>; release: () => void } {
    let release: () => void = () => {};
    let arrived: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    this.stalls.set(label, async () => {
      arrived();
      await gate;
    });
    return { reached, release };
  }

  /** Let every transaction the network has queued land, in order. */
  includePending(): void {
    const queued = [...this.pending.values()];
    this.pending.clear();
    for (const tx of queued) this.apply(tx);
  }

  private send(tx: Transaction | FeeBumpTransaction): rpc.Api.SendTransactionResponse {
    const hash = xdr.encodeBytes(tx.hash(), "hex");
    const base = { hash, latestLedger: 1, latestLedgerCloseTime: 0 };
    // Only a queued transaction is a duplicate. One that landed has spent its
    // sequence, and the network answers a resend of it with txBadSeq.
    if (this.pending.has(hash)) return { ...base, status: "DUPLICATE" };
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const current = this.accounts.get(inner.source);
    if (current === undefined) return this.refused(base, "txNoAccount");
    if (BigInt(inner.sequence) !== current + 1n) return this.refused(base, "txBadSeq");
    this.submissions.push({ label: this.labels.get(hash) ?? "unlabelled", tx });
    if (this.holdInclusion) this.pending.set(hash, tx);
    else this.apply(tx);
    return { ...base, status: "PENDING" };
  }

  private refused(
    base: { hash: string; latestLedger: number; latestLedgerCloseTime: number },
    code: "txBadSeq" | "txNoAccount",
  ): rpc.Api.SendTransactionResponse {
    return {
      ...base,
      status: "ERROR",
      errorResult: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult[code](),
        ext: xdr.TransactionResultExt.v0(),
      }),
    };
  }

  /** What landing means here: the sequence is spent and any new account exists. */
  private apply(tx: Transaction | FeeBumpTransaction): void {
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const current = this.accounts.get(inner.source);
    if (current === undefined || BigInt(inner.sequence) !== current + 1n) return;
    this.accounts.set(inner.source, BigInt(inner.sequence));
    for (const op of inner.operations) {
      if (op.type === "createAccount" && !this.accounts.has(op.destination)) {
        this.accounts.set(op.destination, 1n << 32n);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const hash = xdr.encodeBytes(tx.hash(), "hex");
    this.landed.set(hash, {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: hash,
      latestLedger: 1,
      latestLedgerCloseTime: now,
      oldestLedger: 1,
      oldestLedgerCloseTime: now,
      ledger: 1,
      createdAt: now,
      applicationOrder: 1,
      feeBump: "innerTransaction" in tx,
      envelopeXdr: tx.toEnvelope(),
      resultXdr: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString(tx.fee),
        result: xdr.TransactionResultResult.txSuccess([]),
        ext: xdr.TransactionResultExt.v0(),
      }),
      resultMetaXdr: xdr.TransactionMeta.operations([]),
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    });
  }
}

/** One XLM for half a USDC, so the settlement ceiling is a fixed number. */
class FixedPrice extends XlmPriceSource {
  constructor() {
    super({ horizonUrl: NOWHERE });
  }

  override async xlmStroopsPerUnit(): Promise<bigint> {
    return 50_000_000n;
  }
}

/**
 * Horizon's quote for the settlement's direct path, answered here: by default
 * the fixed price above (five XLM a USDC), or `quote` when a test sets it,
 * null for a market with no direct path.
 */
class FixedSpend extends DirectSpendQuote {
  quote: bigint | null | undefined = undefined;
  constructor() {
    super({ horizonUrl: "https://127.0.0.1:9" });
  }

  override async directSpendStroops(_asset: Asset, destXlm: string): Promise<bigint | undefined> {
    if (this.quote === null) return undefined;
    if (this.quote !== undefined) return this.quote;
    const [whole = "0", fraction = ""] = destXlm.split(".");
    return (BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"))) / 5n;
  }
}

/** Horizon's view of what the sponsor carries, answered here. */
class FixedSponsorshipView implements ChainSponsorshipView {
  slots = 0;
  accounts: string[] = [];
  async totalSlotsCarried(): Promise<number> {
    return this.slots;
  }
  async sponsoredAccounts(): Promise<readonly string[]> {
    return this.accounts;
  }
}

interface TestServer {
  readonly server: SponsorServer;
  readonly url: string;
  readonly rpc: RecordingRpc;
  readonly sponsor: Keypair;
  readonly channel: Keypair;
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Body }>;
  /** A body sent exactly as given, for input no well-behaved client would produce. */
  postRaw(path: string, text: string): Promise<{ status: number; body: Body }>;
}

type Body = Record<string, unknown>;

const running: { close(): void }[] = [];

afterEach(() => {
  for (const server of running.splice(0)) server.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Move the server's clock past a settlement's whole validity window. */
function skipPastSettlementWindow(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 86_400_000 + 60_000);
}

/**
 * Stand in for Circle's attestation service, and only it: every other request,
 * including the tests' own calls to the server, goes to the real fetch.
 */
function stubIris(answer: (url: URL) => Response | Promise<Response>): URL[] {
  const asked: URL[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== IRIS) return realFetch(input, init);
    asked.push(url);
    return Promise.resolve().then(() => answer(url));
  });
  return asked;
}

async function startServer(
  overrides: Partial<SponsorServerOptions> = {},
  {
    fundsOwnChannel = false,
    restartOf,
  }: {
    /** Leave out the harness's channel, so the server funds its own on first use. */
    fundsOwnChannel?: boolean;
    /**
     * Start as the same deployment after a restart: same network, sponsor key
     * and channel key, nothing carried over in memory. Pass the same `state`
     * to carry over what was written down.
     */
    restartOf?: TestServer;
  } = {},
): Promise<TestServer> {
  const sponsor = restartOf?.sponsor ?? Keypair.random();
  const channel = restartOf?.channel ?? Keypair.random();
  const recording = restartOf?.rpc ?? new RecordingRpc();
  if (restartOf === undefined) {
    recording.accounts.set(sponsor.publicKey(), 100n);
    recording.accounts.set(channel.publicKey(), 200n);
  }

  const options: SponsorServerOptions = {
    rpc: recording,
    network,
    networkId: "testnet",
    sponsorSecret: sponsor.secret(),
    curatedAssets: { USDC },
    buildDelivery: () => {
      throw new Error("delivery is not exercised by these tests");
    },
    irisUrl: IRIS,
    channels: new ChannelPool({ channels: [channel] }),
    prices: new FixedPrice(),
    spendQuote: new FixedSpend(),
    sponsorshipView: new FixedSponsorshipView(),
    allowedOrigins: [],
    ...overrides,
  };
  if (fundsOwnChannel) delete (options as { channels?: ChannelPool }).channels;
  const server = createSponsorServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const postRaw = async (path: string, text: string) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    return { status: response.status, body: (await response.json()) as Body };
  };

  return {
    server,
    url,
    rpc: recording,
    sponsor,
    channel,
    post: (path, body) => postRaw(path, JSON.stringify(body)),
    postRaw,
  };
}

function signXdr(xdrText: string, ...signers: Keypair[]): string {
  const tx = TransactionBuilder.fromXdr(xdrText, network.passphrase) as Transaction;
  for (const signer of signers) tx.sign(signer);
  return tx.toXdr();
}

/** The honest flow up to a held settlement, as the app runs it. */
async function holdSettlementFor(server: TestServer, user: Keypair): Promise<void> {
  const built = await server.post("/settlement", {
    destination: user.publicKey(),
    sourceChainId: "1",
  });
  expect(built.status).toBe(200);
  const committed = await server.post("/settlement/commit", {
    destination: user.publicKey(),
    signedXdr: signXdr(built.body.xdr as string, user),
  });
  expect(committed.status).toBe(200);
}

/**
 * The honest flow up to a landed preparation, the point at which a settlement
 * may fire. What it submitted is cleared, so a test sees only what follows.
 */
async function preparedWithSettlementHeld(server: TestServer, user: Keypair): Promise<void> {
  await holdSettlementFor(server, user);
  const submitted = await server.post("/submit", {
    signedXdr: await preparedAndSigned(server, user),
  });
  expect(submitted.status).toBe(200);
  server.rpc.submissions.splice(0);
}

async function preparedAndSigned(server: TestServer, user: Keypair): Promise<string> {
  const built = await server.post("/prepare", {
    destination: user.publicKey(),
    assets: ["USDC"],
    sourceChainId: "1",
  });
  expect(built.status).toBe(200);
  return signXdr(built.body.xdr as string, user);
}

describe("the sponsor only countersigns what it built", () => {
  it("refuses a forged preparation that would pay an attacker", async () => {
    const server = await startServer();
    const attacker = Keypair.random();

    // A settlement of the attacker's own making, so the old "is one held" check
    // is satisfied without the sponsor ever having built anything.
    const junk = new TransactionBuilder(new Account(attacker.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: network.passphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: USDC,
          sendMax: "1",
          destination: attacker.publicKey(),
          destAsset: Asset.native(),
          destAmount: "1",
          path: [],
        }),
      )
      .setTimeout(300)
      .build();
    junk.sign(attacker);
    await server.post("/settlement/commit", {
      destination: attacker.publicKey(),
      signedXdr: junk.toXdr(),
    });

    const sponsorAccount = await server.rpc.loadAccount(server.sponsor.publicKey());
    const forged = new TransactionBuilder(sponsorAccount, {
      fee: "100",
      networkPassphrase: network.passphrase,
    })
      .addOperation(
        Operation.createAccount({ destination: attacker.publicKey(), startingBalance: "10000" }),
      )
      .setTimeout(300)
      .build();

    const response = await server.post("/submit", { signedXdr: forged.toXdr() });
    expect(response.status).toBe(409);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses to hold a settlement it did not build", async () => {
    const server = await startServer();
    const victim = Keypair.random();

    const sponsorAccount = await server.rpc.loadAccount(server.sponsor.publicKey());
    const forged = new TransactionBuilder(sponsorAccount, {
      fee: "100",
      networkPassphrase: network.passphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: "10000",
          destination: Keypair.random().publicKey(),
          destAsset: Asset.native(),
          destAmount: "10000",
          path: [],
        }),
      )
      .setTimeout(300)
      .build();

    const response = await server.post("/settlement/commit", {
      destination: victim.publicKey(),
      signedXdr: forged.toXdr(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      "That settlement was not built here, or has expired. Ask for a new one.",
    );

    // Nothing is held: an honest preparation for the same account is still
    // refused for want of a settlement.
    const prepared = await preparedAndSigned(server, victim);
    const submitted = await server.post("/submit", { signedXdr: prepared });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses to hold one person's settlement under another's account", async () => {
    const server = await startServer();
    const attacker = Keypair.random();
    const victim = Keypair.random();

    const built = await server.post("/settlement", {
      destination: attacker.publicKey(),
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);

    const response = await server.post("/settlement/commit", {
      destination: victim.publicKey(),
      signedXdr: signXdr(built.body.xdr as string, attacker),
    });
    expect(response.status).toBe(400);

    const prepared = await preparedAndSigned(server, victim);
    const submitted = await server.post("/submit", { signedXdr: prepared });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("countersigns and submits the transactions it built and the user signed", async () => {
    const server = await startServer();
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    const response = await server.post("/submit", { signedXdr: prepared });

    expect(response.status).toBe(200);
    expect(server.rpc.submissions).toHaveLength(1);
    const submitted = server.rpc.submissions[0]?.tx as Transaction;
    expect(response.body.txHash).toBe(xdr.encodeBytes(submitted.hash(), "hex"));
    expect(signedBy(submitted, server.sponsor.publicKey())).toBe(true);
    expect(signedBy(submitted, user.publicKey())).toBe(true);
  });

  it("countersigns a preparation only once", async () => {
    const server = await startServer();
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    expect((await server.post("/submit", { signedXdr: prepared })).status).toBe(200);

    const again = await server.post("/submit", { signedXdr: prepared });
    expect(again.status).toBe(409);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("refuses to hold a settlement the user has not signed", async () => {
    const server = await startServer();
    const user = Keypair.random();

    const built = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);

    const response = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: built.body.xdr as string,
    });
    expect(response.status).toBe(400);

    const prepared = await preparedAndSigned(server, user);
    const submitted = await server.post("/submit", { signedXdr: prepared });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);
  });
  it("holds the same settlement once it comes back signed", async () => {
    const server = await startServer();
    const user = Keypair.random();

    const built = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    const unsigned = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: built.body.xdr as string,
    });
    expect(unsigned.status).toBe(400);

    const signed = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(built.body.xdr as string, user),
    });
    expect(signed.status).toBe(200);
  });

  it("submits a preparation that arrived before its settlement, once the settlement is held", async () => {
    const server = await startServer();
    const user = Keypair.random();

    const prepared = await preparedAndSigned(server, user);
    const early = await server.post("/submit", { signedXdr: prepared });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);

    await holdSettlementFor(server, user);
    const later = await server.post("/submit", { signedXdr: prepared });
    expect(later.status).toBe(200);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("re-checks the cap at submission, and submits once the cap allows it", async () => {
    let day = "2026-10-19";
    const caps = new CapLedger(
      new InMemoryCapStore(),
      { strandingCapPerDay: 75, volumeCapPerDay: { "expensive-gas": 1, "cheap-gas": 1 } },
      () => day,
    );
    const server = await startServer({ caps });
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    // Another sponsorship takes today's last slot in the tighter allocation, the
    // one every claim counts against
    // between this user's preparation and their signature coming back.
    await caps.recordStarted("cheap-gas");

    const refused = await server.post("/submit", { signedXdr: prepared });
    expect(refused.status).toBe(429);
    expect(server.rpc.submissions).toHaveLength(0);

    day = "2026-10-20";
    const allowed = await server.post("/submit", { signedXdr: prepared });
    expect(allowed.status).toBe(200);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("refuses a preparation the user has not signed", async () => {
    const server = await startServer();
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const built = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    const response = await server.post("/submit", { signedXdr: built.body.xdr as string });
    expect(response.status).toBe(400);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("does not tell an unsigned probe whether a settlement is held", async () => {
    const server = await startServer();
    const victim = Keypair.random();

    // No settlement is held for the victim. The answer must be the same 400 an
    // unsigned body gets when one is, or the status leaks which accounts are
    // mid-transfer.
    const built = await server.post("/prepare", {
      destination: victim.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    const response = await server.post("/submit", { signedXdr: built.body.xdr as string });
    expect(response.status).toBe(400);
    expect(response.body.error).not.toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("does not offer a preparation again after the network refused it", async () => {
    const server = await startServer();
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    server.rpc.rejectNext = new MavnaError("sponsored preparation was rejected: txBadSeq", {
      retryable: false,
    });
    const failed = await server.post("/submit", { signedXdr: prepared });
    expect(failed.status).toBe(502);

    const again = await server.post("/submit", { signedXdr: prepared });
    expect(again.status).toBe(409);
    expect(server.rpc.submissions).toHaveLength(0);
  });
});

describe("the sponsor turns away malformed input before doing any work", () => {
  it("refuses a body larger than it will read", async () => {
    const server = await startServer();
    const response = await server.postRaw(
      "/submit",
      JSON.stringify({ signedXdr: "A".repeat(70 * 1024) }),
    );
    expect(response.status).toBe(413);
    expect(response.body.retryable).toBe(false);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("answers a body that is not JSON with 400", async () => {
    const server = await startServer();
    const response = await server.postRaw("/submit", "{");
    expect(response.status).toBe(400);
    expect(response.body.retryable).toBe(false);
  });

  it("answers JSON that is not an object with 400", async () => {
    const server = await startServer();
    const response = await server.postRaw("/submit", "null");
    expect(response.status).toBe(400);
  });

  it("answers a submission that is not a transaction with 400", async () => {
    const server = await startServer();
    const response = await server.post("/submit", { signedXdr: "not a transaction" });
    expect(response.status).toBe(400);
    expect(response.body.retryable).toBe(false);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("answers a settlement that is not a transaction with 400", async () => {
    const server = await startServer();
    const response = await server.post("/settlement/commit", {
      destination: Keypair.random().publicKey(),
      signedXdr: "not a transaction",
    });
    expect(response.status).toBe(400);
    expect(response.body.retryable).toBe(false);
  });
});

describe("the sponsor only asks Circle about well-formed deliveries", () => {
  const EVM_HASH = `0x${"ab".repeat(32)}`;
  const SOLANA_SIGNATURE =
    "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
  const notFound = () => new Response("{}", { status: 404 });

  it("refuses a transaction hash that is not one", async () => {
    const asked = stubIris(notFound);
    const server = await startServer();
    for (const txHash of ["abc", "0xZZ", `${EVM_HASH}&domain=7`, "../../v1/x", 42]) {
      const response = await server.post("/deliver", { txHash, domain: 0 });
      expect(response.status, String(txHash)).toBe(400);
      expect(response.body.retryable).toBe(false);
    }
    expect(asked).toHaveLength(0);
  });

  it("refuses a domain this network does not route from", async () => {
    const asked = stubIris(notFound);
    const server = await startServer();
    for (const domain of [undefined, "0", 1.5, -1, 4, 27, 9999]) {
      const response = await server.post("/deliver", { txHash: EVM_HASH, domain });
      expect(response.status, String(domain)).toBe(400);
    }
    expect(asked).toHaveLength(0);
  });

  it("checks the domain against the configured network only", async () => {
    // Worked out from the chain lists as they are, so adding a chain to one
    // network does not quietly turn this into a test of nothing.
    const domainsOf = (id: "testnet" | "mainnet"): Set<number> =>
      new Set(
        [...Object.values(EVM_DEPLOYMENTS[id]), ...Object.values(NON_EVM_CHAINS[id])].map(
          (chain) => chain.domain,
        ),
      );
    const lists = { testnet: domainsOf("testnet"), mainnet: domainsOf("mainnet") };
    const asked = stubIris(notFound);
    const servers = {
      testnet: await startServer(),
      mainnet: await startServer({ networkId: "mainnet" }),
    };
    const post = (id: "testnet" | "mainnet", domain: number) =>
      servers[id].post("/deliver", { txHash: EVM_HASH, domain });

    let neither = 0;
    while (lists.testnet.has(neither) || lists.mainnet.has(neither)) neither += 1;
    expect((await post("testnet", neither)).status).toBe(400);
    expect((await post("mainnet", neither)).status).toBe(400);

    let askedExpected = 0;
    for (const [here, there] of [
      ["testnet", "mainnet"],
      ["mainnet", "testnet"],
    ] as const) {
      const onlyHere = [...lists[here]].find((domain) => !lists[there].has(domain));
      if (onlyHere === undefined) continue;
      // routed where it is listed, refused where it is not, never the union
      expect((await post(here, onlyHere)).status).toBe(404);
      expect((await post(there, onlyHere)).status).toBe(400);
      askedExpected += 1;
    }
    expect(asked).toHaveLength(askedExpected);
  });

  it("asks Circle for exactly the transaction it was given", async () => {
    const asked = stubIris(notFound);
    const server = await startServer();
    await server.post("/deliver", { txHash: SOLANA_SIGNATURE, domain: 5 });
    await server.post("/deliver", { txHash: "0x4a5b", domain: 25 });
    expect(asked.map((url) => url.toString())).toEqual([
      `${IRIS}/v2/messages/5?transactionHash=${SOLANA_SIGNATURE}`,
      `${IRIS}/v2/messages/25?transactionHash=0x4a5b`,
    ]);
  });

  it("says not yet when Circle has no record", async () => {
    stubIris(notFound);
    const server = await startServer();
    const response = await server.post("/deliver", { txHash: EVM_HASH, domain: 0 });
    expect(response.status).toBe(404);
    expect(response.body.retryable).toBe(true);
  });

  it("answers 502 when Circle fails", async () => {
    stubIris(() => new Response("upstream down", { status: 503 }));
    const server = await startServer();
    const response = await server.post("/deliver", { txHash: EVM_HASH, domain: 0 });
    expect(response.status).toBe(502);
    expect(response.body.retryable).toBe(true);
  });

  it("answers 502 when Circle cannot be reached or does not answer in time", async () => {
    for (const failure of [
      new TypeError("fetch failed"),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]) {
      stubIris(() => Promise.reject(failure));
      const server = await startServer();
      const response = await server.post("/deliver", { txHash: EVM_HASH, domain: 0 });
      expect(response.status, failure.name).toBe(502);
      expect(response.body.retryable).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it("answers 502 when Circle answers with something that is not JSON", async () => {
    stubIris(() => new Response("<html>maintenance</html>", { status: 200 }));
    const server = await startServer();
    const response = await server.post("/deliver", { txHash: EVM_HASH, domain: 0 });
    expect(response.status).toBe(502);
    expect(response.body.retryable).toBe(true);
  });
});

/** Fields of a CCTP message a test may forge, as hex. Anything left out is honest. */
interface MessageOverrides {
  readonly sourceDomain?: number;
  readonly destinationDomain?: number;
  readonly sender?: string;
  readonly headerRecipient?: string;
  readonly destinationCaller?: string;
  readonly mintRecipient?: string;
  readonly amount?: bigint;
  readonly feeExecuted?: bigint;
}

/**
 * A CCTP v2 message as Iris returns it for a burn on Ethereum Sepolia, laid out
 * per Circle's MessageV2 (body at byte 148) and BurnMessageV2 (hook data at byte
 * 228 of the body). The burn fields come from this repository's own builder;
 * the header names the source TokenMessenger as sender and Stellar's
 * TokenMessengerMinter as recipient, as Circle's transmitter writes them.
 */
function cctpMessage(recipient: string, overrides: MessageOverrides = {}): string {
  const burn = buildBurn({
    amount: 1_000_000n,
    stellarRecipient: recipient,
    network: "testnet",
    sourceChainId: "ethereum-sepolia",
    maxFee: 100n,
  });
  const [amount, , mintRecipient, burnToken, destinationCaller, maxFee, finality, hookData] =
    burn.args;
  const word = (hex: string): Buffer =>
    Buffer.from(hex.replace(/^0x/, "").padStart(64, "0"), "hex");

  const header = Buffer.alloc(148);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(overrides.sourceDomain ?? 0, 4);
  header.writeUInt32BE(overrides.destinationDomain ?? 27, 8);
  Buffer.from(Keypair.random().rawPublicKey()).copy(header, 12);
  word(
    overrides.sender ?? EVM_DEPLOYMENTS.testnet["ethereum-sepolia"]?.tokenMessengerV2 ?? "",
  ).copy(header, 44);
  word(
    overrides.headerRecipient ??
      toHex(contractAddressToBytes32(CCTP_CONTRACTS.testnet.tokenMessengerMinter)),
  ).copy(header, 76);
  word(overrides.destinationCaller ?? destinationCaller).copy(header, 108);
  header.writeUInt32BE(finality, 140);
  header.writeUInt32BE(finality, 144);

  const body = Buffer.alloc(228);
  body.writeUInt32BE(1, 0);
  word(burnToken).copy(body, 4);
  word(overrides.mintRecipient ?? mintRecipient).copy(body, 36);
  word((overrides.amount ?? amount).toString(16)).copy(body, 68);
  word(maxFee.toString(16)).copy(body, 132);
  word((overrides.feeExecuted ?? 0n).toString(16)).copy(body, 164);

  return `0x${Buffer.concat([header, body, Buffer.from(hookData.slice(2), "hex")]).toString("hex")}`;
}

describe("the sponsor settles only for the recipient Circle attested", () => {
  const BURN = `0x${"cd".repeat(32)}`;
  const ATTESTATION = `0x${"ef".repeat(65)}`;

  function irisReturns(messageHex: string): void {
    stubIris(
      () =>
        new Response(
          JSON.stringify({
            messages: [{ message: messageHex, attestation: ATTESTATION, status: "complete" }],
          }),
          { status: 200 },
        ),
    );
  }

  it("settles for the recipient named inside the attested message", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    irisReturns(cctpMessage(user.publicKey()));

    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("delivered");
    expect(response.body.settled).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery", "settlement"]);
  });

  it("says a delivery that failed on Stellar may have cost its fee, not that nothing was spent", async () => {
    const server = await startServer({ buildDelivery });
    irisReturns(cctpMessage(Keypair.random().publicKey()));
    server.rpc.server.getTransaction = async (hash) =>
      ({ status: rpc.Api.GetTransactionStatus.FAILED, txHash: hash, latestLedger: 2 }) as never;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    logged.mockRestore();
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/reached Stellar and failed there/);
    expect(response.body.error).not.toMatch(/Nothing was spent/);
  });

  it("pays for no delivery past its daily budget, and says to try again later", async () => {
    // room for one delivery's worst case (its 1 XLM bid plus 1 XLM of resources), not two
    const state = new MemoryDocumentStore();
    const server = await startServer({ buildDelivery, state, deliveryBudgetStroops: 25_000_000n });
    irisReturns(cctpMessage(Keypair.random().publicKey()));

    const first = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("delivered");
    // what it was charged is what counts, here its whole 1 XLM bid
    const spent = (await state.read("delivery-spend")) as Record<string, string>;
    expect(Object.values(spent)).toEqual(["10000000"]);

    const second = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(second.status).toBe(503);
    expect(second.body.retryable).toBe(true);
    expect(second.body.error).toMatch(/today's budget/);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
  });

  it("delivers but settles nothing for a destination the message does not name", async () => {
    const server = await startServer({ buildDelivery });
    const victim = Keypair.random();
    await preparedWithSettlementHeld(server, victim);
    server.rpc.holding(victim, PLENTY);
    irisReturns(cctpMessage(Keypair.random().publicKey()));

    const response = await server.post("/deliver", {
      txHash: BURN,
      domain: 0,
      destination: victim.publicKey(),
    });
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("delivered");
    expect(response.body.settled).not.toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);

    // The victim's settlement is still held for their own delivery.
    irisReturns(cctpMessage(victim.publicKey()));
    const own = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(own.body.settled).toBe(true);
  });

  it("settles for honest burns from Solana and Starknet, whose senders are not EVM addresses", async () => {
    const server = await startServer({ buildDelivery });
    const solanaUser = Keypair.random();
    const starknetUser = Keypair.random();

    // One channel in the harness, so one held settlement at a time.
    await preparedWithSettlementHeld(server, solanaUser);
    server.rpc.holding(solanaUser, PLENTY);
    irisReturns(
      cctpMessage(solanaUser.publicKey(), {
        sourceDomain: 5,
        sender: toHex(solanaAddressToBytes32(SOLANA_PROGRAMS.tokenMessengerMinterV2)),
      }),
    );
    const fromSolana = await server.post("/deliver", {
      txHash:
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
      domain: 5,
    });
    expect(fromSolana.body.settled).toBe(true);

    await preparedWithSettlementHeld(server, starknetUser);

    server.rpc.holding(starknetUser, PLENTY);
    irisReturns(
      cctpMessage(starknetUser.publicKey(), {
        sourceDomain: 25,
        sender: STARKNET_DEPLOYMENTS.testnet.tokenMessengerMinterV2,
      }),
    );
    const fromStarknet = await server.post("/deliver", { txHash: "0x4a5b", domain: 25 });
    expect(fromStarknet.body.settled).toBe(true);
  });

  // Each of these is a message Circle would sign for somebody's burn, but not a
  // burn that pays the named recipient through the forwarder. Settling on one
  // would fire the recipient's settlement before their money exists.
  const forged: readonly [string, MessageOverrides][] = [
    ["no destination caller", { destinationCaller: `0x${"00".repeat(32)}` }],
    ["a mint recipient other than the forwarder", { mintRecipient: `0x${"11".repeat(32)}` }],
    ["a sender that is not the source TokenMessenger", { sender: `0x${"22".repeat(20)}` }],
    [
      "a header recipient that is not Stellar's TokenMessenger",
      { headerRecipient: `0x${"33".repeat(32)}` },
    ],
    ["a source domain other than the one asked about", { sourceDomain: 6 }],
  ];
  for (const [name, overrides] of forged) {
    it(`delivers but settles nothing on a message with ${name}`, async () => {
      const server = await startServer({ buildDelivery });
      const user = Keypair.random();
      await preparedWithSettlementHeld(server, user);
      server.rpc.holding(user, PLENTY);
      irisReturns(cctpMessage(user.publicKey(), overrides));

      const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
      expect(response.status).toBe(200);
      expect(response.body.kind).toBe("delivered");
      expect(response.body.settled).not.toBe(true);
      expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
    });
  }

  it("does not settle until the recipient holds what the settlement spends", async () => {
    // An honest message for a dust amount: Circle attests it and the delivery
    // lands, but the user's settlement would fail on-chain and strand.
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, 1n);
    irisReturns(cctpMessage(user.publicKey()));

    const dust = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(dust.status).toBe(200);
    expect(dust.body.kind).toBe("delivered");
    expect(dust.body.settled).toBe(false);
    expect(dust.body.settlementRetryable).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);

    // Still held, and settled once the real transfer has arrived.
    server.rpc.holding(user, PLENTY);
    const arrived = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(arrived.body.settled).toBe(true);
  });

  it("does not settle before the recipient's preparation has landed", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    server.rpc.holding(user, PLENTY);
    irisReturns(cctpMessage(user.publicKey()));

    const early = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(early.status).toBe(200);
    expect(early.body.kind).toBe("delivered");
    expect(early.body.settled).toBe(false);
    expect(early.body.settlementRetryable).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
  });

  it("settles nothing on a message not bound for Stellar", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    irisReturns(cctpMessage(user.publicKey(), { destinationDomain: 6 }));

    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.body.settled).not.toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
  });
});

describe("the sponsor forgets a held settlement once it can no longer land", () => {
  it("refuses to sponsor against a settlement past its time bound", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);

    skipPastSettlementWindow();
    const prepared = await preparedAndSigned(server, user);
    const response = await server.post("/submit", { signedXdr: prepared });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(NO_SETTLEMENT);
    expect(server.rpc.submissions).toHaveLength(0);

    // Its channel is free for the next person.
    const next = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);
  });

  it("does not free a newer settlement's channel when dropping an expired one", async () => {
    const server = await startServer();
    const a = Keypair.random();
    const b = Keypair.random();
    await holdSettlementFor(server, a);

    // A's first settlement expires unsettled, and A asks for a new one, which
    // takes the channel again under a new lease.
    skipPastSettlementWindow();
    const second = await server.post("/settlement", {
      destination: a.publicKey(),
      sourceChainId: "1",
    });
    expect(second.status).toBe(200);

    // Anything that looks at A's held settlement now finds the expired one.
    const prepared = await preparedAndSigned(server, a);
    expect((await server.post("/submit", { signedXdr: prepared })).body.error).toBe(NO_SETTLEMENT);

    // The channel still carries A's second settlement, so B must not get it.
    const forB = await server.post("/settlement", {
      destination: b.publicKey(),
      sourceChainId: "1",
    });
    expect(forB.status).toBe(503);

    const committed = await server.post("/settlement/commit", {
      destination: a.publicKey(),
      signedXdr: signXdr(second.body.xdr as string, a),
    });
    expect(committed.status).toBe(200);
  });

  it("counts a prepared settlement that expired unsettled as stranded", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const pool = [Keypair.random(), Keypair.random()];
    const server = await startServer({ caps, channels: new ChannelPool({ channels: pool }) });
    for (const channel of pool) server.rpc.accounts.set(channel.publicKey(), 300n);
    const prepared = Keypair.random();
    const unprepared = Keypair.random();
    // Prepared and never funded: the sponsor's reserve is out and nothing repays it.
    await preparedWithSettlementHeld(server, prepared);
    // Held but never prepared: nothing was lent, so nothing is lost.
    await holdSettlementFor(server, unprepared);

    skipPastSettlementWindow();
    expect((await server.post("/settle", { destination: prepared.publicKey() })).status).toBe(404);
    expect((await server.post("/settle", { destination: unprepared.publicKey() })).status).toBe(
      404,
    );
    expect((await caps.usage()).stranded).toBe(1);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("does not submit an expired settlement when the delivery lands", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    skipPastSettlementWindow();
    stubIris(
      () =>
        new Response(
          JSON.stringify({
            messages: [
              { message: cctpMessage(user.publicKey()), attestation: `0x${"ef".repeat(65)}` },
            ],
          }),
          { status: 200 },
        ),
    );
    const response = await server.post("/deliver", { txHash: `0x${"cd".repeat(32)}`, domain: 0 });
    expect(response.status).toBe(200);
    expect(response.body.settled).toBe(false);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
  });
});

describe("any rail can trigger a held settlement", () => {
  const NOT_HELD = "No settlement is held for that account.";

  it("submits the held settlement once the preparation landed and the money arrived", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    const response = await server.post("/settle", { destination: user.publicKey() });
    expect(response.status).toBe(200);
    expect(response.body.settled).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
    const submitted = server.rpc.submissions[0]?.tx as Transaction;
    expect(response.body.settlementTxHash).toBe(xdr.encodeBytes(submitted.hash(), "hex"));
    expect(signedBy(submitted, user.publicKey())).toBe(true);
    expect(signedBy(submitted, server.channel.publicKey())).toBe(true);
    expect(signedBy(submitted, server.sponsor.publicKey())).toBe(true);

    // Settled means no longer held, and asking again reports the repayment
    // that landed rather than submitting anything.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const again = await server.post("/settle", { destination: user.publicKey() });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ settled: true, settlementTxHash: response.body.settlementTxHash });
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("answers one call per account every 30 seconds", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, 1n);

    const first = await server.post("/settle", { destination: user.publicKey() });
    expect(first.status).toBe(200);
    expect(first.body.settled).toBe(false);
    expect(first.body.settlementRetryable).toBe(true);

    server.rpc.holding(user, PLENTY);
    const tooSoon = await server.post("/settle", { destination: user.publicKey() });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.retryable).toBe(true);
    expect(server.rpc.submissions).toHaveLength(0);

    // Another account is not held back by this one's limit.
    expect(
      (await server.post("/settle", { destination: Keypair.random().publicKey() })).status,
    ).toBe(404);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const later = await server.post("/settle", { destination: user.publicKey() });
    expect(later.status).toBe(200);
    expect(later.body.settled).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("stops waiting on a slow confirmation after two minutes, and settles it on the next call", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    // Accepted into the queue and not included; every poll costs ten seconds.
    server.rpc.holdInclusion = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    const lookup = server.rpc.server.getTransaction.bind(server.rpc.server);
    server.rpc.server.getTransaction = async (hash) => {
      vi.setSystemTime(Date.now() + 10_000);
      return lookup(hash);
    };

    const started = Date.now();
    const waited = await server.post("/settle", { destination: user.publicKey() });
    expect(waited.status).toBe(200);
    expect(waited.body.settled).toBe(false);
    expect(waited.body.settlementRetryable).toBe(true);
    const seconds = (Date.now() - started) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(120);
    expect(seconds).toBeLessThan(150);

    // It lands meanwhile. The next call's resend finds the sequence spent and
    // the ledger says it was this settlement.
    server.rpc.includePending();
    server.rpc.holdInclusion = false;
    vi.setSystemTime(Date.now() + 31_000);
    const later = await server.post("/settle", { destination: user.publicKey() });
    expect(later.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(later.body.settlementTxHash).toBe(xdr.encodeBytes(landed.hash(), "hex"));
  });

  it("limits only accounts with a settlement to submit", async () => {
    const server = await startServer();
    const stranger = Keypair.random();
    // Nothing held: the answer is a map lookup, so asking again is not refused.
    expect((await server.post("/settle", { destination: stranger.publicKey() })).status).toBe(404);
    expect((await server.post("/settle", { destination: stranger.publicKey() })).status).toBe(404);

    // Settled: a page asking again at once hears that it was repaid.
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    const first = await server.post("/settle", { destination: user.publicKey() });
    expect(first.body.settled).toBe(true);
    const again = await server.post("/settle", { destination: user.publicKey() });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ settled: true, settlementTxHash: first.body.settlementTxHash });
  });

  it("answers 404 for an account with no held settlement", async () => {
    const server = await startServer();
    const response = await server.post("/settle", { destination: Keypair.random().publicKey() });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe(NOT_HELD);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("answers 404 once the held settlement can no longer land", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    skipPastSettlementWindow();
    const response = await server.post("/settle", { destination: user.publicKey() });
    expect(response.status).toBe(404);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses anything that is not a usable Stellar address", async () => {
    const server = await startServer();
    for (const destination of [
      undefined,
      42,
      "",
      "not an address",
      Keypair.random().secret(),
      ["G"],
    ]) {
      const response = await server.post("/settle", { destination });
      expect(response.status, String(destination)).toBe(400);
      expect(response.body.retryable).toBe(false);
    }
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("does not let a stranger fire a settlement before the preparation lands", async () => {
    // The victim already holds USDC on an authorized trustline, so the balance
    // check passes. Submitting now would fail on the revokes, count as a
    // stranding, and drop the victim's settlement.
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 1,
      volumeCapPerDay: { "expensive-gas": 10, "cheap-gas": 10 },
    });
    const server = await startServer({ caps });
    const victim = Keypair.random();
    await holdSettlementFor(server, victim);
    // a balance a stranger could point at: the line shows only for this probe,
    // since a line that existed before the preparation would not be sponsored
    server.rpc.holding(victim, PLENTY);
    // How the network would answer a settlement whose revokes have nothing to revoke.
    const onChainFailure = new MavnaError("settlement was rejected: opNoSponsorship", {
      retryable: false,
    });
    server.rpc.rejectNext = onChainFailure;

    const early = await server.post("/settle", { destination: victim.publicKey() });
    expect(early.status).toBe(200);
    expect(early.body.settled).toBe(false);
    expect(early.body.settlementRetryable).toBe(true);
    expect(server.rpc.rejectNext).toBe(onChainFailure);
    expect((await caps.check("expensive-gas")).allowed).toBe(true);
    server.rpc.rejectNext = undefined;
    server.rpc.trustlines.delete(victim.publicKey());
    server.rpc.accounts.delete(victim.publicKey());

    // Still held: the victim's own preparation goes through and the settlement
    // fires once it has landed.
    const submitted = await server.post("/submit", {
      signedXdr: await preparedAndSigned(server, victim),
    });
    expect(submitted.status).toBe(200);
    server.rpc.holding(victim, PLENTY);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const later = await server.post("/settle", { destination: victim.publicKey() });
    expect(later.body.settled).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual([
      "sponsored preparation",
      "settlement",
    ]);
  });
});

describe("the sponsor reports a submission that landed", () => {
  it("answers with the hash even when the cap count cannot be saved", async () => {
    // A durable store that is down. The preparation is already on the ledger, so
    // telling the user it failed would invite a retry of something that worked.
    class UnwritableStore extends InMemoryCapStore {
      override async save(_usage: CapUsage): Promise<void> {
        throw new Error("cap store is unreachable");
      }
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer({ caps: new CapLedger(new UnwritableStore()) });
    const user = Keypair.random();

    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    const response = await server.post("/submit", { signedXdr: prepared });

    expect(response.status).toBe(200);
    const submitted = server.rpc.submissions[0]?.tx as Transaction;
    expect(response.body.txHash).toBe(xdr.encodeBytes(submitted.hash(), "hex"));
    expect(logged.mock.calls.flat().join(" ")).toContain("cap store is unreachable");
    logged.mockRestore();
  });
});

describe("the sponsor sweeps held settlements the page never finished", () => {
  const SWEEP_MS = 120_000;

  /** Only the interval is faked: the HTTP calls these tests make still run on real time. */
  function fakeInterval(): void {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  }

  it("submits a prepared, funded settlement without anyone calling /settle", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();

    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
    const submitted = server.rpc.submissions[0]?.tx as Transaction;
    expect(signedBy(submitted, user.publicKey())).toBe(true);
    expect(signedBy(submitted, server.channel.publicKey())).toBe(true);
    expect(signedBy(submitted, server.sponsor.publicKey())).toBe(true);
    // Settled means no longer held; the page is told it was repaid.
    const after = await server.post("/settle", { destination: user.publicKey() });
    expect(after.status).toBe(200);
    expect(after.body.settled).toBe(true);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("does not run before the first interval has passed", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS - 1);
    await server.server.stopSweep();
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("leaves a settlement whose preparation has not landed", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3);
    await server.server.stopSweep();

    expect(server.rpc.submissions).toHaveLength(0);
    const still = await server.post("/settle", { destination: user.publicKey() });
    expect(still.status).toBe(200);
    expect(still.body.settled).toBe(false);
  });

  it("leaves a settlement whose money has not arrived, and keeps holding it", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, 1n);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(server.rpc.submissions).toHaveLength(0);

    // Still held, so the sweep after the money lands submits it.
    server.rpc.holding(user, PLENTY);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("settles every ready account in one pass, one at a time", async () => {
    fakeInterval();
    const pool = [Keypair.random(), Keypair.random()];
    const server = await startServer({ channels: new ChannelPool({ channels: pool }) });
    // the pool replaces the harness's own channel, so its accounts have to exist
    for (const channel of pool) server.rpc.accounts.set(channel.publicKey(), 300n);
    const users = [Keypair.random(), Keypair.random()];
    let inFlight = 0;
    let most = 0;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await submit(label, build, options);
      } finally {
        inFlight -= 1;
      }
    };
    for (const user of users) {
      await preparedWithSettlementHeld(server, user);
      server.rpc.holding(user, PLENTY);
    }

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();

    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement", "settlement"]);
    expect(most).toBe(1);
  });

  it("skips a tick while the previous sweep is still running", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      attempts += 1;
      await gate;
      return submit(label, build, options);
    };

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await vi.waitFor(() => expect(attempts).toBe(1));
    // Two more ticks while the first is stuck on the network.
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 2);
    expect(attempts).toBe(1);

    release();
    await server.server.stopSweep();
    expect(attempts).toBe(1);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("does not submit twice when /settle arrives during a sweep", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      attempts += 1;
      await gate;
      return submit(label, build, options);
    };

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await vi.waitFor(() => expect(attempts).toBe(1));

    const page = await server.post("/settle", { destination: user.publicKey() });
    expect(page.status).toBe(200);
    expect(page.body.settled).toBe(false);
    expect(page.body.settlementRetryable).toBe(true);

    release();
    await server.server.stopSweep();
    expect(attempts).toBe(1);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("stops when the server closes", async () => {
    fakeInterval();
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 2);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("never runs when the interval is zero", async () => {
    fakeInterval();
    const server = await startServer({ settleSweepSeconds: 0 });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 10);
    await server.server.stopSweep();
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("runs on the interval it is given", async () => {
    fakeInterval();
    const server = await startServer({ settleSweepSeconds: 5 });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(5_000);
    await server.server.stopSweep();
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("tells a page that comes back after the sweep that the account was repaid", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();
    const submitted = server.rpc.submissions[0]?.tx as Transaction;
    expect(submitted).toBeDefined();

    const page = await server.post("/settle", { destination: user.publicKey() });
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      settled: true,
      settlementTxHash: xdr.encodeBytes(submitted.hash(), "hex"),
    });
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("answers repaid to the page that was told to retry while the sweep was submitting", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      await gate;
      return submit(label, build, options);
    };

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    const during = await server.post("/settle", { destination: user.publicKey() });
    expect(during.body).toEqual({ settled: false, settlementRetryable: true });

    release();
    await server.server.stopSweep();
    // The page's poll interval, past the per-account limit.
    await vi.advanceTimersByTimeAsync(31_000);
    const after = await server.post("/settle", { destination: user.publicKey() });
    expect(after.status).toBe(200);
    expect(after.body.settled).toBe(true);
    const submitted = server.rpc.submissions[0]?.tx as Transaction | undefined;
    expect(submitted).toBeDefined();
    expect(after.body.settlementTxHash).toBe(
      submitted === undefined ? undefined : xdr.encodeBytes(submitted.hash(), "hex"),
    );
  });

  it("forgets a repayment once the settlement's own time bound has passed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();
    expect(server.rpc.submissions).toHaveLength(1);

    vi.setSystemTime(Date.now() + 86_400_000 + 60_000);
    const later = await server.post("/settle", { destination: user.publicKey() });
    expect(later.status).toBe(404);
  });

  it("gives up on an account whose RPC call hangs, releases it, and keeps sweeping", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    let attempts = 0;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      attempts += 1;
      // The first call never answers, the way a node that accepts the
      // connection and then says nothing behaves.
      if (attempts === 1) return new Promise<never>(() => {});
      return submit(label, build, options);
    };

    // Faked only now, with no HTTP left to make, so the deadline's timer is held too.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(attempts).toBe(1);

    // The next tick runs and retries the same account, so neither the sweep
    // nor the account's in-flight claim was left stuck behind the hung call.
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();
    expect(attempts).toBe(2);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/did not finish/);
    logged.mockRestore();
  });

  it("leaves no deadline timer behind after an account settles in time", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    await server.server.stopSweep();

    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses an interval that is not a whole number of seconds", async () => {
    for (const settleSweepSeconds of [-1, 1.5, Number.NaN]) {
      await expect(startServer({ settleSweepSeconds })).rejects.toThrow(/sweep/);
    }
  });
});

describe("a channel's sequence belongs to whoever holds its lease", () => {
  const SWEEP_MS = 120_000;

  /**
   * Hold back the server's view of a settlement that has already landed, the
   * way a slow confirmation does. Returns the release.
   */
  function confirmLate(server: TestServer): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      const result = await submit(label, build, options);
      if (label === "settlement") await gate;
      return result;
    };
    return release;
  }

  it("will not build on a channel while the owner's last settlement is still confirming", async () => {
    const server = await startServer();
    const owner = Keypair.random();
    const next = Keypair.random();
    await preparedWithSettlementHeld(server, owner);
    server.rpc.holding(owner, PLENTY);

    const confirmed = confirmLate(server);
    const first = server.post("/settle", { destination: owner.publicKey() });
    await vi.waitFor(() =>
      expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]),
    );

    // The channel's sequence is spent on the network and the server has not
    // heard yet. A build now would sit on the sequence the next user gets.
    const during = await server.post("/settlement", {
      destination: owner.publicKey(),
      sourceChainId: "1",
    });
    expect(during.status).toBe(409);
    expect(during.body.retryable).toBe(true);

    confirmed();
    expect((await first).body.settled).toBe(true);

    await preparedWithSettlementHeld(server, next);
    server.rpc.holding(next, PLENTY);
    const settled = await server.post("/settle", { destination: next.publicKey() });
    expect(settled.body.settled).toBe(true);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("will not hold a settlement built on a channel that has since gone to someone else", async () => {
    const server = await startServer();
    const owner = Keypair.random();
    const next = Keypair.random();
    await preparedWithSettlementHeld(server, owner);
    server.rpc.holding(owner, PLENTY);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // The sweep submits, the settlement lands, and the confirmation outlasts
    // the sweep's deadline, so the account is no longer marked as settling.
    const confirmed = confirmLate(server);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await server.server.stopSweep();
    vi.useRealTimers();

    // The owner builds on the channel's next sequence in that window...
    const extra = await server.post("/settlement", {
      destination: owner.publicKey(),
      sourceChainId: "1",
    });
    expect(extra.status).toBe(200);

    // ...the first settlement's confirmation arrives and frees the channel...
    confirmed();
    await vi.waitFor(() =>
      expect(logged.mock.calls.flat().join(" ")).toMatch(/landed after the sweep moved on/),
    );

    // ...and the next user's settlement is built on that same sequence.
    await preparedWithSettlementHeld(server, next);

    const committed = await server.post("/settlement/commit", {
      destination: owner.publicKey(),
      signedXdr: signXdr(extra.body.xdr as string, owner),
    });
    expect(committed.status).toBe(409);

    server.rpc.holding(next, PLENTY);
    const settled = await server.post("/settle", { destination: next.publicKey() });
    expect(settled.body.settled).toBe(true);
    const landed = server.rpc.submissions.map((s) => s.tx as Transaction);
    expect(landed).toHaveLength(1);
    expect(signedBy(landed[0] as Transaction, next.publicKey())).toBe(true);
    logged.mockRestore();
  });

  it("counts a settlement whose sequence something else spent as stranded, and frees its channel", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    // Some other transaction took the channel's next sequence.
    server.rpc.accounts.set(server.channel.publicKey(), 201n);

    const response = await server.post("/settle", { destination: user.publicKey() });
    expect(response.status).toBe(200);
    expect(response.body.settled).toBe(false);
    expect(response.body.settlementRetryable).toBe(false);
    expect((await caps.usage()).stranded).toBe(1);
    expect(server.rpc.submissions).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await server.post("/settle", { destination: user.publicKey() })).status).toBe(404);
    const next = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);
  });

  it("reports a settlement that landed unheard as settled when its sequence comes back spent", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    // The settlement lands, but the answer is lost on the way back.
    let lost = true;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      const result = await submit(label, build, options);
      if (label === "settlement" && lost) {
        lost = false;
        throw new MavnaError("the connection dropped before the answer came back", {
          retryable: true,
        });
      }
      return result;
    };

    const first = await server.post("/settle", { destination: user.publicKey() });
    expect(first.body.settled).toBe(false);
    expect(first.body.settlementRetryable).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    const again = await server.post("/settle", { destination: user.publicKey() });
    expect(again.status).toBe(200);
    expect(again.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(server.rpc.submissions).toHaveLength(1);
    expect(again.body.settlementTxHash).toBe(xdr.encodeBytes(landed.hash(), "hex"));
    expect((await caps.usage()).stranded).toBe(0);
  });
});

describe("an arrival below the signed ceiling that still covers the trade", () => {
  // 1.5 XLM at five XLM a USDC: 0.3 USDC, against a ceiling of 0.6
  it("settles when the account holds what the direct path spends now, with a margin", async () => {
    const spend = new FixedSpend();
    spend.quote = 3_000_000n;
    const server = await startServer({ spendQuote: spend });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);

    server.rpc.holding(user, 3_010_000n);
    const short = await server.post("/settle", { destination: user.publicKey() });
    expect(short.body.settled).toBe(false);
    expect(server.rpc.submissions).toEqual([]);

    server.rpc.holding(user, 3_100_000n);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await server.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      true,
    );
  });

  it("does not settle when the market has no direct path, whatever the balance", async () => {
    const spend = new FixedSpend();
    spend.quote = null;
    const server = await startServer({ spendQuote: spend });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    const asked = await server.post("/settle", { destination: user.publicKey() });
    expect(asked.body.settled).toBe(false);
    expect(asked.body.settlementRetryable).toBe(true);
    expect(server.rpc.submissions).toEqual([]);
  });

  it("does not settle on a quote above the ceiling the account signed", async () => {
    const spend = new FixedSpend();
    spend.quote = 7_000_000n;
    const server = await startServer({ spendQuote: spend });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, 6_500_000n);
    expect((await server.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      false,
    );
    expect(server.rpc.submissions).toEqual([]);
  });
});

describe("the sponsor cross-checks what it carries", () => {
  it("logs what the chain says it carries against its own records, from the sweep", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = new FixedSponsorshipView();
    view.slots = 7;
    const untracked = Keypair.random().publicKey();
    const server = await startServer({ sponsorshipView: view });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    view.accounts = [user.publicKey(), untracked];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(120_000);
    await server.server.stopSweep();
    const lines = logged.mock.calls.map((call) => call.join(" "));
    logged.mockRestore();
    const line = lines.find((text) => text.includes("reconciliation"));
    expect(line).toBeDefined();
    expect(line).toMatch(/7 reserve slots on-chain/);
    expect(line).toMatch(/3 by its records/);
    expect(line).toMatch(new RegExp(`untracked: ${untracked}`));
  });
});

describe("a channel that runs short of XLM for fees", () => {
  it("keeps the settlement held and tops the channel up, rather than counting a stranding", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    server.rpc.nativeBalances.set(server.channel.publicKey(), 10_100_000n);
    server.rpc.rejectNext = new SubmitRejected(
      "settlement was rejected: txInsufficientBalance",
      "txInsufficientBalance",
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const asked = await server.post("/settle", { destination: user.publicKey() });
    expect(asked.body.settled).toBe(false);
    expect(asked.body.settlementRetryable).toBe(true);
    expect((await caps.usage()).stranded).toBe(0);
    await vi.waitFor(() =>
      expect(server.rpc.submissions.map((s) => s.label)).toEqual(["channel top-up"]),
    );
    const topUp = server.rpc.submissions[0]?.tx as Transaction;
    expect(topUp.source).toBe(server.sponsor.publicKey());
    const payment = topUp.operations[0] as Operation.Payment;
    expect(payment.type).toBe("payment");
    expect(payment.destination).toBe(server.channel.publicKey());
    expect(logged.mock.calls.flat().join(" ")).toMatch(/channel .* is short of XLM/);
    logged.mockRestore();

    // still held, and settles once the channel can pay
    server.rpc.nativeBalances.set(server.channel.publicKey(), 30_000_000n);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await server.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      true,
    );
  });

  it("is topped up by the sweep before it runs short", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = await startServer();
    server.rpc.nativeBalances.set(server.channel.publicKey(), 12_000_000n);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    server.server.startSweep();
    await vi.advanceTimersByTimeAsync(120_000);
    await server.server.stopSweep();
    logged.mockRestore();
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["channel top-up"]);
  });

  it("says how many channels it has and how many are in use at /health", async () => {
    const server = await startServer();
    await holdSettlementFor(server, Keypair.random());
    const health = (await (await fetch(`${server.url}/health`)).json()) as Body;
    expect(health.channels).toEqual({ size: 1, leased: 1, maxSize: 1 });
  });
});

describe("the cap class is not the caller's to choose", () => {
  it("counts a claimed expensive-gas chain against the tighter allocation", async () => {
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 300, "cheap-gas": 1 },
    });
    const server = await startServer({ caps });
    await preparedWithSettlementHeld(server, Keypair.random());
    expect((await caps.usage()).started).toEqual({ "expensive-gas": 0, "cheap-gas": 1 });

    // the tighter allocation is spent; claiming another chain does not reach the larger one
    for (const sourceChainId of ["ethereum", "ethereum-sepolia", "1"]) {
      for (const path of ["/prepare", "/settlement"]) {
        const answered = await server.post(path, {
          destination: Keypair.random().publicKey(),
          assets: ["USDC"],
          sourceChainId,
        });
        expect(answered.status, `${path} ${sourceChainId}`).toBe(429);
      }
    }
  });

  it("uses whichever allocation the operator made tighter", async () => {
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 5, "cheap-gas": 50 },
    });
    const server = await startServer({ caps });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const built = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "base",
    });
    const signed = signXdr(built.body.xdr as string, user);
    expect((await server.post("/submit", { signedXdr: signed })).status).toBe(200);
    expect((await caps.usage()).started).toEqual({ "expensive-gas": 1, "cheap-gas": 0 });
  });
});

describe("the sponsor fronts only a trustline that does not exist yet", () => {
  it("declines to build for an account that already holds USDC", async () => {
    const server = await startServer();
    const user = Keypair.random();
    server.rpc.holding(user, 0n);
    for (const path of ["/settlement", "/prepare"]) {
      const answered = await server.post(path, {
        destination: user.publicKey(),
        assets: ["USDC"],
        sourceChainId: "1",
      });
      expect(answered.status, path).toBe(400);
      expect(answered.body.error, path).toMatch(/already holds USDC/);
    }
  });

  it("will not countersign once the account opened the trustline itself, and counts nothing", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    await holdSettlementFor(server, user);
    const signed = await preparedAndSigned(server, user);
    // opened from the account's own XLM between building and submitting
    server.rpc.holding(user, 600_000_000n);

    const submitted = await server.post("/submit", { signedXdr: signed });
    expect(submitted.status).toBe(409);
    expect(server.rpc.submissions).toEqual([]);

    // so no settlement can fail against a line the sponsor never sponsored
    expect((await server.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      false,
    );
    skipPastSettlementWindow();
    await server.post("/settle", { destination: user.publicKey() });
    expect(await caps.usage()).toMatchObject({ stranded: 0 });
    expect((await caps.usage()).started).toEqual({ "expensive-gas": 0, "cheap-gas": 0 });
  });
});

describe("the sponsor counts only USDC the account can spend", () => {
  it("does not settle while the USDC that would cover it is promised to the owner's offers", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    server.rpc.sellingLiabilities.set(user.publicKey(), PLENTY);

    const asked = await server.post("/settle", { destination: user.publicKey() });
    expect(asked.body.settled).toBe(false);
    expect(asked.body.settlementRetryable).toBe(true);
    expect(server.rpc.submissions).toEqual([]);

    server.rpc.sellingLiabilities.set(user.publicKey(), 0n);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await server.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      true,
    );
  });
});

describe("what anonymous builds can make the sponsor write down", () => {
  it("keeps a few settlements per account, and none past its short lease", async () => {
    const state = new MemoryDocumentStore();
    const server = await startServer({ state });
    const user = Keypair.random();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 20; i += 1) {
      // a second apart, so each build is a different transaction
      vi.setSystemTime(Date.now() + 1_000);
      const built = await server.post("/settlement", {
        destination: user.publicKey(),
        sourceChainId: "1",
      });
      expect(built.status).toBe(200);
    }
    const settlements = () =>
      (state.read("built") as Promise<{ kind: string }[]>).then((records) =>
        records.filter((record) => record.kind === "settlement"),
      );
    expect((await settlements()).length).toBe(3);

    vi.setSystemTime(Date.now() + PROVISIONAL_AND_GRACE_SECONDS * 1_000);
    await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect((await settlements()).length).toBe(1);
  });
});

describe("a settlement that lands after the sponsor stopped waiting", () => {
  /** Sends the settlement, sees no inclusion in two minutes, then lets it land. */
  async function landsUnseen(server: TestServer, user: Keypair): Promise<void> {
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);
    server.rpc.holdInclusion = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    const lookup = server.rpc.server.getTransaction.bind(server.rpc.server);
    server.rpc.server.getTransaction = async (hash) => {
      vi.setSystemTime(Date.now() + 10_000);
      return lookup(hash);
    };
    const waited = await server.post("/settle", { destination: user.publicKey() });
    expect(waited.body.settled).toBe(false);
    server.rpc.server.getTransaction = lookup;
    server.rpc.includePending();
    server.rpc.holdInclusion = false;
    // what it spent is gone, so the trustline no longer holds the ceiling
    server.rpc.holding(user, 1n);
  }

  it("is found by hash on the next call, though the balance no longer covers it", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await landsUnseen(server, user);

    vi.setSystemTime(Date.now() + 31_000);
    const later = await server.post("/settle", { destination: user.publicKey() });
    expect(later.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(later.body.settlementTxHash).toBe(xdr.encodeBytes(landed.hash(), "hex"));

    // and its channel is free for the next account
    const next = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);
  });

  it("is looked up again before its time bound counts it as stranded", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    await landsUnseen(server, user);

    vi.setSystemTime(Date.now() + 86_400_000 + 60_000);
    const asked = await server.post("/settle", { destination: user.publicKey() });
    expect((await caps.usage()).stranded).toBe(0);
    expect(asked.body.settled).toBe(true);
  });
});

describe("a preparation whose sponsor sequence something else spent", () => {
  it("is sent once, frees the account to prepare again, and says so", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const stale = await preparedAndSigned(server, user);
    // a delivery or another account's preparation lands first
    server.rpc.accounts.set(server.sponsor.publicKey(), 101n);
    let sends = 0;
    const send = server.rpc.server.sendTransaction.bind(server.rpc.server);
    server.rpc.server.sendTransaction = async (tx) => {
      sends += 1;
      return send(tx);
    };

    const failed = await server.post("/submit", { signedXdr: stale });
    expect(failed.status).toBe(409);
    expect(failed.body.retryable).toBe(true);
    expect(sends).toBe(1);

    const fresh = await preparedAndSigned(server, user);
    const landed = await server.post("/submit", { signedXdr: fresh });
    expect(landed.status).toBe(200);
  });

  it("funds a channel on the sponsor's fresh sequence when something else landed first", async () => {
    const server = await startServer({}, { fundsOwnChannel: true });
    const sends: string[] = [];
    const send = server.rpc.server.sendTransaction.bind(server.rpc.server);
    server.rpc.server.sendTransaction = async (tx) => {
      // the first time, another sponsor transaction lands just ahead of this one
      if (sends.length === 0) {
        const sponsor = server.sponsor.publicKey();
        server.rpc.accounts.set(sponsor, (server.rpc.accounts.get(sponsor) ?? 0n) + 1n);
      }
      sends.push((tx as Transaction).sequence);
      return send(tx);
    };
    const built = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);
    expect(sends).toEqual(["101", "102"]);
  });
});

describe("one account is one account however its address is written", () => {
  function muxedOf(user: Keypair): string {
    return new MuxedAccount(new Account(user.publicKey(), "0"), "7").accountId();
  }

  it("leases one channel and holds one settlement for an account and its muxed address", async () => {
    const channels = [Keypair.random(), Keypair.random()];
    const server = await startServer({ channels: new ChannelPool({ channels }) });
    for (const channel of channels) server.rpc.accounts.set(channel.publicKey(), 300n);
    const user = Keypair.random();
    const muxed = muxedOf(user);

    const forMuxed = await server.post("/settlement", { destination: muxed, sourceChainId: "1" });
    const forAccount = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(forMuxed.status).toBe(200);
    expect(forAccount.status).toBe(200);
    expect(forAccount.body.channel).toBe(forMuxed.body.channel);

    // one account, one channel, one sequence: the second is the same settlement
    const committed = await server.post("/settlement/commit", {
      destination: muxed,
      signedXdr: signXdr(forAccount.body.xdr as string, user),
    });
    expect(committed.status).toBe(200);

    const prepared: number[] = [];
    for (const destination of [muxed, user.publicKey()]) {
      const built = await server.post("/prepare", {
        destination,
        assets: ["USDC"],
        sourceChainId: "1",
      });
      expect(built.status).toBe(200);
      const submitted = await server.post("/submit", {
        signedXdr: signXdr(built.body.xdr as string, user),
      });
      prepared.push(submitted.status);
    }
    expect(prepared).toEqual([200, 409]);
  });
});

describe("the sponsor prepares only what the held settlement repays", () => {
  const MISMATCH = "That preparation does not match the settlement held for this account.";

  it("will not swap a prepared account's settlement for one that repays less", async () => {
    const server = await startServer();
    const user = Keypair.random();
    // A new account: the held settlement repays the account and its trustline.
    await preparedWithSettlementHeld(server, user);

    // The account exists now, so a fresh settlement would repay one trustline.
    const smaller = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(smaller.status).toBe(200);
    const replaced = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(smaller.body.xdr as string, user),
    });
    expect(replaced.status).toBe(409);

    server.rpc.holding(user, PLENTY);
    const settled = await server.post("/settle", { destination: user.publicKey() });
    expect(settled.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(landed.operations.map((op) => op.type)).toContain("revokeAccountSponsorship");
  });

  it("refuses a preparation that creates an account the settlement does not repay", async () => {
    const server = await startServer();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    await holdSettlementFor(server, user);

    // The account is merged away before the preparation is built.
    server.rpc.accounts.delete(user.publicKey());
    const response = await server.post("/submit", {
      signedXdr: await preparedAndSigned(server, user),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(MISMATCH);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses a preparation that creates no account when the settlement revokes one", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);

    // The account appears before the preparation is built.
    server.rpc.accounts.set(user.publicKey(), 1n);
    const response = await server.post("/submit", {
      signedXdr: await preparedAndSigned(server, user),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(MISMATCH);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses to prepare trustlines the settlement does not repay", async () => {
    const EURC = new Asset("EURC", Keypair.random().publicKey());
    const server = await startServer({ curatedAssets: { USDC, EURC } });
    const user = Keypair.random();
    await holdSettlementFor(server, user);

    for (const assets of [["EURC"], ["USDC", "EURC"], ["USDC", "USDC"], []]) {
      const refused = await server.post("/prepare", {
        destination: user.publicKey(),
        assets,
        sourceChainId: "1",
      });
      expect(refused.status).toBe(400);
      expect(refused.body.retryable).toBe(false);
    }

    // The preparation the settlement does repay still goes through.
    const usdcOnly = await server.post("/submit", {
      signedXdr: await preparedAndSigned(server, user),
    });
    expect(usdcOnly.status).toBe(200);
  });
});

describe("the held settlement stays put while a preparation lands against it", () => {
  /** A cap store whose next read waits until released, as a slow database does. */
  class StallingStore extends InMemoryCapStore {
    private stall: (() => Promise<void>) | undefined;

    stallNext(): { reached: Promise<void>; release: () => void } {
      let release: () => void = () => {};
      let arrived: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      this.stall = async () => {
        arrived();
        await gate;
      };
      return { reached, release };
    }

    override async load(day: string): Promise<CapUsage | undefined> {
      const stall = this.stall;
      this.stall = undefined;
      if (stall !== undefined) await stall();
      return super.load(day);
    }
  }

  it("will not swap in a cheaper settlement while the preparation is being submitted", async () => {
    const server = await startServer();
    const user = Keypair.random();
    // While the account exists, a settlement repays one trustline.
    server.rpc.accounts.set(user.publicKey(), 1n);
    const cheap = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(cheap.status).toBe(200);

    // Merged away, the account needs creating, and the held settlement repays that too.
    server.rpc.accounts.delete(user.publicKey());
    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);

    const stall = server.rpc.stallNext("sponsored preparation");
    const submitting = server.post("/submit", { signedXdr: prepared });
    await stall.reached;
    const swapped = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(cheap.body.xdr as string, user),
    });
    stall.release();
    expect(swapped.status).toBe(409);
    expect(swapped.body.retryable).toBe(false);
    expect((await submitting).status).toBe(200);

    server.rpc.submissions.splice(0);
    server.rpc.holding(user, PLENTY);
    const settled = await server.post("/settle", { destination: user.publicKey() });
    expect(settled.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(landed.operations.map((op) => op.type)).toContain("revokeAccountSponsorship");
  });

  it("takes a new settlement again once the cap has refused the preparation", async () => {
    let day = "2026-10-19";
    const store = new StallingStore();
    const caps = new CapLedger(
      store,
      { strandingCapPerDay: 75, volumeCapPerDay: { "expensive-gas": 1, "cheap-gas": 1 } },
      () => day,
    );
    const server = await startServer({ caps });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    const replacement = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(replacement.status).toBe(200);
    await caps.recordStarted("cheap-gas");

    // Refused while the submission is still checking the cap...
    const stall = store.stallNext();
    const submitting = server.post("/submit", { signedXdr: prepared });
    await stall.reached;
    const during = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(replacement.body.xdr as string, user),
    });
    stall.release();
    expect(during.status).toBe(409);
    expect((await submitting).status).toBe(429);

    // ...and accepted once the cap has turned the submission away.
    const after = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(replacement.body.xdr as string, user),
    });
    expect(after.status).toBe(200);
    day = "2026-10-20";
    const allowed = await server.post("/submit", { signedXdr: prepared });
    expect(allowed.status).toBe(200);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("counts a preparation that lands after its settlement expired as stranded", async () => {
    const caps = new CapLedger(new InMemoryCapStore());
    const server = await startServer({ caps });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const stall = server.rpc.stallNext("sponsored preparation");
    const submitting = server.post("/submit", { signedXdr: prepared });
    await stall.reached;
    skipPastSettlementWindow();
    const dropped = await server.post("/settle", { destination: user.publicKey() });
    stall.release();
    expect(dropped.status).toBe(404);
    expect((await submitting).status).toBe(200);
    expect((await caps.usage()).stranded).toBe(1);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/landed after its settlement was dropped/);
    logged.mockRestore();
  });

  const ALREADY = "A preparation has already been submitted against this account's settlement.";

  /** Two matching preparations with different hashes, built a few seconds apart. */
  async function twoPreparations(server: TestServer, user: Keypair): Promise<[string, string]> {
    const first = await preparedAndSigned(server, user);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5_000);
    const second = await preparedAndSigned(server, user);
    vi.useRealTimers();
    return [first, second];
  }

  it("refuses a second preparation while the first is being submitted", async () => {
    const server = await startServer();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    const cheap = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(cheap.status).toBe(200);
    server.rpc.accounts.delete(user.publicKey());
    await holdSettlementFor(server, user);
    const [first, second] = await twoPreparations(server, user);

    const stall = server.rpc.stallNext("sponsored preparation");
    const submitting = server.post("/submit", { signedXdr: first });
    await stall.reached;
    // Were the second to reach the network, it would fail there.
    server.rpc.rejectNext = new MavnaError("sponsored preparation was rejected: txBadSeq", {
      retryable: false,
    });
    const again = await server.post("/submit", { signedXdr: second });
    server.rpc.rejectNext = undefined;
    const swapped = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(cheap.body.xdr as string, user),
    });
    stall.release();
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(ALREADY);
    expect(again.body.retryable).toBe(false);
    expect(swapped.status).toBe(409);
    expect((await submitting).status).toBe(200);

    server.rpc.submissions.splice(0);
    server.rpc.holding(user, PLENTY);
    const settled = await server.post("/settle", { destination: user.publicKey() });
    expect(settled.body.settled).toBe(true);
    const landed = server.rpc.submissions[0]?.tx as Transaction;
    expect(landed.operations.map((op) => op.type)).toContain("revokeAccountSponsorship");
  });

  it("refuses a second preparation once the first has landed", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const [first, second] = await twoPreparations(server, user);

    expect((await server.post("/submit", { signedXdr: first })).status).toBe(200);
    const again = await server.post("/submit", { signedXdr: second });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(ALREADY);
    expect(server.rpc.submissions).toHaveLength(1);
  });

  it("does not accept a newer settlement and then drop it while a stranding is counted", async () => {
    const store = new StallingStore();
    // One cap day throughout, though the clock below crosses a day.
    const caps = new CapLedger(store, DEFAULT_CAPS, () => "2026-10-19");
    const server = await startServer({ caps });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    // built shortly before the first one's bound, within the short window a
    // built settlement may still be committed in
    vi.setSystemTime(start + 86_400_000 - 60_000);
    const newer = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(newer.status).toBe(200);

    // Something else spent the channel's sequence, so the held settlement is
    // stranded, and counting it waits on a slow store.
    server.rpc.accounts.set(server.channel.publicKey(), 201n);
    const stall = store.stallNext();
    const stranding = server.post("/settle", { destination: user.publicKey() });
    await stall.reached;
    vi.setSystemTime(start + 86_400_000 + 10_000);
    const committed = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(newer.body.xdr as string, user),
    });
    stall.release();
    // The stranded settlement and its channel are already given up, so the
    // newer one is turned away now rather than accepted and then dropped.
    expect(committed.status).toBe(409);
    expect(committed.body.error).toMatch(/slot has lapsed or passed/);
    expect((await stranding).body.settlementRetryable).toBe(false);
    expect((await caps.usage()).stranded).toBe(1);
    expect((await server.post("/settle", { destination: user.publicKey() })).status).toBe(404);
    const other = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(other.status).toBe(200);
  });

  it("does not let a settlement that lands late drop the newer one held after it", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    server.rpc.holding(user, PLENTY);

    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start + 86_400_000 - 60_000);
    const newer = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(newer.status).toBe(200);

    const stall = server.rpc.stallNext("settlement");
    const late = server.post("/settle", { destination: user.publicKey() });
    await stall.reached;
    // The first settlement passes its bound with its submission still out, and
    // the newer one is held in its place.
    vi.setSystemTime(start + 86_400_000 + 10_000);
    const committed = await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(newer.body.xdr as string, user),
    });
    stall.release();
    expect(committed.status).toBe(200);
    expect((await late).body.settled).toBe(true);

    // The newer settlement is still held, waiting on its own preparation...
    const again = await server.post("/settle", { destination: user.publicKey() });
    expect(again.status).toBe(200);
    expect(again.body.settled).toBe(false);
    expect(again.body.settlementRetryable).toBe(true);
    // ...and still holds its channel.
    const other = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(other.status).toBe(503);
  });
});

describe("a settlement slot is held for a day only once something backs it", () => {
  function skip(seconds: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + seconds * 1000);
  }

  /** A POST as one client behind the trusted proxy. */
  async function postAs(
    server: TestServer,
    client: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Body }> {
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": client },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  it("gives the channel to the next caller once an unsigned settlement's short lease lapses", async () => {
    const server = await startServer();
    const idle = Keypair.random();
    const built = await server.post("/settlement", {
      destination: idle.publicKey(),
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);

    // Still inside the short lease: the one channel is taken.
    skip(60);
    const early = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(early.status).toBe(503);
    expect(early.body.retryable).toBe(true);

    // Ten minutes from the first ask and the clock-drift grace later, it is free again.
    skip(600);
    const next = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);

    // And the lapsed settlement can no longer be held.
    const late = await server.post("/settlement/commit", {
      destination: idle.publicKey(),
      signedXdr: signXdr(built.body.xdr as string, idle),
    });
    expect(late.status).toBe(409);
  });

  it("gives the channel back when a signed settlement is never followed by a preparation", async () => {
    const server = await startServer();
    // a key the caller made up: the account need not exist and nothing is spent
    const attacker = Keypair.random();
    await holdSettlementFor(server, attacker);

    skip(60);
    const blocked = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(blocked.status).toBe(503);

    skip(PROVISIONAL_AND_GRACE_SECONDS);
    const victim = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(victim.status).toBe(200);

    // the lapsed hold backs nothing any more, so no preparation goes out on it
    const signed = await preparedAndSigned(server, attacker);
    expect((await server.post("/submit", { signedXdr: signed })).status).toBe(409);
    expect(server.rpc.submissions).toEqual([]);
  });

  it("keeps a prepared settlement's channel until the settlement's own time bound", async () => {
    const server = await startServer();
    await preparedWithSettlementHeld(server, Keypair.random());

    skip(3_600);
    const later = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(later.status).toBe(503);
    expect(later.body.retryable).toBe(true);
  });

  it("gives the slot back soon after the network refused the preparation outright", async () => {
    const server = await startServer();
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    const prepared = await preparedAndSigned(server, user);
    server.rpc.rejectNext = new MavnaError("sponsored preparation was rejected: txMalformed", {
      retryable: false,
    });
    expect((await server.post("/submit", { signedXdr: prepared })).status).toBe(502);

    skip(PROVISIONAL_AND_GRACE_SECONDS);
    const next = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);
  });

  it("lets one client wait on only a few settlements at once", async () => {
    const channels = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()];
    const server = await startServer({
      channels: new ChannelPool({ channels }),
      trustProxy: true,
      settlementsPerClient: 2,
    });
    for (const channel of channels) server.rpc.accounts.set(channel.publicKey(), 300n);

    const ask = (client: string, user: Keypair) =>
      postAs(server, client, "/settlement", { destination: user.publicKey(), sourceChainId: "1" });
    const repeated = Keypair.random();
    expect((await ask("203.0.113.1", repeated)).status).toBe(200);
    expect((await ask("203.0.113.1", Keypair.random())).status).toBe(200);
    // asking again for an account it already waits on takes nothing new
    expect((await ask("203.0.113.1", repeated)).status).toBe(200);
    const third = await ask("203.0.113.1", Keypair.random());
    expect(third.status).toBe(429);
    expect(third.body.retryable).toBe(true);
    expect((await ask("203.0.113.2", Keypair.random())).status).toBe(200);
  });

  it("funds one channel per slot in use, up to what it lets out", async () => {
    const server = await startServer(
      { provisionalSettlements: 2, settlementsPerClient: 0 },
      { fundsOwnChannel: true },
    );
    const funded = () => server.rpc.submissions.filter((s) => s.label === "channel funding");

    expect(
      (await server.post("/settlement", { destination: Keypair.random().publicKey() })).status,
    ).toBe(200);
    expect(funded()).toHaveLength(1);
    expect(
      (await server.post("/settlement", { destination: Keypair.random().publicKey() })).status,
    ).toBe(200);
    expect(funded()).toHaveLength(2);
    // two unbacked at once is all it lets out, so nothing more is funded for a third
    const full = await server.post("/settlement", { destination: Keypair.random().publicKey() });
    expect(full.status).toBe(503);
    expect(full.body.retryable).toBe(true);
    expect(funded()).toHaveLength(2);
  });

  it("keeps every channel it funded across a restart", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer(
      { provisionalSettlements: 2, settlementsPerClient: 0, state },
      { fundsOwnChannel: true },
    );
    for (let i = 0; i < 2; i += 1) {
      await first.post("/settlement", { destination: Keypair.random().publicKey() });
    }
    const channels = (await state.read("channels")) as { secrets: string[] };
    expect(channels.secrets).toHaveLength(2);
  });
});

/** The provisional lease and the reclaim grace, plus a second. */
const PROVISIONAL_AND_GRACE_SECONDS = 600 + 30 + 1;

describe("the sponsor does not take a failed read for a missing account", () => {
  function failAccountReads(server: TestServer, user: Keypair): void {
    const read = server.rpc.server.getLedgerEntries.bind(server.rpc.server);
    server.rpc.server.getLedgerEntries = async (...keys) => {
      const asksForUser = keys.some(
        (key) =>
          key.type === "account" &&
          StrKey.encodeEd25519PublicKey(key.account.accountId.ed25519.toBytes()) ===
            user.publicKey(),
      );
      if (asksForUser) throw new Error("connection reset");
      return read(...keys);
    };
  }

  it("answers a retryable failure, not a settlement for a new account", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    failAccountReads(server, user);

    for (const path of ["/settlement", "/prepare"]) {
      const response = await server.post(path, {
        destination: user.publicKey(),
        assets: ["USDC"],
        sourceChainId: "1",
      });
      expect(response.status, path).toBe(500);
      expect(response.body.retryable, path).toBe(true);
      // a failure can come after something was sent, so it never claims otherwise
      expect(response.body.error, path).not.toMatch(/Nothing was spent/);
    }
    logged.mockRestore();
  });
});

describe("the sponsor funds its own channel once", () => {
  function countFunding(server: TestServer): () => number {
    let funded = 0;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      if (label === "channel funding") funded += 1;
      return submit(label, build, options);
    };
    return () => funded;
  }

  it("funds one channel per settlement, never two, when the first two arrive at once", async () => {
    // The funding waits until both requests are past the cap check, so the
    // second reaches the channel step while the first is still funding.
    let checked = 0;
    let bothIn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    class CountingCaps extends CapLedger {
      override async check(source: Parameters<CapLedger["check"]>[0]) {
        checked += 1;
        if (checked === 2) bothIn();
        return super.check(source);
      }
    }
    const server = await startServer(
      { caps: new CountingCaps(new InMemoryCapStore()) },
      { fundsOwnChannel: true },
    );
    const funded = countFunding(server);
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, options) => {
      if (label === "channel funding") await gate;
      return submit(label, build, options);
    };

    const answers = await Promise.all(
      [Keypair.random(), Keypair.random()].map((user) =>
        server.post("/settlement", { destination: user.publicKey(), sourceChainId: "1" }),
      ),
    );
    // one funding each at most, never two for the same need
    expect(funded()).toBe(2);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
  });

  it("tries the funding again after it failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer({}, { fundsOwnChannel: true });
    const funded = countFunding(server);
    server.rpc.rejectNext = new MavnaError("channel funding was rejected: txInsufficientBalance", {
      retryable: false,
    });

    const failed = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(failed.status).toBe(503);
    expect(failed.body.retryable).toBe(true);
    // once its backoff is over
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const retried = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(retried.status).toBe(200);
    expect(funded()).toBe(2);
    logged.mockRestore();
  });
});

describe("the sponsor's state belongs to one network", () => {
  const mainnet = createNetworkConfig({ id: "mainnet", rpcUrl: PUBLIC_TESTNET_RPC_URL });

  it("will not start on mainnet with state a testnet run wrote", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    await first.server.ready();
    await holdSettlementFor(first, Keypair.random());

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpcOnMainnet = new RecordingRpc();
    rpcOnMainnet.networkPassphrase = Networks.PUBLIC;
    const second = await startServer({
      state,
      rpc: rpcOnMainnet,
      network: mainnet,
      networkId: "mainnet",
    });
    await expect(second.server.ready()).rejects.toThrow(/written for Test SDF Network/);
    errors.mockRestore();
  });

  it("takes state written before it said its network as this network's, and says so", async () => {
    const state = new MemoryDocumentStore();
    await state.write("held", { held: {}, settled: {} });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server } = await startServer({ state });
    await expect(server.ready()).resolves.toBeUndefined();
    expect(errors.mock.calls.flat().join(" ")).toMatch(/no network recorded/);
    errors.mockRestore();
    expect(await state.read("network")).toEqual({ passphrase: Networks.TESTNET });
  });
});

describe("the sponsor and its node agree on the network", () => {
  it("will not start against a node that serves another network", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server } = await startServer();
    expect(await server.ready()).toBeUndefined();
    const other = await startServer();
    other.rpc.networkPassphrase = Networks.PUBLIC;
    await expect(other.server.ready()).rejects.toThrow(/serves Public Global Stellar Network/);
    errors.mockRestore();
  });
});

describe("the sponsor skips stored state it did not write, and still starts", () => {
  it.each([
    ["held", { held: 5 }],
    ["built", { not: "a list" }],
    ["channels", { secrets: "S...", leases: [] }],
  ])(
    "starts without a %s document that is not in the shape it writes, and keeps it aside",
    async (name, value) => {
      const state = new MemoryDocumentStore();
      await state.write(name, value);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { server } = await startServer({ state });
      await expect(server.ready()).resolves.toBeUndefined();
      expect(errors.mock.calls.some((call) => String(call.join(" ")).includes(name))).toBe(true);
      const rejected = (await state.read("rejected")) as Record<string, { value: unknown }[]>;
      expect(rejected[name]?.[0]?.value).toEqual(value);
      errors.mockRestore();
    },
  );

  it("drops only the built record that is not in the shape it writes", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const signed = await preparedAndSigned(first, user);
    const built = (await state.read("built")) as Record<string, unknown>[];
    await state.write("built", [
      ...built,
      { ...built[0], hash: "ff".repeat(32), sourceChainId: 7 },
    ]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await startServer({ state }, { restartOf: first });
    await expect(second.server.ready()).resolves.toBeUndefined();
    errors.mockRestore();
    const submitted = await second.post("/submit", { signedXdr: signed });
    expect(submitted.status).toBe(200);
  });

  it("drops only the held settlement that is not in the shape it writes", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const document = (await state.read("held")) as { held: Record<string, unknown> };
    const stray = Keypair.random().publicKey();
    await state.write("held", {
      ...document,
      held: { ...document.held, [stray]: { xdr: 5 } },
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await startServer({ state }, { restartOf: first });
    await expect(second.server.ready()).resolves.toBeUndefined();
    errors.mockRestore();
    const signed = await preparedAndSigned(second, user);
    expect((await second.post("/submit", { signedXdr: signed })).status).toBe(200);
  });
});

describe("the sponsor reads every request field as the type it must be", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "refuses %s as an asset name, which no curated list holds",
    async (name) => {
      const server = await startServer({ reserveFunding: "self" });
      const user = Keypair.random();
      server.rpc.accounts.set(user.publicKey(), 1n);
      const answered = await server.post("/prepare", {
        destination: user.publicKey(),
        assets: [name],
      });
      expect(answered.status).toBe(400);
      expect(answered.body.error).toBe(
        "This sponsor only prepares accounts for assets it curates.",
      );
    },
  );

  it("refuses a source chain that is not a chain id, and still starts after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mavna-sponsor-"));
    const state = new FileDocumentStore(dir);
    const first = await startServer({ state });
    for (const sourceChainId of [7, { a: 1 }, ["base"], "", "x".repeat(200)]) {
      for (const path of ["/prepare", "/settlement"]) {
        const answered = await first.post(path, {
          destination: Keypair.random().publicKey(),
          sourceChainId,
        });
        expect(answered.status, `${path} ${JSON.stringify(sourceChainId)}`).toBe(400);
      }
    }
    first.server.close();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await startServer({ state: new FileDocumentStore(dir) }, { restartOf: first });
    await expect(second.server.ready()).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses the same in self-funded mode", async () => {
    const server = await startServer({ reserveFunding: "self" });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    const answered = await server.post("/prepare", {
      destination: user.publicKey(),
      sourceChainId: 7,
    });
    expect(answered.status).toBe(400);
  });

  it.each([
    ["/prepare", { destination: 5 }],
    ["/prepare", { destination: Keypair.random().publicKey(), assets: "USDC" }],
    ["/prepare", { destination: Keypair.random().publicKey(), assets: [5] }],
    ["/settlement", { destination: ["G"] }],
    ["/settlement/commit", { signedXdr: "AAAA", destination: 5 }],
    ["/submit", { signedXdr: 5 }],
    ["/settle", { destination: { a: 1 } }],
    ["/deliver", { txHash: `0x${"ab".repeat(32)}`, domain: "0" }],
  ])("answers %s with 400 for a field of the wrong type", async (path, body) => {
    const server = await startServer();
    const answered = await server.post(path, body);
    expect(answered.status).toBe(400);
    expect(answered.body.retryable).toBe(false);
    expect(server.rpc.submissions).toEqual([]);
  });
});

describe("the sponsor writes its state only when it changed", () => {
  /** A memory store that counts what it is asked to write. */
  class CountingStore extends MemoryDocumentStore {
    readonly writes: string[] = [];
    override async write(name: string, value: unknown): Promise<void> {
      this.writes.push(name);
      await super.write(name, value);
    }
  }

  it("writes nothing to answer a request it refuses", async () => {
    const state = new CountingStore();
    const server = await startServer({ state });
    await server.post("/settlement", { destination: Keypair.random().publicKey() });
    state.writes.length = 0;
    for (let i = 0; i < 3; i += 1) {
      expect((await server.post("/prepare", { destination: "not an address" })).status).toBe(400);
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
    }
    expect(state.writes).toEqual([]);
  });

  it("answers no sooner than a write of the same state still on its way to disk", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class GatedStore extends MemoryDocumentStore {
      override async write(name: string, value: unknown): Promise<void> {
        if (name === "built") await gate;
        await super.write(name, value);
      }
    }
    const server = await startServer({ state: new GatedStore() });
    // changes what was built, and waits on its write
    const changing = server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    await new Promise((r) => setTimeout(r, 20));
    // changes nothing, so it has the same state to write down
    let answered = false;
    const same = server.post("/prepare", { destination: "not an address" }).then((r) => {
      answered = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    release();
    expect((await same).status).toBe(400);
    expect((await changing).status).toBe(200);
  });

  it("writes a channel's lease down before the settlement that depends on it", async () => {
    // a crash between the two must leave a lease without a settlement, never a
    // settlement whose channel lease was lost and could go to someone else
    const order: string[] = [];
    class OrderedStore extends MemoryDocumentStore {
      override async write(name: string, value: unknown): Promise<void> {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        await super.write(name, value);
        order.push(`done ${name}`);
      }
    }
    const server = await startServer({ state: new OrderedStore() });
    const user = Keypair.random();
    // the lease is written when the slot is taken, before any settlement is held on it
    const built = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(order.indexOf("done channels")).toBeGreaterThanOrEqual(0);
    await server.post("/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(built.body.xdr as string, user),
    });
    const signed = await preparedAndSigned(server, user);
    order.length = 0;
    // and its landing lengthens the lease, written before the settlement it backs
    await server.post("/submit", { signedXdr: signed });
    expect(order).toContain("start held");
    expect(order).toContain("done channels");
    expect(order.lastIndexOf("done channels")).toBeLessThan(order.lastIndexOf("start held"));
  });

  it("writes only the document a request changed", async () => {
    const state = new CountingStore();
    const server = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
    state.writes.length = 0;
    const built = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);
    expect(state.writes).toEqual(["built"]);
  });
});

describe("what the sponsor holds survives a restart", () => {
  it("still holds a settlement committed before the restart", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const signed = await preparedAndSigned(first, user);

    const second = await startServer({ state }, { restartOf: first });
    const submitted = await second.post("/submit", { signedXdr: signed });
    expect(submitted.status).toBe(200);
  });

  it("settles a prepared settlement after the restart once the money arrives", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await preparedWithSettlementHeld(first, user);

    const second = await startServer({ state }, { restartOf: first });
    second.rpc.holding(user, PLENTY);
    const settled = await second.post("/settle", { destination: user.publicKey() });
    expect(settled.body.settled).toBe(true);
    expect(second.rpc.submissions.map((s) => s.label)).toEqual(["settlement"]);
  });

  it("still remembers a repayment that landed before the restart", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await preparedWithSettlementHeld(first, user);
    first.rpc.holding(user, PLENTY);
    expect((await first.post("/settle", { destination: user.publicKey() })).body.settled).toBe(
      true,
    );

    const second = await startServer({ state }, { restartOf: first });
    const asked = await second.post("/settle", { destination: user.publicKey() });
    expect(asked.status).toBe(200);
    expect(asked.body.settled).toBe(true);
  });

  it("does not hand a channel held before the restart to someone else", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    await holdSettlementFor(first, Keypair.random());

    const second = await startServer({ state }, { restartOf: first });
    const other = await second.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(other.status).toBe(503);
  });

  it("keeps counting toward the daily caps across the restart", async () => {
    const state = new MemoryDocumentStore();
    const caps = (): CapLedger =>
      new CapLedger(new DocumentCapStore(state), {
        ...DEFAULT_CAPS,
        volumeCapPerDay: { "expensive-gas": 1, "cheap-gas": 1 },
      });
    const first = await startServer({ state, caps: caps() });
    await preparedWithSettlementHeld(first, Keypair.random());

    const second = await startServer({ state, caps: caps() }, { restartOf: first });
    const refused = await second.post("/prepare", {
      destination: Keypair.random().publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(refused.status).toBe(429);
  });

  it("counts toward the caps in its own store when none is given", async () => {
    const state = new MemoryDocumentStore();
    const server = await startServer({ state });
    await preparedWithSettlementHeld(server, Keypair.random());
    const counted = (await state.read("caps")) as Record<string, CapUsage>;
    expect(Object.values(counted)[0]?.started["cheap-gas"]).toBe(1);
  });

  it("keeps the channel it funded itself, rather than funding another", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state }, { fundsOwnChannel: true });
    const user = Keypair.random();
    const before = await first.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(before.status).toBe(200);

    const second = await startServer({ state }, { fundsOwnChannel: true, restartOf: first });
    const after = await second.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(after.status).toBe(200);
    expect(after.body.channel).toBe(before.body.channel);
    expect(second.rpc.submissions.filter((s) => s.label === "channel funding")).toHaveLength(1);
  });

  it("writes a channel's key down before funding it, and funds that same key on the retry", async () => {
    const state = new MemoryDocumentStore();
    const server = await startServer({ state }, { fundsOwnChannel: true });
    server.rpc.rejectNext = new MavnaError("the network refused it", { retryable: true });
    const user = Keypair.random();
    const failed = await server.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(failed.status).toBe(503);
    const written = (await state.read("channels")) as { pending?: string };
    expect(written.pending).toBeDefined();

    const second = await startServer({ state }, { fundsOwnChannel: true, restartOf: server });
    const retried = await second.post("/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    expect(retried.status).toBe(200);
    expect(retried.body.channel).toBe(Keypair.fromSecret(written.pending ?? "").publicKey());
  });

  it("does not fund again a key whose funding landed before the process died", async () => {
    const state = new MemoryDocumentStore();
    const pending = Keypair.random();
    const server = await startServer({ state }, { fundsOwnChannel: true });
    // the funding landed, and the process died before it wrote that down
    server.rpc.accounts.set(pending.publicKey(), 300n);
    await state.write("channels", { secrets: [], leases: [], pending: pending.secret() });

    const second = await startServer({ state }, { fundsOwnChannel: true, restartOf: server });
    const built = await second.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(built.status).toBe(200);
    expect(built.body.channel).toBe(pending.publicKey());
    expect(second.rpc.submissions.filter((s) => s.label === "channel funding")).toHaveLength(0);
  });

  it("finds out whether a preparation in flight when the process died landed", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const stalled = first.rpc.stallNext("sponsored preparation");
    const inFlight = first.post("/submit", { signedXdr: await preparedAndSigned(first, user) });
    await stalled.reached;

    // the process is gone from here on; its submission still reaches the network
    const second = await startServer({ state }, { restartOf: first });
    stalled.release();
    expect((await inFlight).status).toBe(200);

    second.rpc.holding(user, PLENTY);
    const settled = await second.post("/settle", { destination: user.publicKey() });
    expect(settled.body.settled).toBe(true);
  });

  it("will not take another preparation while one from before the restart may still land", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const stalled = first.rpc.stallNext("sponsored preparation");
    void first.post("/submit", { signedXdr: await preparedAndSigned(first, user) });
    await stalled.reached;

    const second = await startServer({ state }, { restartOf: first });
    const again = await second.post("/submit", {
      signedXdr: await preparedAndSigned(second, user),
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already been submitted/);
  });

  it("takes a new preparation once the lost one can no longer land", async () => {
    const state = new MemoryDocumentStore();
    const first = await startServer({ state });
    const user = Keypair.random();
    await holdSettlementFor(first, user);
    const stalled = first.rpc.stallNext("sponsored preparation");
    void first.post("/submit", { signedXdr: await preparedAndSigned(first, user) });
    await stalled.reached;

    const second = await startServer({ state }, { restartOf: first });
    // past the preparation's five-minute bound, well inside the settlement's day
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const again = await second.post("/submit", {
      signedXdr: await preparedAndSigned(second, user),
    });
    expect(again.status).toBe(200);
  });
});

describe("with reserve funding set to self, the account pays its own reserve", () => {
  async function selfFunded(): Promise<TestServer> {
    return await startServer({ reserveFunding: "self" });
  }

  it("says which funding it runs on at /health", async () => {
    const sponsorFunded = await startServer();
    const own = await selfFunded();
    const ask = async (server: TestServer) =>
      (await (await fetch(`${server.url}/health`)).json()) as Body;
    expect((await ask(sponsorFunded)).reserveFunding).toBe("sponsor");
    expect((await ask(own)).reserveFunding).toBe("self");
  });

  it("declines an address that does not exist yet, with what it needs", async () => {
    const server = await selfFunded();
    const response = await server.post("/prepare", {
      destination: Keypair.random().publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/does not exist/);
    expect(response.body.error).toMatch(/1 XLM/);
  });

  it("builds a trustline the account opens and pays for itself, with no sponsorship in it", async () => {
    const server = await selfFunded();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const response = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(response.status).toBe(200);
    const tx = TransactionBuilder.fromXdr(
      response.body.xdr as string,
      network.passphrase,
    ) as Transaction;
    expect(tx.source).toBe(user.publicKey());
    expect(tx.sequence).toBe("51");
    expect(tx.operations.map((op) => op.type)).toEqual(["changeTrust"]);
    const [op] = tx.operations as Operation.ChangeTrust[];
    expect(op?.line.toString()).toBe(USDC.toString());
  });

  it("submits it as the user signed it, without a settlement and without the sponsor's signature", async () => {
    const server = await selfFunded();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const built = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    const submitted = await server.post("/submit", {
      signedXdr: signXdr(built.body.xdr as string, user),
    });
    expect(submitted.status).toBe(200);
    const [sent] = server.rpc.submissions;
    expect(sent?.label).toBe("self-funded preparation");
    expect(signedBy(sent?.tx as Transaction, server.sponsor.publicKey())).toBe(false);
  });

  it("refuses one the account has not signed", async () => {
    const server = await selfFunded();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const built = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    const submitted = await server.post("/submit", {
      signedXdr: signXdr(built.body.xdr as string, Keypair.random()),
    });
    expect(submitted.status).toBe(400);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("declines before anyone signs when the account cannot spare the reserve", async () => {
    const server = await selfFunded();
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    // one subentry already: a minimum balance of 1.5 XLM, so 1.6 leaves 0.1 spare
    server.rpc.nativeBalances.set(user.publicKey(), 16_000_000n);
    const response = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/0\.5 XLM/);
  });

  it("does not take on a loan, so it builds no settlement", async () => {
    const server = await selfFunded();
    const response = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/does not front/);
  });

  it("is not held to the daily caps, which bound the sponsor's money and none is spent", async () => {
    const server = await startServer({
      reserveFunding: "self",
      caps: new CapLedger(new InMemoryCapStore(), {
        strandingCapPerDay: 0,
        volumeCapPerDay: { "expensive-gas": 0, "cheap-gas": 0 },
      }),
    });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const response = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    expect(response.status).toBe(200);
  });
});

describe("with reserve funding set to self, an account can open its own USDT0 trustline", () => {
  const USDT0 = new Asset("USDT0", Keypair.random().publicKey());

  it("builds a USDT0 trustline the account opens and pays for itself", async () => {
    const server = await startServer({ reserveFunding: "self", curatedAssets: { USDC, USDT0 } });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const response = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDT0"],
      sourceChainId: "42161",
    });
    expect(response.status).toBe(200);
    expect(response.body.selfFunded).toBe(true);
    const tx = TransactionBuilder.fromXdr(
      response.body.xdr as string,
      network.passphrase,
    ) as Transaction;
    expect(tx.source).toBe(user.publicKey());
    const [op] = tx.operations as Operation.ChangeTrust[];
    expect(tx.operations).toHaveLength(1);
    expect(op?.line.toString()).toBe(USDT0.toString());

    const submitted = await server.post("/submit", { signedXdr: signXdr(tx.toXdr(), user) });
    expect(submitted.status).toBe(200);
  });

  it("names USDT0 when the account cannot spare the reserve for it", async () => {
    const server = await startServer({ reserveFunding: "self", curatedAssets: { USDC, USDT0 } });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    server.rpc.nativeBalances.set(user.publicKey(), 16_000_000n);
    const response = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDT0"],
      sourceChainId: "42161",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/^Holding USDT0 locks 0\.5 XLM/);
  });

  it("opens one trustline per preparation and only for assets it curates", async () => {
    const server = await startServer({ reserveFunding: "self", curatedAssets: { USDC, USDT0 } });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    for (const assets of [["USDC", "USDT0"], ["EURC"], []]) {
      const refused = await server.post("/prepare", {
        destination: user.publicKey(),
        assets,
        sourceChainId: "42161",
      });
      expect(refused.status).toBe(400);
    }
  });

  it("still prepares only USDC when the sponsor fronts the reserve, since it is repaid in USDC", async () => {
    const server = await startServer({ curatedAssets: { USDC, USDT0 } });
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 50n);
    const refused = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDT0"],
      sourceChainId: "42161",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/only prepares a USDC trustline/);
  });
});

describe("the sponsor pays for no delivery smaller than its minimum", () => {
  const BURN = `0x${"cd".repeat(32)}`;
  const ATTESTATION = `0x${"ef".repeat(65)}`;

  function irisReturns(messageHex: string): void {
    stubIris(
      () =>
        new Response(
          JSON.stringify({
            messages: [{ message: messageHex, attestation: ATTESTATION, status: "complete" }],
          }),
          { status: 200 },
        ),
    );
  }

  it("refuses to deliver a burn that mints less than the minimum, and pays nothing", async () => {
    const server = await startServer({ buildDelivery, minDeliveryBaseUnits: 2_000_000n });
    irisReturns(cctpMessage(Keypair.random().publicKey(), { amount: 1_999_999n }));
    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(400);
    expect(response.body.retryable).toBe(false);
    expect(response.body.error).toMatch(/2 USDC/);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("delivers one that mints exactly the minimum", async () => {
    const server = await startServer({ buildDelivery, minDeliveryBaseUnits: 2_000_000n });
    irisReturns(cctpMessage(Keypair.random().publicKey(), { amount: 2_000_000n }));
    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(200);
    expect(server.rpc.submissions.map((s) => s.label)).toEqual(["cctp delivery"]);
  });

  it("pays for no delivery at all when accounts fund themselves, since they deliver their own", async () => {
    const server = await startServer({ buildDelivery, reserveFunding: "self" });
    irisReturns(cctpMessage(Keypair.random().publicKey(), { amount: 5_000_000n }));
    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(409);
    expect(response.body.retryable).toBe(false);
    expect(response.body.error).toMatch(/does not pay for deliveries/);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("counts what is minted after Circle's fee, not what was burned", async () => {
    const server = await startServer({ buildDelivery, minDeliveryBaseUnits: 2_000_000n });
    irisReturns(cctpMessage(Keypair.random().publicKey(), { amount: 2_000_000n, feeExecuted: 1n }));
    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(400);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("refuses a message whose amount it cannot read", async () => {
    const server = await startServer({ buildDelivery });
    irisReturns(cctpMessage(Keypair.random().publicKey()).slice(0, 2 + 2 * 200));
    const response = await server.post("/deliver", { txHash: BURN, domain: 0 });
    expect(response.status).toBe(400);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("says its minimum at /health, in USDC base units", async () => {
    const server = await startServer({ minDeliveryBaseUnits: 2_500_000n });
    const health = (await (await fetch(`${server.url}/health`)).json()) as Body;
    expect(health.minDeliveryBaseUnits).toBe("2500000");
  });
});

describe("the sponsor limits how often one address may ask", () => {
  it("answers 429 past the per-minute limit", async () => {
    const server = await startServer({ rateLimitPerMinute: 3 });
    const statuses: number[] = [];
    for (let n = 0; n < 4; n += 1) statuses.push((await fetch(`${server.url}/health`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("limits every endpoint, not only the ones that spend", async () => {
    const server = await startServer({ rateLimitPerMinute: 1 });
    await fetch(`${server.url}/health`);
    const response = await server.post("/settle", { destination: Keypair.random().publicKey() });
    expect(response.status).toBe(429);
    expect(response.body.retryable).toBe(true);
  });

  it("counts addresses behind a trusted proxy apart", async () => {
    const server = await startServer({ rateLimitPerMinute: 1, trustProxy: true });
    const from = (address: string) =>
      fetch(`${server.url}/health`, { headers: { "x-forwarded-for": address } });
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
  });

  it("ignores the forwarded header when no proxy is trusted", async () => {
    const server = await startServer({ rateLimitPerMinute: 1 });
    const from = (address: string) =>
      fetch(`${server.url}/health`, { headers: { "x-forwarded-for": address } });
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(429);
  });
});

describe("the soroswap proxy, mounted on the sponsor", () => {
  const APP = "https://app.example";

  /** A stand-in Soroswap on localhost that answers /health and counts calls. */
  async function upstream(): Promise<{ url: string; calls: () => number }> {
    let calls = 0;
    const fake = createHttpServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: { indexer: { testnet: ["soroswap"], mainnet: [] } } }));
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    running.push(fake);
    return {
      url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      calls: () => calls,
    };
  }

  async function mounted(trustProxy = false) {
    const soroswap = await upstream();
    const server = await startServer({
      allowedOrigins: [APP],
      trustProxy,
      soroswap: createSoroswapProxy({
        apiKey: "sk_test_key",
        network: "testnet",
        baseUrl: soroswap.url,
        perClientPerMinute: 1,
      }),
    });
    const health = (headers: Record<string, string>) =>
      fetch(`${server.url}/swap/soroswap/health`, { headers });
    return { soroswap, health };
  }

  it("answers an allowed origin with CORS, and refuses any other", async () => {
    const { soroswap, health } = await mounted();
    const allowed = await health({ origin: APP });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await allowed.json()).toEqual({
      network: "testnet",
      usable: true,
      protocols: ["soroswap"],
    });

    const stranger = await health({ origin: "https://elsewhere.example" });
    expect(stranger.status).toBe(403);
    const none = await health({});
    expect(none.status).toBe(403);
    expect(soroswap.calls()).toBe(1);
  });

  it("does not exist on a sponsor without a Soroswap key", async () => {
    const server = await startServer({ allowedOrigins: [APP] });
    const response = await fetch(`${server.url}/swap/soroswap/health`, {
      headers: { origin: APP },
    });
    expect(response.status).toBe(404);
  });

  it("limits by the forwarded client only behind a trusted proxy, like every other endpoint", async () => {
    const trusting = await mounted(true);
    expect((await trusting.health({ origin: APP, "x-forwarded-for": "198.51.100.1" })).status).toBe(
      200,
    );
    // A different client behind the same proxy has its own allowance.
    expect((await trusting.health({ origin: APP, "x-forwarded-for": "198.51.100.2" })).status).toBe(
      200,
    );

    const wary = await mounted(false);
    expect((await wary.health({ origin: APP, "x-forwarded-for": "198.51.100.1" })).status).toBe(
      200,
    );
    // Forging the header buys nothing: both calls come from the same socket.
    expect((await wary.health({ origin: APP, "x-forwarded-for": "198.51.100.2" })).status).toBe(
      429,
    );
  });
});

describe("finishing a conversion on arrival", () => {
  const ARRIVAL = "CBBT5762DOTXQMDPWSCMPSKB6YMXHS3XJJO7R3DZPXVHK62TOC5HV7XQ";
  const good = {
    from: "GBNCXZUVSV4GCBTYKCUPK46XS5U3CEDP6F54NZIWQ4GN3SWD52D3N2NB",
    guid: "ab".repeat(32),
    index: 0,
    message: "0x01",
  };
  // what the endpoint holds for a queued message: its keccak hash
  const queuedHash = Buffer.from(composeMessageHash("0x01").slice(2), "hex");

  it("spends nothing on the contract when accounts fund themselves, and says so at start", async () => {
    const logged: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const own = await startServer({ reserveFunding: "self", arrivalContract: ARRIVAL });
    own.server.startSweep();
    await new Promise((r) => setTimeout(r, 50));
    await own.server.stopSweep();
    errors.mockRestore();
    expect(own.rpc.submissions.map((s) => s.label)).not.toContain("arrival keep alive");
    expect(logged.some((l) => /not kept alive/.test(l))).toBe(true);
  });

  it("keeps the contract alive when the sponsor pays", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const paid = await startServer({
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    paid.server.startSweep();
    await new Promise((r) => setTimeout(r, 50));
    await paid.server.stopSweep();
    errors.mockRestore();
    expect(paid.rpc.submissions.map((s) => s.label)).toContain("arrival keep alive");
  });

  it("refuses to start finishing conversions without its own executor key", async () => {
    await expect(startServer({ arrivalContract: ARRIVAL })).rejects.toThrow(/executor key/);
  });

  it("says so when this sponsor finishes none", async () => {
    const server = await startServer();
    const response = await server.post("/compose", good);
    expect(response.status).toBe(404);
    expect(response.body.retryable).toBe(false);
  });

  it("finishes one message at most once in a while, however its guid is written", async () => {
    const server = await startServer({
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    server.rpc.queuedComposes.set(good.guid, queuedHash);
    await server.post("/compose", good);
    const again = await server.post("/compose", { ...good, guid: `0x${good.guid.toUpperCase()}` });
    expect(again.status).toBe(429);
    expect(again.body.retryable).toBe(true);
  });

  it("pays for no finish when accounts fund themselves, since they run their own", async () => {
    const server = await startServer({
      reserveFunding: "self",
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    const response = await server.post("/compose", good);
    expect(response.status).toBe(409);
    expect(response.body.retryable).toBe(false);
    expect(response.body.error).toMatch(/does not pay/);
    expect(server.rpc.submissions).toHaveLength(0);
  });

  it("limits each client's finishes, counted like every other request behind the proxy", async () => {
    const server = await startServer({
      trustProxy: true,
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    const ask = async (client: string, n: number) => {
      const guid = n.toString(16).padStart(64, "0");
      const response = await fetch(`${server.url}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": client },
        body: JSON.stringify({ ...good, guid }),
      });
      return response.status;
    };
    const one: number[] = [];
    for (let n = 0; n < 4; n++) one.push(await ask("198.51.100.7", n));
    expect(one.slice(0, 3)).not.toContain(429);
    expect(one[3]).toBe(429);
    expect(await ask("198.51.100.8", 9)).not.toBe(429);
  });

  it("counts only messages the endpoint really holds against the minute's cap", async () => {
    const server = await startServer({
      trustProxy: true,
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    const ask = async (guid: string, client: string) =>
      (
        await fetch(`${server.url}/compose`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": client },
          body: JSON.stringify({ ...good, guid }),
        })
      ).status;
    // invented guids from many addresses: nothing is queued for any of them
    for (let i = 0; i < 12; i++) {
      expect(await ask(i.toString(16).padStart(64, "0"), `203.0.113.${i}`)).toBe(404);
    }
    // a real one is still finished rather than turned away by the cap
    const real = "ef".repeat(32);
    server.rpc.queuedComposes.set(real, queuedHash);
    expect(await ask(real, "198.51.100.200")).not.toBe(429);
  });

  it("caps how many finishes it will try a minute, across every client", async () => {
    const server = await startServer({
      trustProxy: true,
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const guid = i.toString(16).padStart(64, "0");
      server.rpc.queuedComposes.set(guid, queuedHash);
      // a different address each time, so only the overall cap can refuse
      const response = await fetch(`${server.url}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i}` },
        body: JSON.stringify({ ...good, guid }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it("refuses malformed input before reading anything", async () => {
    const server = await startServer({
      arrivalContract: ARRIVAL,
      arrivalExecutorSecret: Keypair.random().secret(),
    });
    for (const body of [
      { ...good, from: "not an address" },
      { ...good, guid: "abc" },
      { ...good, index: -1 },
      { ...good, index: 1.5 },
      { ...good, message: "0x0" },
      { ...good, message: `0x${"00".repeat(5000)}` },
      {},
    ]) {
      const response = await server.post("/compose", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(response.body.retryable).toBe(false);
    }
  });
});

describe("round 2: a channel is held long only once a landed preparation backs it", () => {
  function skip(seconds: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + seconds * 1000);
  }

  async function postAs(
    server: TestServer,
    client: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Body }> {
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": client },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  /** The whole honest flow for one account, from one client, to a landed preparation. */
  async function prepareAs(server: TestServer, client: string, user: Keypair): Promise<number> {
    const built = await postAs(server, client, "/settlement", {
      destination: user.publicKey(),
      sourceChainId: "1",
    });
    if (built.status !== 200) return built.status;
    const committed = await postAs(server, client, "/settlement/commit", {
      destination: user.publicKey(),
      signedXdr: signXdr(built.body.xdr as string, user),
    });
    if (committed.status !== 200) return committed.status;
    const prepared = await postAs(server, client, "/prepare", {
      destination: user.publicKey(),
      assets: ["USDC"],
      sourceChainId: "1",
    });
    if (prepared.status !== 200) return prepared.status;
    return (
      await postAs(server, client, "/submit", {
        signedXdr: signXdr(prepared.body.xdr as string, user),
      })
    ).status;
  }

  it("(a) one address preparing account after account does not exhaust the pool", async () => {
    // a daily cap of eight sponsorships, and two provisional slots
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 8, "cheap-gas": 8 },
    });
    const server = await startServer(
      { caps, trustProxy: true, provisionalSettlements: 2 },
      { fundsOwnChannel: true },
    );
    // the four submits the re-audit used to take every channel
    for (let i = 0; i < 4; i += 1) {
      expect(await prepareAs(server, "203.0.113.1", Keypair.random())).toBe(200);
    }
    // a new caller still gets a slot to settle on
    const next = await postAs(server, "198.51.100.9", "/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(next.status).toBe(200);
  });

  it("(b) asking again or committing again never lengthens an unbacked slot", async () => {
    const server = await startServer({ trustProxy: true });
    const holder = Keypair.random();
    const ask = () =>
      postAs(server, "203.0.113.1", "/settlement", {
        destination: holder.publicKey(),
        sourceChainId: "1",
      });
    const first = await ask();
    expect(first.status).toBe(200);
    // renewed every few minutes, signed and committed each time
    for (let minute = 3; minute <= 9; minute += 3) {
      skip(180);
      const renewed = await ask();
      if (renewed.status === 200) {
        await postAs(server, "203.0.113.1", "/settlement/commit", {
          destination: holder.publicKey(),
          signedXdr: signXdr(renewed.body.xdr as string, holder),
        });
      }
    }
    skip(91);
    // ten minutes from the first ask, the one channel is free for someone else
    const victim = await postAs(server, "198.51.100.9", "/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(victim.status).toBe(200);
  });

  it("(b) an account whose slot lapsed unbacked waits before it gets another", async () => {
    const pool = [Keypair.random(), Keypair.random()];
    const server = await startServer({
      channels: new ChannelPool({ channels: pool }),
      trustProxy: true,
    });
    for (const channel of pool) server.rpc.accounts.set(channel.publicKey(), 300n);
    const holder = Keypair.random();
    const ask = (client: string) =>
      postAs(server, client, "/settlement", {
        destination: holder.publicKey(),
        sourceChainId: "1",
      });
    expect((await ask("203.0.113.1")).status).toBe(200);
    skip(PROVISIONAL_WINDOW_AND_GRACE_SECONDS);
    // straight back, even from another address, is refused for a while
    const again = await ask("198.51.100.9");
    expect(again.status).toBe(429);
    expect(again.body.retryable).toBe(true);
  });

  it("caps how many unbacked slots are out at once, across every client", async () => {
    const server = await startServer(
      { trustProxy: true, provisionalSettlements: 2 },
      { fundsOwnChannel: true },
    );
    const ask = (client: string) =>
      postAs(server, client, "/settlement", {
        destination: Keypair.random().publicKey(),
        sourceChainId: "1",
      });
    expect((await ask("203.0.113.1")).status).toBe(200);
    expect((await ask("203.0.113.2")).status).toBe(200);
    const third = await ask("203.0.113.3");
    expect(third.status).toBe(503);
    expect(third.body.retryable).toBe(true);
  });

  it("grows its pool to twice the daily cap plus the unbacked slots, and no further", async () => {
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 9, "cheap-gas": 1 },
    });
    const server = await startServer(
      { caps, provisionalSettlements: 1, settlementsPerClient: 0 },
      { fundsOwnChannel: true },
    );
    const health = (await (await fetch(`${server.url}/health`)).json()) as Body;
    // the tighter cap is 1 a day, so at most 2 prepared at once, plus 1 unbacked
    expect((health.channels as Body).maxSize).toBe(3);
  });

  it("settles a held settlement though funding a new channel keeps failing", async () => {
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 4, "cheap-gas": 4 },
    });
    const server = await startServer({ caps, settlementsPerClient: 0 }, { fundsOwnChannel: true });
    const user = Keypair.random();
    await preparedWithSettlementHeld(server, user);
    // from now on every channel funding fails
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, opts) => {
      if (label === "channel funding") throw new MavnaError("funding failed", { retryable: true });
      return submit(label, build, opts);
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // a second account needs a second channel, whose funding fails
    expect(
      (await server.post("/settlement", { destination: Keypair.random().publicKey() })).status,
    ).toBe(503);
    logged.mockRestore();

    server.rpc.holding(user, PLENTY);
    const settled = await server.post("/settle", { destination: user.publicKey() });
    expect(settled.status).toBe(200);
    expect(settled.body.settled).toBe(true);
  });

  it("caps how many open builds one client can leave, so a few cannot fill the ledger", async () => {
    const server = await startServer({ reserveFunding: "self", trustProxy: true });
    const statuses: number[] = [];
    for (let i = 0; i < OPEN_BUILDS_PER_CLIENT + 1; i += 1) {
      const user = Keypair.random();
      server.rpc.accounts.set(user.publicKey(), 1n);
      statuses.push(
        (
          await postAs(server, "203.0.113.1", "/prepare", {
            destination: user.publicKey(),
            assets: ["USDC"],
          })
        ).status,
      );
    }
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const user = Keypair.random();
    server.rpc.accounts.set(user.publicKey(), 1n);
    expect(
      (
        await postAs(server, "203.0.113.2", "/prepare", {
          destination: user.publicKey(),
          assets: ["USDC"],
        })
      ).status,
    ).toBe(200);
  });
});

/** The unrenewable provisional window and the reclaim grace, plus a second. */
const PROVISIONAL_WINDOW_AND_GRACE_SECONDS = 600 + 30 + 1;
/** Open builds one client may leave at once. */
const OPEN_BUILDS_PER_CLIENT = 16;

describe("round 2: unreadable cap counts close sponsorship until repaired", () => {
  it("refuses sponsorship, loudly, while the caps file cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mavna-sponsor-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "caps.json"), "{ not json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer({ state: new FileDocumentStore(dir) });
    await server.server.ready();
    for (const path of ["/prepare", "/settlement"]) {
      const answered = await server.post(path, {
        destination: Keypair.random().publicKey(),
        assets: ["USDC"],
        sourceChainId: "1",
      });
      expect(answered.status, path).toBe(503);
      expect(answered.body.retryable, path).toBe(true);
    }
    expect(errors.mock.calls.flat().join(" ")).toMatch(/caps/);
    errors.mockRestore();
    // left where it is, so it stays refused until someone repairs it
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, "caps.json"), "utf8")).toBe("{ not json");
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses sponsorship while a stored cap day is in the wrong shape", async () => {
    const state = new MemoryDocumentStore();
    const today = new Date().toISOString().slice(0, 10);
    await state.write("caps", { [today]: { stranded: "lots" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer({ state });
    const answered = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    errors.mockRestore();
    expect(answered.status).toBe(503);
  });
});

describe("round 2: a channel funding that failed is retried later, not on every request", () => {
  it("backs off after a failed funding, answering a retryable 503 meanwhile, then tries again", async () => {
    const caps = new CapLedger(new InMemoryCapStore(), {
      strandingCapPerDay: 75,
      volumeCapPerDay: { "expensive-gas": 4, "cheap-gas": 4 },
    });
    const server = await startServer({ caps, settlementsPerClient: 0 }, { fundsOwnChannel: true });
    let attempts = 0;
    let failing = true;
    const submit = server.rpc.submit.bind(server.rpc);
    server.rpc.submit = async (label, build, opts) => {
      if (label === "channel funding") {
        attempts += 1;
        if (failing) throw new MavnaError("channel funding failed on-chain.", { retryable: false });
      }
      return submit(label, build, opts);
    };
    const ask = () => server.post("/settlement", { destination: Keypair.random().publicKey() });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await ask()).status).toBe(503);
    expect(attempts).toBe(1);
    // within the backoff nothing is resent
    const meanwhile = await ask();
    expect(meanwhile.status).toBe(503);
    expect(meanwhile.body.retryable).toBe(true);
    expect(attempts).toBe(1);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/channel funding/);
    logged.mockRestore();

    failing = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await ask()).status).toBe(200);
    expect(attempts).toBe(2);
  });
});
