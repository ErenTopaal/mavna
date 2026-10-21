import { Asset, Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import usdcIssuer from "./__fixtures__/mainnet-usdc-issuer-account.json" with { type: "json" };
import usdt0Issuer from "./__fixtures__/mainnet-usdt0-issuer-account.json" with { type: "json" };
import { HorizonIssuerFlags } from "./issuer.js";

// both recorded from horizon.stellar.org on 2026-10-22
const USDC = new Asset("USDC", usdcIssuer.account_id);
const USDT0 = new Asset("USDT0", usdt0Issuer.account_id);

/** Horizon's account endpoint, answered from what it returned for each issuer. */
function stubHorizon(accounts: Record<string, unknown>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    asked.push(url.pathname);
    const id = url.pathname.replace("/accounts/", "");
    const body = accounts[id];
    if (body === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HorizonIssuerFlags", () => {
  it("reads that neither Circle's USDC issuer nor USDT0's requires authorization today", async () => {
    stubHorizon({ [usdcIssuer.account_id]: usdcIssuer, [usdt0Issuer.account_id]: usdt0Issuer });
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    expect(await flags.authRequired(USDC)).toBe(false);
    expect(await flags.authRequired(USDT0)).toBe(false);
  });

  it("reads an issuer that turned auth_required on", async () => {
    const turnedOn = { ...usdt0Issuer, flags: { ...usdt0Issuer.flags, auth_required: true } };
    stubHorizon({ [usdt0Issuer.account_id]: turnedOn });
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    expect(await flags.authRequired(USDT0)).toBe(true);
  });

  it("asks once a minute per issuer, and again once that has passed", async () => {
    const asked = stubHorizon({ [usdt0Issuer.account_id]: usdt0Issuer });
    vi.useFakeTimers({ toFake: ["Date"] });
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    await Promise.all([flags.authRequired(USDT0), flags.authRequired(USDT0)]);
    await flags.authRequired(USDT0);
    expect(asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    await flags.authRequired(USDT0);
    expect(asked).toHaveLength(2);
  });

  it("throws when Horizon cannot say, and asks again next time", async () => {
    const asked = stubHorizon({ [usdt0Issuer.account_id]: new Response("", { status: 503 }) });
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    await expect(flags.authRequired(USDT0)).rejects.toMatchObject({ retryable: true });
    await expect(flags.authRequired(USDT0)).rejects.toThrow(/USDT0/);
    expect(asked).toHaveLength(2);
  });

  it("refuses an answer without the flags rather than guessing them", async () => {
    const { flags: _gone, ...withoutFlags } = usdcIssuer;
    stubHorizon({ [usdcIssuer.account_id]: withoutFlags });
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    await expect(flags.authRequired(USDC)).rejects.toThrow(/flags/);
  });

  it("throws for an issuer account that does not exist", async () => {
    stubHorizon({});
    const flags = new HorizonIssuerFlags({ horizonUrl: "https://horizon.stellar.org" });
    await expect(
      flags.authRequired(new Asset("USDC", Keypair.random().publicKey())),
    ).rejects.toMatchObject({ retryable: false });
  });
});
