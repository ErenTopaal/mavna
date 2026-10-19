import type { StepPhase, TransferHandle } from "@mavna/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESTINATION,
  delivered,
  failed,
  pending,
  routeFor,
  ScriptedAdapter,
  SEND_HASH,
  STELLAR_USDC,
  STELLAR_XLM,
} from "./__fixtures__/scripted";
import { settlementBlocker } from "./quote";
import {
  adapterFor,
  lookupAcross,
  pollSettlement,
  settleNote,
  stepsFor,
  trackDelivery,
} from "./rails";
import { createSponsorClient } from "./sponsor";

const instant = async (): Promise<void> => {};

function recorder() {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    patches,
    patch: (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch });
    },
  };
}

const handle: TransferHandle = {
  sourceTxHash: SEND_HASH,
  depositAddress: undefined,
  destinationAddress: DESTINATION,
  sourceChainId: "arbitrum-sepolia",
};

describe("adapterFor", () => {
  const cctp = new ScriptedAdapter("cctp", [pending()]);
  const layerzero = new ScriptedAdapter("layerzero", [pending()]);
  const axelar = new ScriptedAdapter("axelar", [pending()]);
  const engine = { adapters: [cctp, axelar, layerzero] };

  it("picks the adapter that quoted the route", () => {
    expect(adapterFor(engine, routeFor("cctp"))).toBe(cctp);
    expect(adapterFor(engine, routeFor("layerzero"))).toBe(layerzero);
    expect(adapterFor(engine, routeFor("axelar"))).toBe(axelar);
  });

  it("refuses a route from a rail it does not run", () => {
    expect(() => adapterFor(engine, routeFor("wormhole"))).toThrow(/wormhole/);
  });
});

describe("stepsFor", () => {
  it("keeps the Circle steps for cctp", () => {
    const steps = stepsFor(routeFor("cctp", { newAccount: true, swap: true }));
    expect(steps.map((s) => s.id)).toEqual([
      "settle",
      "approve",
      "burn",
      "attest",
      "prepare",
      "deliver",
      "swap",
    ]);
    expect(steps.find((s) => s.id === "approve")?.label).toBe("Allow Circle to move your USDC");
    expect(steps.find((s) => s.id === "approve")?.note).toBe(
      "Confirm in your wallet: approve 5.00 USDC on Arbitrum Sepolia.",
    );
    expect(steps.find((s) => s.id === "attest")?.actor).toBe("Circle");
  });

  it("names the rail for layerzero and axelar, and never Circle", () => {
    for (const [source, rail] of [
      ["layerzero", "LayerZero"],
      ["axelar", "Axelar"],
    ] as const) {
      const steps = stepsFor(routeFor(source, { approve: true }));
      expect(steps.map((s) => s.id)).toEqual(["approve", "burn", "deliver"]);
      expect(steps.find((s) => s.id === "approve")?.label).toBe(`Allow ${rail} to move your USDC`);
      expect(steps.find((s) => s.id === "deliver")?.label).toBe(`${rail} delivers on Stellar`);
      expect(steps.find((s) => s.id === "deliver")?.actor).toBe(rail);
      for (const step of steps) {
        expect(`${step.label} ${step.note ?? ""} ${step.actor}`).not.toMatch(/Circle/);
      }
    }
  });

  it("prepares a new account before the send on a relayed rail, and skips an approval it does not need", () => {
    const steps = stepsFor(routeFor("layerzero", { newAccount: true, swap: true }));
    expect(steps.map((s) => s.id)).toEqual(["settle", "prepare", "burn", "deliver", "swap"]);
  });
});

