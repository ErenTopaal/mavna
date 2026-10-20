import { describe, expect, it } from "vitest";
import { dismissesOnKey, nextFocus } from "./Drawer";

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

describe("nextFocus, which keeps Tab inside the drawer", () => {
  const [a, b, c] = [{}, {}, {}];
  it("wraps from the last to the first, and back with Shift", () => {
    expect(nextFocus([a, b, c], c, false)).toBe(a);
    expect(nextFocus([a, b, c], a, true)).toBe(c);
  });
  it("leaves Tab alone in the middle", () => {
    expect(nextFocus([a, b, c], b, false)).toBeUndefined();
  });
  it("brings focus back in when it is outside", () => {
    expect(nextFocus([a, b, c], {}, false)).toBe(a);
  });
});
