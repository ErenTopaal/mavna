import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * The operator scripts, run as an operator runs them, in a scratch copy of the
 * repository layout so the real .env and generated files are never touched.
 * Every network call is answered by a preloaded fetch that refuses anything it
 * was not told about, so nothing here reaches a real network.
 */
const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stubbed {
  /**
   * JSON answers by URL prefix; for JSON-RPC by `prefix#method`, and for an
   * eth_call by `prefix#eth_call:<selector>` before a plain `prefix#eth_call`.
   */
  readonly answers: Record<string, { status?: number; body: unknown }>;
}

function layout(options: { link?: readonly string[]; env?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "mavna-scripts-"));
  scratch.push(root);
  mkdirSync(join(root, "scripts"));
  for (const name of options.link ?? []) symlinkSync(join(repo, name), join(root, name));
  if (options.env !== undefined) writeFileSync(join(root, ".env"), options.env);
  return root;
}

function run(
  root: string,
  script: string,
  args: readonly string[],
  stub: Stubbed,
  cwd = root,
): { status: number | null; out: string; asked: string[] } {
  copyFileSync(join(repo, "scripts", script), join(root, "scripts", script));
  const log = join(root, "asked.log");
  const preload = join(root, "fetch-stub.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const answers = ${JSON.stringify(stub.answers)};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  let method;
  let selector;
  try {
    const call = JSON.parse(init?.body ?? "null");
    method = call?.method;
    if (method === "eth_call") selector = String(call.params?.[0]?.data ?? "").slice(0, 10);
  } catch {}
  appendFileSync(${JSON.stringify(log)}, url + (method ? "#" + method : "") + "\\n");
  const key = Object.keys(answers)
    .filter((k) => {
      const [p, m] = k.split("#");
      return url.startsWith(p) && (m === undefined || m === method || m === method + ":" + selector);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) throw new TypeError("fetch failed: no stubbed answer for " + url);
  const { status = 200, body } = answers[key];
  const wrapped = method !== undefined && body !== null && typeof body === "object" && !("jsonrpc" in body)
    ? { jsonrpc: "2.0", id: 1, result: body.result, error: body.error }
    : body;
  return new Response(typeof wrapped === "string" ? wrapped : JSON.stringify(wrapped), { status });
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, join(root, "scripts", script), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    asked: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

// a 32-byte ABI word holding an address, a uint, and an ABI-encoded string
const word = (hex: string): string => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const abiString = (text: string): string =>
  `0x${"20".padStart(64, "0")}${text.length.toString(16).padStart(64, "0")}${Buffer.from(text)
    .toString("hex")
    .padEnd(64, "0")}`;

/** Answers for a chain whose CCTP contracts all check out. */
function healthyCctpChain(rpc: string, chainId: number): Stubbed["answers"] {
  return {
    [`${rpc}#eth_chainId`]: { body: { result: `0x${chainId.toString(16)}` } },
    [`${rpc}#eth_getCode`]: { body: { result: "0x6080" } },
    [`${rpc}#eth_call`]: { body: { result: word("1111111111111111111111111111111111111111") } },
    [`${rpc}#eth_call:0x95d89b41`]: { body: { result: abiString("USDC") } },
    [`${rpc}#eth_call:0x313ce567`]: { body: { result: word("6") } },
  };
}

describe("verify-cctp-chains", () => {
  const SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com";
  const FUJI = "https://api.avax-test.network/ext/bc/C/rpc";

  /** Both seed chains healthy, and Fuji answering as the given chain id. */
  function cctpAnswers(fujiServes: number): Stubbed["answers"] {
    return {
      "https://chainid.network/chains.json": { body: [] },
      ...healthyCctpChain(SEPOLIA, 11155111),
      ...healthyCctpChain("https://ethereum-rpc.publicnode.com", 1),
      ...healthyCctpChain("https://eth.llamarpc.com", 1),
      ...healthyCctpChain(FUJI, fujiServes),
    };
  }

  it("writes its output at the repository root whatever directory it runs from", () => {
    const root = layout({ link: ["node_modules"] });
    mkdirSync(join(root, "packages", "adapters", "cctp"), { recursive: true });
    const result = run(
      root,
      "verify-cctp-chains.mjs",
      ["--only=ethereum-sepolia"],
      { answers: cctpAnswers(43113) },
      join(root, "packages", "adapters", "cctp"),
    );
    expect(result.out).toContain("seed USDC verified");
    expect(existsSync(join(root, "cctp-chains.verified.json"))).toBe(true);
    expect(
      existsSync(join(root, "packages", "adapters", "cctp", "cctp-chains.verified.json")),
    ).toBe(false);
  });

  it("refuses a chain whose RPC serves some other chain", () => {
    const root = layout({ link: ["node_modules"] });
    // Fuji's endpoint answers as Base Sepolia
    const result = run(root, "verify-cctp-chains.mjs", ["--only=avalanche-fuji"], {
      answers: cctpAnswers(84532),
    });
    const written = JSON.parse(readFileSync(join(root, "cctp-chains.verified.json"), "utf8")) as {
      results: { testnet: unknown[] };
      failures: { network: string; id: string; reason: string }[];
    };
    expect(result.out).toContain("serves chain id 84532");
    expect(written.results.testnet).toEqual([]);
    expect(written.failures).toEqual([
      {
        network: "testnet",
        id: "avalanche-fuji",
        reason: `${FUJI} serves chain id 84532, not 43113`,
      },
    ]);
  });
});

describe("deliver-cctp", () => {
  const complete = {
    messages: [{ status: "complete", message: "0x00", attestation: "0x00" }],
  };

  it("refuses a network it does not know", () => {
    const root = layout({ link: ["packages", "services"], env: "SPONSOR_SECRET_KEY=S\n" });
    const result = run(root, "deliver-cctp.mjs", ["--tx=0xabc", "--network=moon"], {
      answers: {},
    });
    expect(result.status).toBe(2);
    expect(result.out).toMatch(/testnet or mainnet/);
    expect(result.asked).toEqual([]);
  });

  it("says what Circle answered when it is not a JSON success", () => {
    const root = layout({ link: ["packages", "services"], env: "SPONSOR_SECRET_KEY=S\n" });
    const result = run(root, "deliver-cctp.mjs", ["--tx=0xabc"], {
      answers: {
        "https://iris-api-sandbox.circle.com": { status: 429, body: "<html>slow down</html>" },
      },
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Circle answered 429");
  });

  it("never sends a mainnet delivery to the testnet node in .env", () => {
    const secret = "SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQM";
    const root = layout({
      link: ["packages", "services"],
      env: `MAVNA_NETWORK=testnet\nSTELLAR_RPC_URL=https://soroban-testnet.stellar.org\nSPONSOR_SECRET_KEY=${secret}\n`,
    });
    const result = run(root, "deliver-cctp.mjs", ["--tx=0xabc", "--network=mainnet"], {
      answers: { "https://iris-api.circle.com": { body: complete } },
    });
    const stellar = result.asked.filter((url) => !url.includes("circle.com"));
    expect(stellar.length).toBeGreaterThan(0);
    expect(stellar.filter((url) => url.includes("testnet"))).toEqual([]);
  });
});

describe("fund-sponsor", () => {
  it("does not record a key Friendbot refused", () => {
    const root = layout({ link: ["packages"], env: "" });
    const result = run(root, "fund-sponsor.mjs", [], {
      answers: {
        "https://friendbot.stellar.org": {
          status: 400,
          body: { status: 400, detail: "createAccountMalformed" },
        },
      },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(root, ".env"), "utf8")).not.toContain("SPONSOR_SECRET_KEY");
  });

  it("records the key when Friendbot says it already funded it", () => {
    const root = layout({ link: ["packages"], env: "" });
    const result = run(root, "fund-sponsor.mjs", [], {
      answers: {
        "https://friendbot.stellar.org": {
          status: 400,
          body: { status: 400, detail: "account already funded to starting balance" },
        },
      },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".env"), "utf8")).toMatch(/^SPONSOR_SECRET_KEY=S\w{55}$/m);
  });

  it("records the key when Friendbot funds it", () => {
    const root = layout({ link: ["packages"], env: "" });
    const result = run(root, "fund-sponsor.mjs", [], {
      answers: { "https://friendbot.stellar.org": { body: { successful: true } } },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, ".env"), "utf8")).toMatch(/^SPONSOR_SECRET_KEY=S\w{55}$/m);
  });
});