describe("trackDelivery", () => {
  it("patches pending, then done with the delivery's reference", async () => {
    const adapter = new ScriptedAdapter("layerzero", [pending(), pending(), delivered("f00d")]);
    const { patches, patch } = recorder();

    const result = await trackDelivery(adapter, handle, patch, { wait: instant });

    expect(result.outcome).toBe("terminal");
    expect(adapter.asked).toHaveLength(3);
    expect(adapter.asked[0]).toEqual(handle);
    expect(patches[0]).toEqual({ id: "deliver", patch: { phase: "pending" } });
    expect(patches.at(-1)).toEqual({
      id: "deliver",
      patch: {
        phase: "done",
        note: "Delivered on Stellar. 5.00 USDC arrived.",
        ref: "f00d",
        refUrl: "https://stellar.expert/explorer/testnet/tx/f00d",
      },
    });
  });

  it("stops on failed and says why", async () => {
    const adapter = new ScriptedAdapter("axelar", [
      pending(),
      failed("Axelar could not deliver this transfer."),
      delivered(),
    ]);
    const { patches, patch } = recorder();

    const result = await trackDelivery(adapter, handle, patch, { wait: instant });

    expect(adapter.asked).toHaveLength(2);
    expect(result).toEqual({
      outcome: "terminal",
      phase: expect.objectContaining({ phase: "failed" }),
    });
    expect(patches.at(-1)).toEqual({
      id: "deliver",
      patch: {
        phase: "failed",
        note: "Axelar could not deliver this transfer. Nothing further happens on its own.",
      },
    });
  });

  it("stops on refunded and partial too", async () => {
    const ref = { chainId: "arbitrum-sepolia", txHash: SEND_HASH, explorerUrl: "" };
    const ends: StepPhase[] = [
      { phase: "refunded", ref, to: "0xabc", returned: { asset: STELLAR_USDC, baseUnits: "1" } },
      {
        phase: "partial",
        ref,
        received: { asset: STELLAR_USDC, baseUnits: "10000000" },
        expected: { asset: STELLAR_USDC, baseUnits: "50000000" },
        remedy: { kind: "retry", because: "Finishing it is safe." },
      },
    ];
    for (const end of ends) {
      const adapter = new ScriptedAdapter("layerzero", [end, pending()]);
      const result = await trackDelivery(adapter, handle, () => {}, { wait: instant });
      expect(result).toEqual({ outcome: "terminal", phase: end });
      expect(adapter.asked).toHaveLength(1);
    }
  });

  it("surfaces a stalled transfer's remedy as the step's note and keeps watching", async () => {
    const stalled: StepPhase = {
      phase: "stalled",
      ref: { chainId: "arbitrum-sepolia", txHash: SEND_HASH, explorerUrl: "" },
      overdueSeconds: 900,
      remedy: {
        kind: "claim",
        at: "https://testnet.layerzeroscan.com/tx/0xab",
        because: "The message is waiting for its gas to be topped up.",
      },
    };
    const adapter = new ScriptedAdapter("layerzero", [stalled, delivered()]);
    const { patches, patch } = recorder();

    await trackDelivery(adapter, handle, patch, { wait: instant });

    expect(patches).toContainEqual({
      id: "deliver",
      patch: {
        phase: "pending",
        note: "The message is waiting for its gas to be topped up. https://testnet.layerzeroscan.com/tx/0xab",
      },
    });
    expect(patches.at(-1)?.patch.phase).toBe("done");
  });

  it("shows a failed status read and keeps watching instead of failing the transfer", async () => {
    const adapter = new ScriptedAdapter("layerzero", [new Error("scan answered 503"), delivered()]);
    const { patches, patch } = recorder();

    const result = await trackDelivery(adapter, handle, patch, { wait: instant });

    expect(patches).toContainEqual({
      id: "deliver",
      patch: {
        note: "Could not check on the transfer just now (scan answered 503). Checking again.",
      },
    });
    expect(result.outcome).toBe("terminal");
  });

  it("gives up after its bound, says the transfer can be finished from Activity, and keeps the last error", async () => {
    let clock = 0;
    const adapter = new ScriptedAdapter("layerzero", [new Error("scan answered 503")], {
      onStatus: () => {
        clock += 15_000;
      },
    });
    const { patches, patch } = recorder();

    const result = await trackDelivery(adapter, handle, patch, {
      wait: instant,
      now: () => clock,
      intervalMs: 15_000,
      timeoutMs: 60_000,
    });

    expect(adapter.asked).toHaveLength(4);
    expect(result).toEqual({ outcome: "timed-out", last: undefined, error: "scan answered 503" });
    expect(patches.at(-1)?.patch.note).toMatch(/Activity/);
  });
});

