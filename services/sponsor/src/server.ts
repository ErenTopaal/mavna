import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import { buildPreparation, buildSettlement, classifyAddress, XlmPriceSource } from "@mavna/stellar";
import { type Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  CapLedger,
  classifySourceChain,
  DEFAULT_CHEAP_GAS_CHAINS,
  InMemoryCapStore,
} from "./caps.js";
import { ChannelPool } from "./channels.js";
import { Deliverer, type DeliveryOutcome } from "./deliver.js";

/**
 * The small server the specification says must exist, and what it may not do.
 *
 * Two things force a server into an otherwise client-side product: sponsorship
 * needs a funded signer, and a funded signer cannot live in a browser. This is
 * that signer's home, and its entire authority is listed in the routes below:
 * it prepares accounts it pays for, and it triggers deliveries whose recipient
 * is fixed inside Circle's attested message. It never holds user funds, never
 * signs a user's transfer, and never sees a user's key.
 *
 * Self-hostable by construction: plain node:http, no framework, every endpoint
 * configurable, run it with your own keys and none of our limits are yours.
 */

export interface SponsorServerOptions {
  readonly rpc: RpcClient;
  readonly network: NetworkConfig;
  readonly networkId: "testnet" | "mainnet";
  /** The sponsor's secret. Operational; never logged, never serialised. */
  readonly sponsorSecret: string;
  /**
   * The assets this sponsor will open trustlines for, by name.
   *
   * A curated list with a named curator, because anyone can issue an asset
   * called USDC and sponsoring a trustline to an imitation costs a real deposit
   * and dresses a phishing asset in our credibility. Clients ask by name and
   * the issuer comes from here, never from the request.
   */
  readonly curatedAssets: Readonly<Record<string, Asset>>;
  /** Builds the CCTP delivery. Injected as in the Deliverer. */
  readonly buildDelivery: ConstructorParameters<typeof Deliverer>[0]["buildDelivery"];
  /** Where Circle's attestation service lives. */
  readonly irisUrl: string;
  readonly caps?: CapLedger;
  /**
   * Channel accounts, which carry settlement sequence numbers.
   *
   * A pre-signed settlement occupies its channel's sequence until it lands or
   * expires, so one channel serves exactly one in-flight settlement. Given none,
   * the server creates and funds one from the sponsor on first use, which is a
   * capacity of one concurrent settlement: enough to run everything yourself,
   * and the pool is the knob when it is not.
   */
  readonly channels?: ChannelPool;
  /** Prices the reserve in the arriving asset, for the settlement's ceiling. */
  readonly prices?: XlmPriceSource;
  /**
   * Origins allowed to call this from a browser. The app's own origin in
   * production; localhost while developing. Never `*`: this server spends
   * money on request.
   */
  readonly allowedOrigins: readonly string[];
}

interface PrepareBody {
  readonly destination?: string;
  readonly assets?: readonly string[];
  readonly sourceChainId?: string;
}

interface SubmitBody {
  readonly signedXdr?: string;
}

interface DeliverBody {
  readonly txHash?: string;
  readonly domain?: number;
  /**
   * Who the transfer is for, so a held settlement can be submitted the moment
   * the delivery lands. Optional: a delivery without it still mints, and the
   * settlement waits for the next call that names the account.
   */
  readonly destination?: string;
}

interface SettlementBody {
  readonly destination?: string;
  readonly sourceChainId?: string;
}

interface SettlementCommitBody {
  readonly destination?: string;
  readonly signedXdr?: string;
}

/** One JSON answer shape, so callers never parse two formats. */
const reply = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  origin: string | undefined,
): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(origin === undefined ? {} : { "access-control-allow-origin": origin }),
  });
  res.end(JSON.stringify(body));
};

