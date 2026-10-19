import type { ComposeArrival, ComposeFinish, Route, StepPhase, TransferHandle } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESTINATION,
  pending,
  routeFor,
  ScriptedAdapter,
  SEND_HASH,
  STELLAR_USDC,
  STELLAR_XLM,
} from "./__fixtures__/scripted";
import { COMPOSE_OVERDUE_SECONDS, foundFor } from "./found";
import { toRouteView } from "./quote";
import { stepsFor, trackDelivery } from "./rails";
import { createSponsorClient } from "./sponsor";

const ref = {
  chainId: "stellar-testnet",
  txHash: "c0de",
  explorerUrl: "https://stellar.expert/explorer/testnet/tx/c0de",
};
const finish: ComposeFinish = {
  contract: "CBSWBSELNYEDXQHO4JDXYJ7HFMTSBLVHAKIQ6KFC2NYZUT5PHDSI6252",
  from: "CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6",
  guid: "ab".repeat(32),
  index: 0,
  message: "0x01",
};
const converting = (deliveredAtUnix: number, f = finish): StepPhase => ({
  phase: "delivered-conversion-pending",
  ref,
  deliveredAtUnix,
  finish: f,
});
const converted: StepPhase = {
  phase: "delivered-and-converted",
  ref,
  received: { asset: STELLAR_XLM, baseUnits: "250000000" },
  fee: undefined,
};
const asCame: StepPhase = {
  phase: "delivered-as-came",
  ref,
  received: { asset: STELLAR_USDC, baseUnits: "50000000" },
  because: "The conversion could not meet your minimum.",
};

const compose: ComposeArrival = {
  contract: finish.contract,
  venue: "aquarius",
  arriving: STELLAR_USDC,
  arrivingContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  wanted: STELLAR_XLM,
  wantedContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  minOut: "240000000",
  path: [],
  fee: undefined,
  trust: "The Mavna Arrival Contract converts it, with no administrator.",
  walletNote: "No Stellar wallet needed: the conversion happens on arrival.",
};
const composeRoute = (): Route => {
  const plain = routeFor("layerzero");
  return {
    ...plain,
    receives: { asset: STELLAR_XLM, baseUnits: "250000000" },
    receivesAtLeast: { asset: STELLAR_XLM, baseUnits: "240000000" },
    steps: [
      ...plain.steps,
      {
        ...plain.steps[0],
        id: "compose-1",
        kind: "compose",
        source: "aquarius",
      } as Route["steps"][number],
    ],
    compose,
  };
};

describe("a compose route in the route list", () => {
  it("has its own label, its trust model in words, and the no-wallet line", () => {
    const view = toRouteView(composeRoute());
    expect(view.compose?.label).toBe("Converts on arrival via Aquarius");
    expect(view.compose?.walletNote).toMatch(/No Stellar wallet needed/);
    expect(view.compose?.trust).toMatch(/no administrator/);
    expect(view.sigs).toBe(1);
    expect(toRouteView(routeFor("layerzero")).compose).toBeUndefined();
  });

  it("shows the conversion as a step nobody signs", () => {
    const steps = stepsFor(composeRoute());
    expect(steps.map((s) => s.id)).toEqual(["burn", "deliver", "convert"]);
    const convert = steps.find((s) => s.id === "convert");
    expect(convert?.user).toBe(false);
    expect(convert?.label).toBe("Converted to XLM on arrival");
    expect(steps.find((s) => s.id === "deliver")?.label).toBe(
      "LayerZero delivers to the Arrival Contract",
    );
  });
});

describe("watching a compose route arrive", () => {
  const handle: TransferHandle = {
    sourceTxHash: SEND_HASH,
    depositAddress: undefined,
    destinationAddress: DESTINATION,
    sourceChainId: "arbitrum-sepolia",
  };
  const recorder = () => {
    const patches: { id: string; patch: Record<string, unknown> }[] = [];
    return {
      patches,
      patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
    };
  };
  const instant = async (): Promise<void> => {};

  it("marks the delivery done, then the conversion when the contract's event says so", async () => {
    const adapter = new ScriptedAdapter("layerzero", [pending(), converting(0), converted]);
    const { patches, patch } = recorder();
    const result = await trackDelivery(adapter, handle, patch, { wait: instant });
    expect(result).toEqual({ outcome: "terminal", phase: converted });
    expect(patches).toContainEqual({
      id: "convert",
      patch: expect.objectContaining({ phase: "pending" }),
    });
    expect(patches.at(-1)).toEqual({
      id: "convert",
      patch: {
        phase: "done",
        note: "Converted on arrival. 25.00 XLM arrived.",
        ref: "c0de",
        refUrl: ref.explorerUrl,
      },
    });
  });

  it("never shows delivered as it came as a plain success", async () => {
    const adapter = new ScriptedAdapter("layerzero", [pending(), asCame]);
    const { patches, patch } = recorder();
    await trackDelivery(adapter, handle, patch, { wait: instant });
    const last = patches.at(-1);
    expect(last?.id).toBe("convert");
    expect(last?.patch.phase).toBe("failed");
    expect(last?.patch.note).toMatch(/^Delivered as it came, not converted: 5.00 USDC arrived/);
  });
});

describe("Activity for a compose route", () => {
  const now = 10_000;

  it("reads converted as delivered and delivered as it came as its own ending", () => {
    expect(foundFor(converted, "source-tx", ["layerzero"], now)).toMatchObject({
      tone: "ok",
      canFinish: false,
    });
    const came = foundFor(asCame, "source-tx", ["layerzero"], now);
    expect(came.tone).toBe("bad");
    expect(came.canFinish).toBe(false);
    expect(came.note).toMatch(/not converted/);
  });

  it("offers Finish the delivery only once the conversion is overdue", () => {
    const fresh = foundFor(converting(now - 10), "source-tx", ["layerzero"], now);
    expect(fresh.canFinish).toBe(false);
    const late = foundFor(
      converting(now - COMPOSE_OVERDUE_SECONDS - 1),
      "source-tx",
      ["layerzero"],
      now,
    );
    expect(late.canFinish).toBe(true);
    expect(late.compose).toEqual(finish);
    expect(late.note).toMatch(/only ever run once/);
  });

  it("does not offer Finish when the waiting message could not be read back", () => {
    const phase: StepPhase = {
      phase: "delivered-conversion-pending",
      ref,
      deliveredAtUnix: 0,
      finish: undefined,
    };
    const found = foundFor(phase, "source-tx", ["layerzero"], now);
    expect(found.canFinish).toBe(false);
    expect(found.compose).toBeUndefined();
  });
});

describe("asking the sponsor to finish a conversion", () => {
  const client = createSponsorClient("https://sponsor.test");
  const answer = (status: number, body: unknown): void => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the chain's answer through, including a second finish", async () => {
    answer(200, { kind: "composed", txHash: "h", ledger: 9 });
    expect(await client.requestCompose(finish)).toEqual({
      kind: "composed",
      txHash: "h",
      ledger: 9,
    });
    answer(200, { kind: "already-composed" });
    expect(await client.requestCompose(finish)).toEqual({ kind: "already-composed" });
  });

  it("reads a 404 outcome as nothing queued yet, and a bare 404 as a failure", async () => {
    answer(404, { kind: "not-queued" });
    expect(await client.requestCompose(finish)).toEqual({ kind: "not-queued" });
    answer(404, { error: "This sponsor finishes no conversions on arrival.", retryable: false });
    await expect(client.requestCompose(finish)).rejects.toThrow(/finishes no conversions/);
  });
});
