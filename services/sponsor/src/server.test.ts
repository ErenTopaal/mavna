import type { AddressInfo } from "node:net";
import {
  buildBurn,
  buildDelivery,
  CCTP_CONTRACTS,
  contractAddressToBytes32,
  EVM_DEPLOYMENTS,
  SOLANA_PROGRAMS,
  STARKNET_DEPLOYMENTS,
  solanaAddressToBytes32,
  toHex,
} from "@mavna/adapter-cctp";
import { MavnaError } from "@mavna/core";
import {
  createNetworkConfig,
  PUBLIC_TESTNET_RPC_URL,
  RpcClient,
  type SubmitOptions,
  XlmPriceSource,
} from "@mavna/stellar";
import {
  Account,
  Asset,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  rpc,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedBy } from "./built.js";
import { CapLedger, type CapUsage, InMemoryCapStore } from "./caps.js";
import { ChannelPool } from "./channels.js";
import { createSponsorServer, type SponsorServer, type SponsorServerOptions } from "./server.js";

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
    this.server.sendTransaction = async (tx) => {
      const label = this.labels.get(tx.hash().toString("hex"));
      const stall = label === undefined ? undefined : this.stalls.get(label);
      if (label !== undefined && stall !== undefined) {
        this.stalls.delete(label);
        await stall();
      }
      return this.send(tx);
    };
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

  private entryFor(key: xdr.LedgerKey): xdr.LedgerEntryData | undefined {
    if (key.switch().name === "account") {
      const accountId = key.account().accountId();
      const sequence = this.accounts.get(StrKey.encodeEd25519PublicKey(accountId.ed25519()));
      if (sequence === undefined) return undefined;
      return xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId,
          balance: xdr.Int64.fromString("100000000"),
          seqNum: xdr.Int64.fromString(sequence.toString()),
          numSubEntries: 1,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: new xdr.AccountEntryExt(0),
        }),
      );
    }
    if (key.switch().name === "trustline") {
      const line = key.trustLine();
      if (line.asset().toXDR("hex") !== USDC.toTrustLineXDRObject().toXDR("hex")) return undefined;
      const balance = this.trustlines.get(
        StrKey.encodeEd25519PublicKey(line.accountId().ed25519()),
      );
      if (balance === undefined) return undefined;
      return xdr.LedgerEntryData.trustline(
        new xdr.TrustLineEntry({
          accountId: line.accountId(),
          asset: line.asset(),
          balance: xdr.Int64.fromString(balance.toString()),
          limit: xdr.Int64.fromString("9223372036854775807"),
          flags: 1,
          ext: new xdr.TrustLineEntryExt(0),
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
      this.labels.set(tx.hash().toString("hex"), label);
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
    const hash = tx.hash().toString("hex");
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
        ext: new xdr.TransactionResultExt(0),
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
    const hash = tx.hash().toString("hex");
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
        ext: new xdr.TransactionResultExt(0),
      }),
      resultMetaXdr: new xdr.TransactionMeta(0, []),
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
  /** Leave out the harness's channel, so the server funds its own on first use. */
  { fundsOwnChannel = false }: { fundsOwnChannel?: boolean } = {},
): Promise<TestServer> {
  const sponsor = Keypair.random();
  const channel = Keypair.random();
  const recording = new RecordingRpc();
  recording.accounts.set(sponsor.publicKey(), 100n);
  recording.accounts.set(channel.publicKey(), 200n);

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
  const tx = TransactionBuilder.fromXDR(xdrText, network.passphrase) as Transaction;
  for (const signer of signers) tx.sign(signer);
  return tx.toXDR();
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
      signedXdr: junk.toXDR(),
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

    const response = await server.post("/submit", { signedXdr: forged.toXDR() });
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
      signedXdr: forged.toXDR(),
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
    expect(response.body.txHash).toBe(submitted.hash().toString("hex"));
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
    // Another transfer from the same class of chain takes today's last slot
    // between this user's preparation and their signature coming back.
    await caps.recordStarted("expensive-gas");

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
    // Arc routes on testnet and not on mainnet. Nothing here reaches any network.
    const asked = stubIris(notFound);
    const testnet = await startServer();
    expect((await testnet.post("/deliver", { txHash: EVM_HASH, domain: 26 })).status).toBe(404);
    const mainnet = await startServer({ networkId: "mainnet" });
    expect((await mainnet.post("/deliver", { txHash: EVM_HASH, domain: 26 })).status).toBe(400);
    expect(asked).toHaveLength(1);
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
  word(amount.toString(16)).copy(body, 68);
  word(maxFee.toString(16)).copy(body, 132);

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
    expect(response.body.settlementTxHash).toBe(submitted.hash().toString("hex"));
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
    expect(later.body.settlementTxHash).toBe(landed.hash().toString("hex"));
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
    server.rpc.holding(victim, PLENTY);
    await holdSettlementFor(server, victim);
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

    // Still held: the victim's own preparation goes through and the settlement
    // fires once it has landed.
    const submitted = await server.post("/submit", {
      signedXdr: await preparedAndSigned(server, victim),
    });
    expect(submitted.status).toBe(200);
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
    expect(response.body.txHash).toBe(submitted.hash().toString("hex"));
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
      settlementTxHash: submitted.hash().toString("hex"),
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
    expect(after.body.settlementTxHash).toBe(submitted?.hash().toString("hex"));
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
    expect(again.body.settlementTxHash).toBe(landed.hash().toString("hex"));
    expect((await caps.usage()).stranded).toBe(0);
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

  it("refuses a preparation that opens trustlines the settlement does not repay", async () => {
    const EURC = new Asset("EURC", Keypair.random().publicKey());
    const server = await startServer({ curatedAssets: { USDC, EURC } });
    const user = Keypair.random();
    await holdSettlementFor(server, user);

    const both = await server.post("/prepare", {
      destination: user.publicKey(),
      assets: ["USDC", "EURC"],
      sourceChainId: "1",
    });
    expect(both.status).toBe(200);
    const response = await server.post("/submit", {
      signedXdr: signXdr(both.body.xdr as string, user),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(MISMATCH);
    expect(server.rpc.submissions).toHaveLength(0);

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
    await caps.recordStarted("expensive-gas");

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
});

describe("a settlement slot is held for a day only once the settlement is signed", () => {
  function skip(seconds: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + seconds * 1000);
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

    // Five minutes and the clock-drift grace later, it is free again.
    skip(300);
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

  it("keeps a signed settlement's channel until the settlement's own time bound", async () => {
    const server = await startServer();
    await holdSettlementFor(server, Keypair.random());

    skip(3_600);
    const later = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(later.status).toBe(503);
  });
});

describe("the sponsor does not take a failed read for a missing account", () => {
  function failAccountReads(server: TestServer, user: Keypair): void {
    const read = server.rpc.server.getLedgerEntries.bind(server.rpc.server);
    server.rpc.server.getLedgerEntries = async (...keys) => {
      const asksForUser = keys.some(
        (key) =>
          key.switch().name === "account" &&
          StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519()) === user.publicKey(),
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

  it("funds one channel when the first two settlements are asked for at once", async () => {
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
    expect(funded()).toBe(1);
    expect(answers.map((a) => a.status).sort((a, b) => a - b)).toEqual([200, 503]);
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
    expect(failed.status).toBe(500);
    const retried = await server.post("/settlement", {
      destination: Keypair.random().publicKey(),
      sourceChainId: "1",
    });
    expect(retried.status).toBe(200);
    expect(funded()).toBe(2);
    logged.mockRestore();
  });
});
