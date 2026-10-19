import type { AddressInfo } from "node:net";
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
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { signedBy } from "./built.js";
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

const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

// Unroutable on purpose: a method this double does not override fails at once
// instead of quietly reaching testnet.
const NOWHERE = "https://127.0.0.1:9";

/** Accounts known to exist, and every transaction handed over for submission. */
class RecordingRpc extends RpcClient {
  readonly accounts = new Map<string, bigint>();
  readonly submissions: { label: string; tx: Transaction | FeeBumpTransaction }[] = [];

  constructor() {
    super({ url: NOWHERE });
  }

  override async loadAccount(address: string): Promise<Account> {
    const sequence = this.accounts.get(address);
    if (sequence === undefined) throw new Error(`account ${address} not found`);
    return new Account(address, sequence.toString());
  }

  override async submit(
    label: string,
    build: () => Promise<Transaction | FeeBumpTransaction>,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const tx = await build();
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
}

type Body = Record<string, unknown>;

const running: { close(): void }[] = [];

afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

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
    irisUrl: NOWHERE,
    channels: new ChannelPool({ channels: [channel] }),
    prices: new FixedPrice(),
    allowedOrigins: [],
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    rpc: recording,
    sponsor,
    channel,
    async post(path, body) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Body };
    },
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
    expect(server.rpc.submissions).toHaveLength(0);
  });
});
