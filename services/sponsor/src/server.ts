import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MavnaError } from "@mavna/core";
import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import { buildPreparation, classifyAddress } from "@mavna/stellar";
import { type Asset, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  CapLedger,
  classifySourceChain,
  DEFAULT_CHEAP_GAS_CHAINS,
  InMemoryCapStore,
} from "./caps.js";
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
    reply(res, outcome.kind === "recipient-not-ready" ? 409 : 200, { ...outcome }, origin);
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

async function accountExists(rpc: RpcClient, address: string): Promise<boolean> {
  try {
    await rpc.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}