describe("lookupAcross", () => {
  it("asks only the rails that carry the source chain, and the first answer that says something wins", async () => {
    const cctp = new ScriptedAdapter("cctp", [pending()], { chains: ["arbitrum-sepolia"] });
    const layerzero = new ScriptedAdapter("layerzero", [delivered()], {
      chains: ["arbitrum-sepolia"],
    });
    const axelar = new ScriptedAdapter("axelar", [failed("no")], { chains: ["base-sepolia"] });

    const answer = await lookupAcross([cctp, layerzero, axelar], handle);

    expect(answer.phase.phase).toBe("done");
    expect(answer.rails).toEqual(["layerzero"]);
    expect(axelar.asked).toHaveLength(0);
  });

  it("asks every rail when the chain is unknown", async () => {
    const rails = ["cctp", "layerzero", "axelar"].map(
      (id) => new ScriptedAdapter(id, [pending()], { chains: ["nowhere"] }),
    );
    const answer = await lookupAcross(rails, { ...handle, sourceChainId: undefined });
    expect(rails.every((r) => r.asked.length === 1)).toBe(true);
    expect(answer.phase.phase).toBe("pending");
    expect(answer.rails).toEqual(["cctp", "layerzero", "axelar"]);
  });

  it("gives idle only when every rail is idle", async () => {
    const idle = (id: string) => new ScriptedAdapter(id, [{ phase: "idle" }]);
    const all = await lookupAcross([idle("cctp"), idle("axelar")], handle);
    expect(all).toEqual({ phase: { phase: "idle" }, rails: ["cctp", "axelar"], errors: [] });

    const mixed = await lookupAcross(
      [idle("cctp"), new ScriptedAdapter("layerzero", [pending()])],
      handle,
    );
    expect(mixed.phase.phase).toBe("pending");
    expect(mixed.rails).toEqual(["layerzero"]);
  });

  it("does not let one rail's error hide another's answer, and reports the error", async () => {
    const broken = new ScriptedAdapter("axelar", [new Error("gmp api down")]);
    const fine = new ScriptedAdapter("cctp", [pending()]);
    const answer = await lookupAcross([broken, fine], handle);
    expect(answer.phase.phase).toBe("pending");
    expect(answer.errors).toEqual([{ source: "axelar", message: "gmp api down" }]);

    const unlisted = new ScriptedAdapter("layerzero", [delivered()], {
      chains: new Error("registry down"),
    });
    const second = await lookupAcross([unlisted, fine], handle);
    expect(second.phase.phase).toBe("pending");
    expect(second.errors).toEqual([{ source: "layerzero", message: "registry down" }]);
  });

  it("rejects with every rail's error when no rail answered", async () => {
    const lookup = lookupAcross(
      [
        new ScriptedAdapter("axelar", [new Error("gmp api down")]),
        new ScriptedAdapter("layerzero", [new Error("scan down")]),
      ],
      handle,
    );
    await expect(lookup).rejects.toThrow("Axelar: gmp api down. LayerZero: scan down.");
  });
});

describe("settlementBlocker", () => {
  it("allows a new account only when the rail delivers the sponsor's USDC", () => {
    expect(settlementBlocker(routeFor("layerzero", { newAccount: true }), STELLAR_USDC.id)).toBe(
      undefined,
    );
    expect(
      settlementBlocker(
        routeFor("layerzero", { newAccount: true, delivers: STELLAR_XLM }),
        STELLAR_USDC.id,
      ),
    ).toMatch(/new Stellar account/);
  });

  it("has nothing to say about an account that is ready", () => {
    expect(
      settlementBlocker(routeFor("layerzero", { delivers: STELLAR_XLM }), STELLAR_USDC.id),
    ).toBe(undefined);
  });
});

describe("pollSettlement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answers(...replies: Array<[number, unknown]>): string[] {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push(`${url} ${String(init.body)}`);
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      if (reply === undefined) throw new Error("no reply scripted");
      const [status, body] = reply;
      return new Response(JSON.stringify(body), { status });
    });
    return asked;
  }

  const sponsor = createSponsorClient("https://sponsor.test");

  it("asks until the sponsor settles", async () => {
    const asked = answers(
      [429, { error: "moments ago", retryable: true }],
      [200, { settled: false, settlementRetryable: true }],
      [200, { settled: true, settlementTxHash: "5e7" }],
    );
    const result = await pollSettlement(sponsor, DESTINATION, { wait: instant });
    expect(result).toEqual({ settled: true, settlementTxHash: "5e7" });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe(`https://sponsor.test/settle {"destination":"${DESTINATION}"}`);
  });

  it("stops when nothing is held", async () => {
    const asked = answers([404, { error: "none", retryable: false }]);
    expect(await pollSettlement(sponsor, DESTINATION, { wait: instant })).toEqual({
      settled: false,
      held: false,
    });
    expect(asked).toHaveLength(1);
  });

  it("stops after its bound", async () => {
    const asked = answers([200, { settled: false, settlementRetryable: true }]);
    const result = await pollSettlement(sponsor, DESTINATION, { wait: instant, attempts: 4 });
    expect(result).toEqual({ settled: false, settlementRetryable: true });
    expect(asked).toHaveLength(4);
  });

  it("stops on a refusal that will not change", async () => {
    const asked = answers([200, { settled: false }]);
    await pollSettlement(sponsor, DESTINATION, { wait: instant });
    expect(asked).toHaveLength(1);
  });
});

describe("settleNote", () => {
  it("says what happened to the repayment, and never calls the delivery a failure", () => {
    expect(settleNote({ settled: true, settlementTxHash: "x" })).toBe(
      "Delivered, and the deposit repaid itself from the arrival.",
    );
    expect(settleNote({ settled: false, held: false })).toMatch(/^Delivered on Stellar\./);
    expect(settleNote({ settled: false, settlementRetryable: true })).toMatch(
      /^Delivered on Stellar\. .*not gone through yet/,
    );
    expect(settleNote({ settled: false })).toMatch(/^Delivered on Stellar\./);
  });
});
