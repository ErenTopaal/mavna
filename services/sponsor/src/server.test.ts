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
import { createSponsorServer, type SponsorServerOptions } from "./server.js";

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

/** Accounts known to exist, and every transaction handed over for submission. */
class RecordingRpc extends RpcClient {
  readonly accounts = new Map<string, bigint>();
  readonly submissions: { label: string; tx: Transaction | FeeBumpTransaction }[] = [];
  /** Set to make the next submission fail the way a network rejection does. */
  rejectNext: MavnaError | undefined;

  /** USDC trustline balances in stroops, by account. */
  readonly trustlines = new Map<string, bigint>();

  constructor() {
    super({ url: NOWHERE });
    // The ledger read every balance check goes through, answered from the maps
    // above instead of a node.
    this.server.getLedgerEntries = async (...keys: xdr.LedgerKey[]) => ({
      latestLedger: 1,
      entries: keys.flatMap((key) => {
        const val = this.entryFor(key);
        return val === undefined ? [] : [{ key, val, lastModifiedLedgerSeq: 1 }];
      }),
    });
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
    this.accounts.set(user.publicKey(), 1n);
    this.trustlines.set(user.publicKey(), usdcStroops);
  }

  override async loadAccount(address: string): Promise<Account> {
    const sequence = this.accounts.get(address);
    if (sequence === undefined) throw new Error(`account ${address} not found`);
    return new Account(address, sequence.toString());
  }

  /** Simulation is a network call; what it would add does not matter to these tests. */
  override async prepare(tx: Transaction): Promise<Transaction> {
    return tx;
  }

  override async submit(
    label: string,
    build: () => Promise<Transaction | FeeBumpTransaction>,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const tx = await build();
    const rejection = this.rejectNext;
    if (rejection !== undefined) {
      this.rejectNext = undefined;
      throw rejection;
    }
    this.submissions.push({ label, tx });
    const now = Math.floor(Date.now() / 1000);
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: tx.hash().toString("hex"),
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
    };
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

async function startServer(overrides: Partial<SponsorServerOptions> = {}): Promise<TestServer> {
  const sponsor = Keypair.random();
  const channel = Keypair.random();
  const recording = new RecordingRpc();
  recording.accounts.set(sponsor.publicKey(), 100n);
  recording.accounts.set(channel.publicKey(), 200n);

  const server = createSponsorServer({
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
  });
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
    await holdSettlementFor(server, user);
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
    await holdSettlementFor(server, victim);
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
    await holdSettlementFor(server, solanaUser);
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

    await holdSettlementFor(server, starknetUser);

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
      await holdSettlementFor(server, user);
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
    await holdSettlementFor(server, user);
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

  it("settles nothing on a message not bound for Stellar", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
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

  it("does not submit an expired settlement when the delivery lands", async () => {
    const server = await startServer({ buildDelivery });
    const user = Keypair.random();
    await holdSettlementFor(server, user);
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