export function createSponsorServer(options: SponsorServerOptions): Server {
  const keypair = Keypair.fromSecret(options.sponsorSecret);
  const caps = options.caps ?? new CapLedger(new InMemoryCapStore());
  const deliverer = new Deliverer({
    rpc: options.rpc,
    network: options.network,
    networkId: options.networkId,
    payerSecret: options.sponsorSecret,
    buildDelivery: options.buildDelivery,
  });

  /**
   * Settlements collected before any capital moved, waiting for delivery.
   *
   * Held in memory, which is the honest scope of this deployment: a settlement
   * that dies with the process leaves the user's funds untouched and the
   * sponsor still sponsoring, which is the recoverable direction. The doc's
   * §6.1 loss needs the bridge to fail, not us.
   */
  const heldSettlements = new Map<string, { xdr: string; createdAtUnix: number }>();
  let channels = options.channels;
  const prices =
    options.prices ??
    new XlmPriceSource({
      horizonUrl:
        options.networkId === "mainnet"
          ? "https://horizon.stellar.org"
          : "https://horizon-testnet.stellar.org",
    });

  /**
   * The one channel this deployment runs on, created and funded on first use.
   *
   * 2 XLM: the account's own 1 XLM minimum plus fee headroom for the
   * settlements it will carry. Reused serially; the pool is the upgrade path.
   */
  async function ensureChannels(): Promise<ChannelPool> {
    if (channels !== undefined) return channels;
    const channel = Keypair.random();
    const sponsorAccount = await options.rpc.loadAccount(keypair.publicKey());
    const create = new TransactionBuilder(sponsorAccount, {
      fee: "1000000",
      networkPassphrase: options.network.passphrase,
    })
      .addOperation(
        Operation.createAccount({ destination: channel.publicKey(), startingBalance: "2" }),
      )
      .setTimeout(120)
      .build();
    create.sign(keypair);
    await options.rpc.submit("channel funding", async () => create);
    channels = new ChannelPool({ channels: [channel] });
    return channels;
  }

  const corsOrigin = (req: IncomingMessage): string | undefined => {
    const origin = req.headers.origin;
    return origin !== undefined && options.allowedOrigins.includes(origin) ? origin : undefined;
  };

  return createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      // Nothing internal reaches the wire. A caller learns that it failed and
      // whether to retry; the operator reads the rest from the process log.
      console.error("[sponsor]", cause instanceof Error ? cause.message : cause);
      reply(
        res,
        500,
        { error: "That did not work. Nothing was spent.", retryable: true },
        corsOrigin(req),
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = corsOrigin(req);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(origin === undefined ? 403 : 204, {
        ...(origin === undefined ? {} : { "access-control-allow-origin": origin }),
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      reply(
        res,
        200,
        { ok: true, network: options.networkId, sponsor: keypair.publicKey() },
        origin,
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/prepare") {
      await prepare((await readJson(req)) as PrepareBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      await submit((await readJson(req)) as SubmitBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement") {
      await settlement((await readJson(req)) as SettlementBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/settlement/commit") {
      await settlementCommit((await readJson(req)) as SettlementCommitBody, res, origin);
      return;
    }
    if (req.method === "POST" && url.pathname === "/deliver") {
      await deliver((await readJson(req)) as DeliverBody, res, origin);
      return;
    }

    reply(res, 404, { error: "No such endpoint.", retryable: false }, origin);
  }

  /**
   * Build the preparation for the user to sign.
   *
   * Nothing is spent here and nothing is signed here: the transaction goes back
   * unsigned, the user signs the operations that create obligations on their own
   * account, and only /submit commits the sponsor. The caps are checked at this
   * step too, so a refusal happens before anyone is asked for a signature.
   */
  async function prepare(
    body: PrepareBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.destination === undefined) {
      reply(res, 400, { error: "Say which account to prepare.", retryable: false }, origin);
      return;
    }

    const decision = await caps.check(
      classifySourceChain(body.sourceChainId ?? "unknown", DEFAULT_CHEAP_GAS_CHAINS),
    );
    if (!decision.allowed) {
      reply(res, 429, { error: decision.reason, retryable: true }, origin);
      return;
    }

    const assets = (body.assets ?? ["USDC"]).map((name) => options.curatedAssets[name]);
    if (assets.some((asset) => asset === undefined)) {
      // By name from the curated list, never by issuer from the wire: sponsoring
      // a trustline to an imitation asset is paying to phish our own users.
      reply(
        res,
        400,
        { error: "This sponsor only prepares accounts for assets it curates.", retryable: false },
        origin,
      );
      return;
    }

    let created: boolean;
    try {
      const classified = classifyAddress(body.destination);
      if (!classified.needsTrustline) {
        reply(
          res,
          400,
          { error: "That address can already receive; nothing to prepare.", retryable: false },
          origin,
        );
        return;
      }
      created = !(await accountExists(options.rpc, classified.trustlineHolder ?? body.destination));
    } catch {
      reply(
        res,
        400,
        { error: "That is not an address a Stellar account can use.", retryable: false },
        origin,
      );
      return;
    }

    const sponsorAccount = await options.rpc.loadAccount(keypair.publicKey());
    const transaction = buildPreparation({
      network: options.network,
      sponsorAccount,
      userAddress: body.destination,
      createAccount: created,
      assets: assets as Asset[],
    });

    reply(res, 200, { xdr: transaction.toXDR(), sponsor: keypair.publicKey() }, origin);
  }

  /**
   * Build the settlement for the user to sign, before anything is committed.
   *
   * This is §5.2 of the cost decision, the piece that turns the deposit from a
   * permanent gift into a loan: one transaction, one amount, bounded life,
   * signed while the user is present. It buys exactly the XLM the reserve needs
   * out of the arriving money and hands the obligation over, releasing the
   * sponsor's capital to serve the next person.
   */
  async function settlement(
    body: SettlementBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.destination === undefined) {
      reply(res, 400, { error: "Say which account will settle.", retryable: false }, origin);
      return;
    }
    const decision = await caps.check(
      classifySourceChain(body.sourceChainId ?? "unknown", DEFAULT_CHEAP_GAS_CHAINS),
    );
    if (!decision.allowed) {
      reply(res, 429, { error: decision.reason, retryable: true }, origin);
      return;
    }

    const usdc = options.curatedAssets.USDC;
    if (usdc === undefined) {
      reply(
        res,
        500,
        { error: "This sponsor curates no settling asset.", retryable: false },
        origin,
      );
      return;
    }

    let createdAccount: boolean;
    try {
      const classified = classifyAddress(body.destination);
      if (!classified.needsTrustline) {
        reply(res, 400, { error: "That address needs no settling.", retryable: false }, origin);
        return;
      }
      createdAccount = !(await accountExists(
        options.rpc,
        classified.trustlineHolder ?? body.destination,
      ));
    } catch {
      reply(res, 400, { error: "That is not a usable Stellar address.", retryable: false }, origin);
      return;
    }

    const pool = await ensureChannels();
    const channel = pool.acquire(body.destination);
    if (channel === undefined) {
      reply(
        res,
        503,
        { error: "Every settlement slot is in use. Try again shortly.", retryable: true },
        origin,
      );
      return;
    }

    // Account 2 slots + one trustline = 3, or 1 when the account already exists.
    const slots = createdAccount ? 3 : 1;
    const xlmNeededStroops = BigInt(slots) * BigInt(options.network.baseReserveStroops);
    // The ceiling is twice the reserve at the live rate: generous enough that
    // ordinary movement between signing and settling is absorbed, bounded enough
    // that the user's exposure is a number they can read.
    const stroopsPerUsdc = await prices.xlmStroopsPerUnit(usdc);
    const maxSpendBase = (xlmNeededStroops * 2n * 10_000_000n) / stroopsPerUsdc;

    const channelAccount = await options.rpc.loadAccount(channel.address);
    const transaction = buildSettlement({
      network: options.network,
      channelAccount,
      sponsorAddress: keypair.publicKey(),
      userAddress: body.destination,
      payingAsset: usdc,
      xlmNeeded: stroopsToDecimal(xlmNeededStroops),
      maxSpend: stroopsToDecimal(maxSpendBase),
      assets: [usdc],
      createdAccount,
    });

    reply(res, 200, { xdr: transaction.toXDR(), channel: channel.address }, origin);
  }

  /**
   * Hold what the user signed until their money lands.
   *
   * Nothing is signed by the server here: the channel and sponsor signatures go
   * on at submission time, so what sits in memory can move nothing on its own.
   */
  async function settlementCommit(
    body: SettlementCommitBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.destination === undefined || body.signedXdr === undefined) {
      reply(
        res,
        400,
        { error: "Send the destination and the signed settlement.", retryable: false },
        origin,
      );
      return;
    }
    const transaction = TransactionBuilder.fromXDR(body.signedXdr, options.network.passphrase);
    if ("innerTransaction" in transaction) {
      reply(res, 400, { error: "Fee bumps are not accepted here.", retryable: false }, origin);
      return;
    }
    const allowed = new Set([
      "pathPaymentStrictReceive",
      "revokeTrustlineSponsorship",
      "revokeAccountSponsorship",
      "revokeSponsorship",
    ]);
    if (transaction.operations.some((op) => !allowed.has(op.type))) {
      reply(
        res,
        400,
        { error: "That transaction does more than settle.", retryable: false },
        origin,
      );
      return;
    }
    heldSettlements.set(body.destination, {
      xdr: body.signedXdr,
      createdAtUnix: Math.floor(Date.now() / 1000),
    });
    reply(res, 200, { held: true }, origin);
    return Promise.resolve();
  }

  /**
   * Submit a held settlement, once the money it spends from exists.
   *
   * Failure here is the recoverable direction: the user keeps everything that
   * arrived and the sponsor stays sponsoring, retryable from the same held
   * transaction until its time bound. A permanent failure is recorded against
   * the stranding cap, which is the exposure brake.
   */
  async function settleIfHeld(destination: string): Promise<Record<string, unknown>> {
    const held = heldSettlements.get(destination);
    if (held === undefined) return { settled: false };
    const pool = await ensureChannels();

    const transaction = TransactionBuilder.fromXDR(held.xdr, options.network.passphrase);
    if ("innerTransaction" in transaction) return { settled: false };
    const channelKeypair = pool.keypairFor(transaction.source);
    if (channelKeypair === undefined) return { settled: false };

    try {
      transaction.sign(channelKeypair);
      transaction.sign(keypair);
      const result = await options.rpc.submit("settlement", async () => transaction);
      heldSettlements.delete(destination);
      pool.release(destination);
      return { settled: true, settlementTxHash: result.txHash };
    } catch (cause) {
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      if (!retryable) {
        // The held transaction can never land. The capital it would have
        // released is now the §6.1 loss, counted where the brake can see it.
        await caps.recordStranded();
        heldSettlements.delete(destination);
        pool.release(destination);
      }
      return { settled: false, settlementRetryable: retryable };
    }
  }

  /** Countersign what the user signed, and submit it. This is where money moves. */
  async function submit(
    body: SubmitBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.signedXdr === undefined) {
      reply(res, 400, { error: "Send the signed transaction back.", retryable: false }, origin);
      return;
    }

    const transaction = TransactionBuilder.fromXDR(body.signedXdr, options.network.passphrase);
    if ("innerTransaction" in transaction) {
      reply(res, 400, { error: "Fee bumps are not accepted here.", retryable: false }, origin);
      return;
    }
    // The sponsor signs only transactions it built: its own account as source,
    // and nothing but sponsorship operations inside. Anything else is someone
    // trying to get a free signature out of a funded key.
    if (transaction.source !== keypair.publicKey()) {
      reply(
        res,
        400,
        { error: "That is not a transaction this sponsor built.", retryable: false },
        origin,
      );
      return;
    }
    const allowed = new Set([
      "beginSponsoringFutureReserves",
      "endSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
    ]);
    if (transaction.operations.some((op) => !allowed.has(op.type))) {
      reply(
        res,
        400,
        { error: "That transaction does more than prepare an account.", retryable: false },
        origin,
      );
      return;
    }

    // The governing order: no capital commits until the settlement that releases
    // it is already signed and held. Without this the deposit is a gift, which is
    // the model the cost decision explicitly rejected.
    const beneficiary = transaction.operations
      .map((op) =>
        op.type === "createAccount"
          ? op.destination
          : op.type === "changeTrust"
            ? (op.source ?? undefined)
            : undefined,
      )
      .find((address) => address !== undefined);
    if (beneficiary === undefined || !heldSettlements.has(beneficiary)) {
      reply(
        res,
        409,
        {
          error:
            "No settlement is held for this account. The deposit is a loan, and the " +
            "repayment is signed before the loan is made, not after.",
          retryable: false,
        },
        origin,
      );
      return;
    }

    transaction.sign(keypair);
    try {
      const result = await options.rpc.submit("sponsored preparation", async () => transaction);
      await caps.recordStarted(classifySourceChain("unknown", DEFAULT_CHEAP_GAS_CHAINS));
      reply(res, 200, { txHash: result.txHash, ledger: result.ledger }, origin);
    } catch (cause) {
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      reply(res, 502, { error: "The preparation could not be submitted.", retryable }, origin);
    }
  }

  /** Trigger the mint for an attested burn. Idempotent; retrying is always safe. */
  async function deliver(
    body: DeliverBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.txHash === undefined) {
      reply(res, 400, { error: "Say which transaction to deliver.", retryable: false }, origin);
      return;
    }

    const domain = body.domain ?? 0;
    const iris = await fetch(
      `${options.irisUrl}/v2/messages/${domain}?transactionHash=${body.txHash}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const parsed = (await iris.json()) as {
      messages?: readonly { message?: string; attestation?: string; status?: string }[];
    };
    const message = parsed.messages?.[0];
    if (message?.message === undefined || message.attestation === undefined) {
      reply(
        res,
        404,
        { error: "Circle has no attested record of that transaction yet.", retryable: true },
        origin,
      );
      return;
    }

    const outcome: DeliveryOutcome = await deliverer.deliver({
      messageHex: message.message,
      attestationHex: message.attestation,
    });

    // The lateness rule's payoff: the settlement was signed before anything
    // moved, and the moment the delivery lands it is submitted, releasing the
    // sponsor's capital in the same breath.
    const settled =
      (outcome.kind === "delivered" || outcome.kind === "already-delivered") &&
      body.destination !== undefined
        ? await settleIfHeld(body.destination)
        : {};

    reply(
      res,
      outcome.kind === "recipient-not-ready" ? 409 : 200,
      { ...outcome, ...settled },
      origin,
    );
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MavnaError("The request body is not JSON.", { retryable: false });
  }
}

/** Stroops to Horizon's decimal form, integer arithmetic only. */
function stroopsToDecimal(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

async function accountExists(rpc: RpcClient, address: string): Promise<boolean> {
  try {
    await rpc.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}
