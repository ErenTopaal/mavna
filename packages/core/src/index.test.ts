import { describe, expect, it } from "vitest";
import { MavnaError } from "./index.js";

describe("MavnaError", () => {
  it("carries whether the caller may retry", () => {
    const transient = new MavnaError("rpc unreachable", { retryable: true });
    const permanent = new MavnaError("destination cannot hold this asset", { retryable: false });

    expect(transient.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
  });

  it("preserves the underlying cause so it is not swallowed", () => {
    const cause = new Error("ECONNRESET");
    const err = new MavnaError("rpc unreachable", { retryable: true, cause });

    expect(err.cause).toBe(cause);
  });

  it("is distinguishable from errors raised by anything else", () => {
    expect(new MavnaError("x", { retryable: false })).toBeInstanceOf(MavnaError);
    expect(new Error("x")).not.toBeInstanceOf(MavnaError);
  });
});
