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
import { keccak256, toBytes } from "viem";
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

interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

interface Stubbed {
  /**
   * JSON answers by URL prefix; for JSON-RPC by `prefix#method`, and by
   * `prefix#method:<detail>` before that, where the detail is an eth_call's
   * selector, a starknet_call's entry point or the contract a class is asked of.
   * A list is answered in order, its last entry repeating. Status 0 is no
   * answer at all.
   */
  readonly answers: Record<string, Answer | readonly Answer[]>;
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
const served = new Map();
globalThis.fetch = async (input, init) => {
  const url = String(input);
  let method;
  let selector;
  try {
    const call = JSON.parse(init?.body ?? "null");
    method = call?.method;
    if (method === "eth_call") selector = String(call.params?.[0]?.data ?? "").slice(0, 10);
    if (method === "starknet_call") selector = call.params?.request?.entry_point_selector;
    if (method === "starknet_getClassHashAt") selector = call.params?.contract_address;
  } catch {}
  appendFileSync(${JSON.stringify(log)}, url + (method ? "#" + method : "") + "\\n");
  const key = Object.keys(answers)
    .filter((k) => {
      const [p, m] = k.split("#");
      return url.startsWith(p) && (m === undefined || m === method || m === method + ":" + selector);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (key === undefined) throw new TypeError("fetch failed: no stubbed answer for " + url);
  const list = [answers[key]].flat();
  const index = served.get(key) ?? 0;
  served.set(key, index + 1);
  const { status = 200, body } = list[Math.min(index, list.length - 1)];
  // status 0 stands for a node that did not answer at all
  if (status === 0) throw new TypeError("fetch failed: no answer");
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

describe("verify-cctp-starknet", () => {
  const MASK = (1n << 250n) - 1n;
  const selector = (name: string): string =>
    `0x${(BigInt(keccak256(toBytes(name))) & MASK).toString(16)}`;
  const ARGUMENTS = [
    "amount",
    "destination_domain",
    "mint_recipient",
    "burn_token",
    "destination_caller",
    "max_fee",
    "min_finality_threshold",
    "hook_data",
  ];

  /** One network's first endpoint answering for the contracts the script lists. */
  function network(rpc: string, own: Record<string, string>, other: string, usdc: string) {
    const absent = { body: { error: { code: 20, message: "Contract not found" } } };
    return {
      // throttled on the first ask, as OnFinality was during the audit
      [`${rpc}#starknet_getClassHashAt:${own.messenger}`]: [
        { status: 429, body: "Too Many Requests" },
        { body: { result: "0x1" } },
      ],
      [`${rpc}#starknet_getClassHashAt:${own.transmitter}`]: { body: { result: "0x1" } },
      [`${rpc}#starknet_getClassHashAt:${other}`]: absent,
      [`${rpc}#starknet_getClassAt`]: {
        body: {
          result: {
            entry_points_by_type: {
              EXTERNAL: [{ selector: selector("deposit_for_burn_with_hook") }],
            },
            abi: [
              {
                type: "function",
                name: "deposit_for_burn_with_hook",
                inputs: ARGUMENTS.map((name) => ({ name })),
              },
            ],
          },
        },
      },
      [`${rpc}#starknet_call:${selector("get_local_token")}`]: { body: { result: [usdc] } },
      [`${rpc}#starknet_call:${selector("remote_token_messenger")}`]: { body: { result: ["0x1"] } },
    };
  }

  it("waits out a rate limit instead of calling the contract undeployed", {
    timeout: 30_000,
  }, () => {
    const root = layout({ link: ["node_modules"] });
    const testnet = {
      messenger: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
      transmitter: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
    };
    const mainnet = {
      messenger: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
      transmitter: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
    };
    const result = run(root, "verify-cctp-starknet.mjs", [], {
      answers: {
        ...network(
          "https://starknet-sepolia.drpc.org",
          testnet,
          mainnet.messenger,
          "0x512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
        ),
        ...network(
          "https://starknet.drpc.org",
          mainnet,
          testnet.messenger,
          "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
        ),
      },
    });
    expect(result.out).toContain("Starknet constants agree with both networks");
    expect(result.status).toBe(0);
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
        // the node is asked which network it serves before Circle is
        "https://soroban-testnet.stellar.org#getNetwork": {
          body: {
            result: { passphrase: "Test SDF Network ; September 2015", protocolVersion: 23 },
          },
        },
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

describe("verify-axelar-deployments", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  /** The axelar package beside an empty src, so pinned.ts lands in scratch, never in the repo. */
  function axelarLayout(): string {
    const root = layout({});
    const axelar = join(root, "packages", "adapters", "axelar");
    mkdirSync(join(axelar, "src"), { recursive: true });
    copyFileSync(
      join(repo, "packages", "adapters", "axelar", "package.json"),
      join(axelar, "package.json"),
    );
    symlinkSync(
      join(repo, "packages", "adapters", "axelar", "node_modules"),
      join(axelar, "node_modules"),
    );
    // the root's tooling, which formats pinned.ts after it is written
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    copyFileSync(join(repo, "biome.json"), join(root, "biome.json"));
    return root;
  }

  const answers: Stubbed["answers"] = {
    "https://api.github.com/repos/axelarnetwork/axelar-contract-deployments/commits/main": {
      body: { sha: COMMIT },
    },
    [`https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${COMMIT}/`]: {
      body: { chains: {} },
    },
    "https://chainid.network/chains.json": { body: [] },
  };

  it("pins nothing until it is told which commit, and names the latest to review", () => {
    const root = axelarLayout();
    const result = run(root, "verify-axelar-deployments.mjs", [], { answers });
    expect(result.status).toBe(2);
    expect(result.out).toContain(COMMIT);
    expect(existsSync(join(root, "packages", "adapters", "axelar", "src", "pinned.ts"))).toBe(
      false,
    );
  });

  it("writes pinned.ts into the axelar package whatever directory it runs from", () => {
    const root = axelarLayout();
    const result = run(
      root,
      "verify-axelar-deployments.mjs",
      [`--commit=${COMMIT}`],
      { answers },
      join(root, "packages"),
    );
    expect(result.status, result.out).toBe(0);
    const pinned = join(root, "packages", "adapters", "axelar", "src", "pinned.ts");
    expect(readFileSync(pinned, "utf8")).toContain(`DEPLOYMENTS_COMMIT = "${COMMIT}"`);
  });

  it("leaves pinned.ts formatted as the repository's lint requires", () => {
    const root = axelarLayout();
    const its = "0x1111111111111111111111111111111111111111";
    const gas = "0x2222222222222222222222222222222222222222";
    const answersWithChain: Stubbed["answers"] = {
      ...answers,
      [`https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${COMMIT}/axelar-chains-config/info/testnet.json`]:
        {
          body: {
            chains: {
              "ethereum-sepolia": {
                chainType: "evm",
                chainId: 11155111,
                rpc: "https://evm.test",
                contracts: {
                  InterchainTokenService: { address: its },
                  AxelarGasService: { address: gas },
                },
              },
            },
          },
        },
      "https://evm.test#eth_chainId": { body: { result: "0xaa36a7" } },
      "https://evm.test#eth_getCode": { body: { result: "0x6080" } },
      "https://evm.test#eth_call": { body: { result: word(gas) } },
    };
    const result = run(root, "verify-axelar-deployments.mjs", [`--commit=${COMMIT}`], {
      answers: answersWithChain,
    });
    expect(result.status, result.out).toBe(0);
    const pinned = join(root, "packages", "adapters", "axelar", "src", "pinned.ts");
    expect(readFileSync(pinned, "utf8")).toContain(its);
    const lint = spawnSync(
      process.execPath,
      [join(repo, "node_modules", "@biomejs", "biome", "bin", "biome"), "check", pinned],
      { cwd: root, encoding: "utf8" },
    );
    expect(lint.status, `${lint.stdout}${lint.stderr}`).toBe(0);
  });
});

describe("verify-axelar-deployments when nodes miss answers", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const its = "0x1111111111111111111111111111111111111111";
  const gas = "0x2222222222222222222222222222222222222222";
  const silent = { status: 0, body: null };

  function layoutWithTools(): string {
    const root = layout({});
    const axelar = join(root, "packages", "adapters", "axelar");
    mkdirSync(join(axelar, "src"), { recursive: true });
    copyFileSync(
      join(repo, "packages", "adapters", "axelar", "package.json"),
      join(axelar, "package.json"),
    );
    symlinkSync(
      join(repo, "packages", "adapters", "axelar", "node_modules"),
      join(axelar, "node_modules"),
    );
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    copyFileSync(join(repo, "biome.json"), join(root, "biome.json"));
    return root;
  }

  function answersFor(chainId: Stubbed["answers"][string], alternates: string[]) {
    return {
      [`https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${COMMIT}/`]: {
        body: { chains: {} },
      },
      [`https://raw.githubusercontent.com/axelarnetwork/axelar-contract-deployments/${COMMIT}/axelar-chains-config/info/testnet.json`]:
        {
          body: {
            chains: {
              "ethereum-sepolia": {
                chainType: "evm",
                chainId: 11155111,
                rpc: "https://evm.test",
                contracts: {
                  InterchainTokenService: { address: its },
                  AxelarGasService: { address: gas },
                },
              },
            },
          },
        },
      "https://chainid.network/chains.json": { body: [{ chainId: 11155111, rpc: alternates }] },
      "https://evm.test#eth_chainId": chainId,
      "https://evm.test#eth_getCode": { body: { result: "0x6080" } },
      "https://evm.test#eth_call": { body: { result: word(gas) } },
      "https://alt.test#eth_chainId": silent,
    } satisfies Stubbed["answers"];
  }

  it("asks a silent node again before leaving its chain out", { timeout: 60_000 }, () => {
    const root = layoutWithTools();
    const ok = { body: { result: "0xaa36a7" } };
    // silent through one whole round of retries, then answers
    const result = run(root, "verify-axelar-deployments.mjs", [`--commit=${COMMIT}`], {
      answers: answersFor([silent, silent, silent, silent, ok], []),
    });
    expect(result.status, result.out).toBe(0);
    const pinned = readFileSync(
      join(root, "packages", "adapters", "axelar", "src", "pinned.ts"),
      "utf8",
    );
    expect(pinned).toContain(its);
    expect(pinned).toContain("https://evm.test");
  });

  it("names every node and chain it left out for not answering", { timeout: 60_000 }, () => {
    const root = layoutWithTools();
    const result = run(root, "verify-axelar-deployments.mjs", [`--commit=${COMMIT}`], {
      answers: answersFor({ body: { result: "0xaa36a7" } }, ["https://alt.test"]),
    });
    expect(result.status, result.out).toBe(0);
    const summary = result.out.slice(result.out.indexOf("did not answer"));
    expect(summary).toContain("testnet/ethereum-sepolia: https://alt.test");
    expect(summary).toMatch(/rerun/i);
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
