import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CCTP_CONTRACTS,
  contractAddressToBytes32,
  EVM_DEPLOYMENTS,
  fromHex,
  NON_EVM_CHAINS,
  parseForwarderHookData,
  SOLANA_PROGRAMS,
  STARKNET_DEPLOYMENTS,
  solanaAddressToBytes32,
  stellarDomainFor,
} from "@mavna/adapter-cctp";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import {
  buildPreparation,
  buildSettlement,
  classifyAddress,
  inspectDestination,
  XlmPriceSource,
} from "@mavna/stellar";
import {
  type Asset,
  Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { BuiltLedger, type BuiltRecord, signedBy } from "./built.js";
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
  readonly txHash?: unknown;
  readonly domain?: unknown;
  /**
   * Accepted from older clients and never acted on. Who the transfer is for is
   * read from Circle's attested message, the one source a caller cannot choose.
   */
  readonly destination?: unknown;
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
  const heldSettlements = new Map<
    string,
    {
      xdr: string;
      createdAtUnix: number;
      sourceChainId: string;
      channel: string | undefined;
      maxTimeUnix: number;
    }
  >();

  /**
   * The held settlement for an account, if it can still land. One past its
   * time bound never will, so sponsoring against it would be the gift the
   * ordering exists to prevent, and it is dropped. Its channel is not released
   * here: the lease ends on its own at the same bound, and by now the account
   * may hold a newer lease on the same channel for a settlement still live.
   */
  function liveSettlement(destination: string) {
    const held = heldSettlements.get(destination);
    if (held === undefined) return undefined;
    if (held.maxTimeUnix <= nowUnix()) {
      heldSettlements.delete(destination);
      return undefined;
    }
    return held;
  }
  /**
   * What this server built and has not yet seen signed. The funded key signs
   * nothing whose hash is not in here, because a signature check on a body the
   * caller chose proves only that the caller can sign.
   */
  const built = new BuiltLedger();
  const expected = expectedMessageFields(options.networkId);
  /** Circle domains this network routes into Stellar from, and nothing else. */
  const sourceDomains = new Set(
    [
      ...Object.values(EVM_DEPLOYMENTS[options.networkId]),
      ...Object.values(NON_EVM_CHAINS[options.networkId]),
    ].map((chain) => chain.domain),
  );
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

  /**
   * Turn down a transaction the server did build, and put its record back. The
   * refusal is about this request, not the transaction: the right signature or
   * a settlement held a moment later makes the same body acceptable, and a
   * stranger who replays someone's transaction should not be able to burn it.
   */
  function refuse(
    record: BuiltRecord,
    res: ServerResponse,
    origin: string | undefined,
    status: number,
    error: string,
    retryable = false,
  ): void {
    built.record(record);
    reply(res, status, { error, retryable }, origin);
  }

  const corsOrigin = (req: IncomingMessage): string | undefined => {
    const origin = req.headers.origin;
    return origin !== undefined && options.allowedOrigins.includes(origin) ? origin : undefined;
  };

  return createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      if (cause instanceof RequestError) {
        reply(res, cause.status, { error: cause.message, retryable: false }, corsOrigin(req));
        return;
      }
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
    built.record({
      hash: transaction.hash().toString("hex"),
      kind: "preparation",
      destination: body.destination,
      signer: signerFor(body.destination),
      sourceChainId: body.sourceChainId ?? "unknown",
      expiresAtUnix: expiryOf(transaction),
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
    const now = nowUnix();
    const channel = pool.acquire(body.destination, now + SETTLEMENT_VALIDITY_SECONDS, now);
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
      validForSeconds: SETTLEMENT_VALIDITY_SECONDS,
    });
    // The builder reads the clock again, so its bound can be a second past the
    // lease. Pin the lease to the bound the network will actually enforce.
    pool.acquire(body.destination, expiryOf(transaction), now);
    built.record({
      hash: transaction.hash().toString("hex"),
      kind: "settlement",
      destination: body.destination,
      signer: signerFor(body.destination),
      sourceChainId: body.sourceChainId ?? "unknown",
      expiresAtUnix: expiryOf(transaction),
      channel: channel.address,
    });

    reply(res, 200, { xdr: transaction.toXDR(), channel: channel.address }, origin);
  }

  /**
   * Hold what the user signed until their money lands.
   *
   * Nothing is signed by the server here: the channel and sponsor signatures go
   * on at submission time, so what sits in memory can move nothing on its own.
   * That makes what gets held the whole question, so only a settlement this
   * server built, signed by the account it was built for, is held, and only
   * under that account.
   */
  async function settlementCommit(
    body: SettlementCommitBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (body.signedXdr === undefined) {
      reply(res, 400, { error: "Send the signed settlement.", retryable: false }, origin);
      return;
    }
    const transaction = parseTransaction(body.signedXdr, options.network.passphrase);
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

    const record = built.take(transaction.hash().toString("hex"), "settlement", nowUnix());
    if (record === undefined) {
      reply(
        res,
        409,
        {
          error: "That settlement was not built here, or has expired. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }
    if (body.destination !== undefined && body.destination !== record.destination) {
      refuse(record, res, origin, 400, "That settlement was built for a different account.");
      return;
    }
    if (!signedBy(transaction, record.signer)) {
      refuse(record, res, origin, 400, "That settlement is not signed by the account it is for.");
      return;
    }

    heldSettlements.set(record.destination, {
      xdr: body.signedXdr,
      createdAtUnix: nowUnix(),
      sourceChainId: record.sourceChainId,
      channel: record.channel,
      maxTimeUnix: record.expiresAtUnix,
    });
    reply(res, 200, { held: true }, origin);
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
    const held = liveSettlement(destination);
    if (held === undefined) return { settled: false };
    const pool = await ensureChannels();

    const transaction = TransactionBuilder.fromXDR(held.xdr, options.network.passphrase);
    if ("innerTransaction" in transaction) return { settled: false };
    const channelKeypair = pool.keypairFor(transaction.source);
    if (channelKeypair === undefined) return { settled: false };

    // A delivery landing proves Circle minted something, not that it was this
    // user's transfer or enough of it. Submitting before the money is there
    // fails on-chain, burns the channel's sequence, and counts as a stranding,
    // so a dust burn naming someone would spend their settlement for them.
    let covered: boolean;
    try {
      covered = await holdsEnoughToSettle(destination, transaction);
    } catch (cause) {
      console.error(
        "[sponsor] could not read the recipient's balance before settling:",
        cause instanceof Error ? cause.message : cause,
      );
      return { settled: false, settlementRetryable: true };
    }
    if (!covered) return { settled: false, settlementRetryable: true };

    try {
      transaction.sign(channelKeypair);
      transaction.sign(keypair);
      const result = await options.rpc.submit("settlement", async () => transaction);
      heldSettlements.delete(destination);
      pool.release(destination, transaction.source);
      return { settled: true, settlementTxHash: result.txHash };
    } catch (cause) {
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      if (!retryable) {
        // The held transaction can never land. The capital it would have
        // released is now the §6.1 loss, counted where the brake can see it.
        await caps.recordStranded();
        heldSettlements.delete(destination);
        pool.release(destination, transaction.source);
      }
      return { settled: false, settlementRetryable: retryable };
    }
  }

  /**
   * Whether the recipient's trustline already holds the most the settlement's
   * path payment may spend. A settlement without exactly one such payment is
   * not one this server built, and is never treated as covered.
   */
  async function holdsEnoughToSettle(
    destination: string,
    transaction: Transaction,
  ): Promise<boolean> {
    const payments = transaction.operations.filter(
      (op): op is Operation.PathPaymentStrictReceive => op.type === "pathPaymentStrictReceive",
    );
    const payment = payments[0];
    if (payments.length !== 1 || payment === undefined) return false;
    const state = await inspectDestination(options.rpc, destination, payment.sendAsset);
    if (state.trustline === undefined || !state.trustline.authorized) return false;
    return BigInt(state.trustline.balanceStroops) >= decimalToStroops(payment.sendMax);
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

    const transaction = parseTransaction(body.signedXdr, options.network.passphrase);
    if ("innerTransaction" in transaction) {
      reply(res, 400, { error: "Fee bumps are not accepted here.", retryable: false }, origin);
      return;
    }
    // Defence in depth only. The ledger below is what decides: a body the
    // sponsor did not build is refused however plausible its operations look.
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

    // Taken, not read: once countersigned, the same signed body must never earn
    // a second signature.
    const record = built.take(transaction.hash().toString("hex"), "preparation", nowUnix());
    if (record === undefined) {
      reply(
        res,
        409,
        {
          error: "That preparation was not built here, or has expired. Ask for a new one.",
          retryable: false,
        },
        origin,
      );
      return;
    }

    // Before the held check, so a body anyone could copy cannot be used to ask
    // whether a given account is mid-transfer.
    if (!signedBy(transaction, record.signer)) {
      refuse(record, res, origin, 400, "That preparation is not signed by the account it is for.");
      return;
    }

    // The governing order: no capital commits until the settlement that releases
    // it is already signed and held. Without this the deposit is a gift, which is
    // the model the cost decision explicitly rejected.
    if (liveSettlement(record.destination) === undefined) {
      refuse(
        record,
        res,
        origin,
        409,
        "No settlement is held for this account. The deposit is a loan, and the " +
          "repayment is signed before the loan is made, not after.",
      );
      return;
    }
    const source = classifySourceChain(record.sourceChainId, DEFAULT_CHEAP_GAS_CHAINS);
    const decision = await caps.check(source);
    if (!decision.allowed) {
      refuse(record, res, origin, 429, decision.reason, true);
      return;
    }

    transaction.sign(keypair);
    let result: Awaited<ReturnType<RpcClient["submit"]>>;
    try {
      result = await options.rpc.submit("sponsored preparation", async () => transaction);
    } catch (cause) {
      const retryable = cause instanceof MavnaError ? cause.retryable : true;
      reply(res, 502, { error: "The preparation could not be submitted.", retryable }, origin);
      return;
    }
    try {
      await caps.recordStarted(source);
    } catch (cause) {
      // The preparation is on the ledger whatever the count says. Reporting a
      // failure would invite the user to retry something that worked, so the
      // operator hears about the undercount and the user hears the truth.
      console.error(
        "[sponsor] a sponsorship landed but was not counted against the cap:",
        cause instanceof Error ? cause.message : cause,
      );
    }
    reply(res, 200, { txHash: result.txHash, ledger: result.ledger }, origin);
  }

  /** Trigger the mint for an attested burn. Idempotent; retrying is always safe. */
  async function deliver(
    body: DeliverBody,
    res: ServerResponse,
    origin: string | undefined,
  ): Promise<void> {
    if (
      typeof body.txHash !== "string" ||
      !TX_HASH.some((form) => form.test(body.txHash as string))
    ) {
      reply(res, 400, { error: "Say which transaction to deliver.", retryable: false }, origin);
      return;
    }
    const domain = body.domain;
    if (typeof domain !== "number" || !sourceDomains.has(domain)) {
      reply(
        res,
        400,
        { error: "That is not a chain this sponsor delivers from.", retryable: false },
        origin,
      );
      return;
    }

    const unavailable = (): void =>
      reply(
        res,
        502,
        { error: "Circle's attestation service did not answer usefully.", retryable: true },
        origin,
      );
    let iris: Response;
    try {
      iris = await fetch(
        `${options.irisUrl}/v2/messages/${domain}?transactionHash=${encodeURIComponent(body.txHash)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (cause) {
      console.error(
        "[sponsor] iris could not be reached:",
        cause instanceof Error ? cause.message : cause,
      );
      unavailable();
      return;
    }
    if (iris.status === 404) {
      reply(
        res,
        404,
        { error: "Circle has no attested record of that transaction yet.", retryable: true },
        origin,
      );
      return;
    }
    if (!iris.ok) {
      console.error("[sponsor] iris answered", iris.status);
      unavailable();
      return;
    }
    let parsed: { messages?: readonly { message?: string; attestation?: string }[] };
    try {
      parsed = (await iris.json()) as typeof parsed;
    } catch (cause) {
      console.error("[sponsor] iris answered with something that is not JSON", cause);
      unavailable();
      return;
    }
    const message = parsed?.messages?.[0];
    if (typeof message?.message !== "string" || typeof message.attestation !== "string") {
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
    // sponsor's capital in the same breath. Only for the account Circle
    // attested: a destination named in the request is the caller's claim, and
    // settling on it would spend a stranger's arrival on someone else's loan.
    const recipient = attestedRecipient(message.message, domain, expected);
    const settled =
      (outcome.kind === "delivered" || outcome.kind === "already-delivered") &&
      recipient !== undefined
        ? await settleIfHeld(recipient)
        : {};

    reply(
      res,
      outcome.kind === "recipient-not-ready" ? 409 : 200,
      { ...outcome, ...settled },
      origin,
    );
  }
}

/**
 * A refusal caused by the request itself, carrying the status to answer with.
 * The message is written for the caller, so it is safe to send as is.
 */
class RequestError extends MavnaError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message, { retryable: false });
    this.name = "RequestError";
    this.status = status;
  }
}

/**
 * Read a JSON object body, refusing anything past `limit` bytes. Every route
 * here takes a few hundred bytes at most, and an unbounded read lets one client
 * hold as much of our memory as it cares to send. Past the limit the rest of the
 * body is drained unread, so the answer still reaches the caller.
 */
function readJson(req: IncomingMessage, limit = 65_536): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new RequestError("The request body is too large.", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (refused) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new RequestError("The request body is not JSON.", 400));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new RequestError("The request body must be a JSON object.", 400));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
  });
}

/** Decode a transaction from the wire, where anything at all may arrive. */
function parseTransaction(
  xdrText: unknown,
  passphrase: string,
): ReturnType<typeof TransactionBuilder.fromXDR> {
  if (typeof xdrText !== "string") {
    throw new RequestError("That is not a Stellar transaction.", 400);
  }
  try {
    return TransactionBuilder.fromXDR(xdrText, passphrase);
  } catch {
    throw new RequestError("That is not a Stellar transaction.", 400);
  }
}

const nowUnix = (): number => Math.floor(Date.now() / 1000);

/**
 * What an honest burn into Stellar through the forwarder looks like, as the
 * 32-byte fields Circle's transmitter writes. Source TokenMessengers are keyed
 * by domain; a domain with none in the adapter's config is absent, and a
 * message from it settles nothing.
 */
interface ExpectedMessageFields {
  readonly stellarDomain: number;
  readonly sourceMessengers: ReadonlyMap<number, Uint8Array>;
  readonly stellarMessenger: Uint8Array;
  readonly forwarder: Uint8Array;
}

function expectedMessageFields(networkId: "testnet" | "mainnet"): ExpectedMessageFields {
  const sourceMessengers = new Map<number, Uint8Array>();
  for (const deployment of Object.values(EVM_DEPLOYMENTS[networkId])) {
    sourceMessengers.set(deployment.domain, leftPad32(fromHex(deployment.tokenMessengerV2)));
  }
  for (const chain of Object.values(NON_EVM_CHAINS[networkId])) {
    if (chain.family === "solana") {
      sourceMessengers.set(
        chain.domain,
        solanaAddressToBytes32(SOLANA_PROGRAMS.tokenMessengerMinterV2),
      );
    }
    if (chain.family === "starknet") {
      sourceMessengers.set(
        chain.domain,
        leftPad32(fromHex(STARKNET_DEPLOYMENTS[networkId].tokenMessengerMinterV2)),
      );
    }
  }
  return {
    stellarDomain: stellarDomainFor(networkId),
    sourceMessengers,
    stellarMessenger: contractAddressToBytes32(CCTP_CONTRACTS[networkId].tokenMessengerMinter),
    forwarder: contractAddressToBytes32(CCTP_CONTRACTS[networkId].cctpForwarder),
  };
}

/** An address shorter than a word, as CCTP carries it: zeros on the left. */
function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new MavnaError("An address longer than 32 bytes cannot be a CCTP word.", {
      retryable: false,
    });
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** Where the body starts in a CCTP v2 message, per Circle's MessageV2. */
const MESSAGE_BODY_INDEX = 148;
/** Where the hook data starts in a v2 burn body, per Circle's BurnMessageV2. */
const HOOK_DATA_INDEX = 228;

/**
 * The Stellar recipient Circle attested to, read from the hook data at the end
 * of the burn body, for a message that is provably a burn by the source
 * TokenMessenger, to Stellar's TokenMessenger, minted to and callable only by
 * the forwarder. Anything else is undefined and settles nothing: Circle signs
 * every message, including a burn whose hook data names someone else's account
 * while paying somewhere it cannot reach them. Delivery does not depend on this.
 */
function attestedRecipient(
  messageHex: string,
  sourceDomain: number,
  expected: ExpectedMessageFields,
): string | undefined {
  try {
    const message = fromHex(messageHex);
    if (message.length < MESSAGE_BODY_INDEX + HOOK_DATA_INDEX) return undefined;
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const word = (at: number): Uint8Array => message.subarray(at, at + 32);
    const sourceMessenger = expected.sourceMessengers.get(sourceDomain);
    if (
      sourceMessenger === undefined ||
      view.getUint32(4, false) !== sourceDomain ||
      view.getUint32(8, false) !== expected.stellarDomain ||
      !sameBytes(word(44), sourceMessenger) ||
      !sameBytes(word(76), expected.stellarMessenger) ||
      !sameBytes(word(108), expected.forwarder) ||
      !sameBytes(word(MESSAGE_BODY_INDEX + 36), expected.forwarder)
    ) {
      return undefined;
    }
    return parseForwarderHookData(message.subarray(MESSAGE_BODY_INDEX + HOOK_DATA_INDEX)).recipient;
  } catch (cause) {
    console.error(
      "[sponsor] attested message has no readable recipient:",
      cause instanceof Error ? cause.message : cause,
    );
    return undefined;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The source transaction id forms CCTP chains use: an EVM hash, a Solana
 * signature in base58, or a Starknet felt, which may drop leading zeros.
 */
const TX_HASH: readonly RegExp[] = [
  /^0x[0-9a-fA-F]{64}$/,
  /^[1-9A-HJ-NP-Za-km-z]{64,90}$/,
  /^0x[0-9a-fA-F]{1,64}$/,
];

/** A whole day, as the builder defaults to: Circle's standard transfer has no ceiling. */
const SETTLEMENT_VALIDITY_SECONDS = 86_400;

/**
 * The account whose signature a built transaction still needs. A muxed address
 * is signed for by the account it wraps, and an account about to be created
 * signs too, because it owns the trustline being opened.
 */
function signerFor(destination: string): string {
  return classifyAddress(destination).trustlineHolder ?? destination;
}

/**
 * When the server stops honouring what it built. Both builders set a time
 * bound; one without would sit in the ledger forever, so that is refused.
 */
function expiryOf(transaction: Transaction): number {
  const maxTime = Number(transaction.timeBounds?.maxTime ?? 0);
  if (!(maxTime > 0)) {
    throw new MavnaError("A built transaction has no time bound.", { retryable: false });
  }
  return maxTime;
}

/** Horizon's decimal form to stroops, integer arithmetic only. */
function decimalToStroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (match === null) {
    throw new MavnaError(`Not a Stellar amount: ${amount}`, { retryable: false });
  }
  return BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
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
