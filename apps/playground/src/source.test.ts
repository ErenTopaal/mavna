import type { MavnaWidgetConfig } from "@mavna/widget";
import { describe, expect, it } from "vitest";
import { buildSource } from "./source.js";

const config: MavnaWidgetConfig = {
  integrator: "playground.mavna.app",
  network: "testnet",
  sponsorUrl: "https://sponsor.mavna.test",
  variant: "compact",
  onEvent: () => undefined,
};

/** The object the printed `config={...}` evaluates to. */
function printedConfig(source: string): Record<string, unknown> {
  const match = /config=\{([\s\S]*)\}\n\/>$/.exec(source);
  if (match?.[1] === undefined) throw new Error(`no config prop in:\n${source}`);
  return new Function(`return (${match[1]});`)() as Record<string, unknown>;
}

describe("the config the playground prints", () => {
  it("passes onEvent inside config, the only place MavnaWidget reads it", () => {
    const source = buildSource(config);
    expect(source).not.toMatch(/^\s+onEvent=/m);
    expect(typeof printedConfig(source).onEvent).toBe("function");
  });

  it("carries every setting but this page's own sponsor", () => {
    const { onEvent: _onEvent, ...printed } = printedConfig(buildSource(config));
    expect(printed).toEqual({
      integrator: "playground.mavna.app",
      network: "testnet",
      variant: "compact",
    });
  });
});
