import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, type Request, test } from "@playwright/test";

/*
 * The rails run in browsers, which have no Node `Buffer`. This drives the
 * paths that once used it (a LayerZero quote, an Axelar build, an Aquarius
 * quote for a compose route) inside the app's own production bundle, and
 * answers their network calls from answers recorded off the live networks.
 *
 * Re-record with MAVNA_RECORD=1 (reads testnet and mainnet, signs nothing).
 */
const FIXTURE = new URL("./fixtures/buffer-free.json", import.meta.url);
const RECORD = process.env.MAVNA_RECORD === "1";

// the root has no stellar-sdk of its own; the one @mavna/stellar uses decodes a simulation
const { TransactionBuilder, Networks } = createRequire(
  new URL("../packages/stellar/package.json", import.meta.url),
)("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");

/** The call a simulation runs, without the time bounds and sequence around it. */
function invocationOf(transaction: string): string {
  for (const passphrase of [Networks.TESTNET, Networks.PUBLIC]) {
    try {
      const tx = TransactionBuilder.fromXdr(transaction, passphrase);
      if ("operations" in tx) {
        return tx.operations
          .map((op) => ("func" in op ? op.func.toXdr("base64") : op.type))
          .join(",");
      }
    } catch {
      // the other passphrase
    }
  }
  return transaction;
}

interface Answer {
  readonly key: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * What identifies a request across runs. JSON-RPC ids are counters, and a
 * Stellar simulation carries the transaction's time bounds, so neither can be
 * part of the key; a simulation is known by the call it runs.
 */
function keyOf(request: Request): string {
  const url = request.url();
  const body = request.postData();
  if (body === null) return `${request.method()} ${url}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `${request.method()} ${url} ${body}`;
  }
  const normal = (call: unknown): unknown => {
    if (typeof call !== "object" || call === null) return call;
    const { id: _id, ...rest } = call as Record<string, unknown>;
    if (rest.method === "simulateTransaction") {
      const params = rest.params as { transaction?: string } | undefined;
      return { method: rest.method, call: invocationOf(params?.transaction ?? "") };
    }
    return rest;
  };
  const shape = Array.isArray(parsed) ? parsed.map(normal) : normal(parsed);
  return `${request.method()} ${url} ${JSON.stringify(shape)}`;
}

/** Restores a JSON-RPC answer's id to the one this run's request used. */
function withIds(request: Request, body: string): string {
  const sent = request.postData();
  if (sent === null) return body;
  try {
    const asked = JSON.parse(sent) as unknown;
    const answer = JSON.parse(body) as unknown;
    if (Array.isArray(asked) && Array.isArray(answer)) {
      return JSON.stringify(
        answer.map((entry, i) => ({ ...entry, id: (asked[i] as { id?: unknown })?.id })),
      );
    }
    if (!Array.isArray(asked) && typeof answer === "object" && answer !== null) {
      return JSON.stringify({ ...answer, id: (asked as { id?: unknown }).id });
    }
  } catch {
    // not JSON-RPC
  }
  return body;
}

const recorded: Answer[] = RECORD ? [] : (JSON.parse(readFileSync(FIXTURE, "utf8")) as Answer[]);
const misses: string[] = [];

async function answerNetwork(page: Page, origin: string): Promise<void> {
  const served = new Map<string, number>();
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const request = route.request();
      const key = keyOf(request);
      if (RECORD) {
        const response = await route.fetch();
        const body = await response.text();
        recorded.push({
          key,
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "application/json",
          body,
        });
        return route.fulfill({ response, body });
      }
      const all = recorded.filter((answer) => answer.key === key);
      const index = served.get(key) ?? 0;
      served.set(key, index + 1);
      const answer = all[Math.min(index, all.length - 1)];
      if (answer === undefined) {
        misses.push(key);
        return route.abort();
      }
      return route.fulfill({
        status: answer.status,
        contentType: answer.contentType,
        body: withIds(request, answer.body),
      });
    },
  );
}

test.describe("the rails inside the app's bundle", () => {
  // one worker when recording, so one process holds every answer it writes
  test.describe.configure({ mode: RECORD ? "serial" : "parallel" });

  test.afterAll(() => {
    if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 1)}\n`);
  });

  test.beforeEach(async ({ page, baseURL }) => {
    await answerNetwork(page, new URL(baseURL ?? "").origin);
    await page.goto("/harness/buffer-free.html");
    await page.waitForFunction(() => window.mavnaHarness !== undefined);
    // the point of the exercise: nothing on the page provides one
    expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe(
      "undefined",
    );
  });

  test.afterEach(() => {
    expect(misses, "requests with no recorded answer").toEqual([]);
  });

  test("a LayerZero quote", async ({ page }) => {
    const receives = await page.evaluate(() => window.mavnaHarness.layerzeroQuote());
    expect(BigInt(receives)).toBeGreaterThan(0n);
  });

  test("an Axelar build", async ({ page }) => {
    const transactions = await page.evaluate(() => window.mavnaHarness.axelarBuild());
    expect(transactions).toBeGreaterThan(0);
  });

  test("an Aquarius quote for a compose route", async ({ page }) => {
    const paths = await page.evaluate(() => window.mavnaHarness.aquariusComposeQuote());
    expect(paths.service).toBeGreaterThan(0);
    expect(paths.listed).toBeGreaterThan(0);
  });
});

declare global {
  interface Window {
    mavnaHarness: {
      layerzeroQuote(): Promise<string>;
      axelarBuild(): Promise<number>;
      aquariusComposeQuote(): Promise<{ service: number; listed: number }>;
    };
  }
}
