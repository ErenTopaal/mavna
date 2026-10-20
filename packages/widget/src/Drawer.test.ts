import { describe, expect, it } from "vitest";
import { dismissesOnKey } from "./Drawer";

/** A node that holds only what it is told it holds, as `Node.contains` answers. */
const overlay = (inside: unknown[]) => ({ contains: (n: unknown) => inside.includes(n) });

describe("dismissesOnKey", () => {
  const field = {};
  const kitModal = {};

  it("closes on an Escape pressed inside the drawer", () => {
    expect(dismissesOnKey({ key: "Escape", target: field }, overlay([field]))).toBe(true);
  });

  it("ignores an Escape meant for something outside it, like the wallet picker", () => {
    expect(dismissesOnKey({ key: "Escape", target: kitModal }, overlay([field]))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(dismissesOnKey({ key: "Enter", target: field }, overlay([field]))).toBe(false);
  });
});
