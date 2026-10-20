import { describe, expect, it } from "vitest";
import { asError, msg } from "./helpers";

describe("wallet kit rejections", () => {
  // the shape stellar-wallets-kit's parseError rejects with
  const kit = { code: -4, message: "The user rejected this request." };

  it("keep the wallet's own reason as an Error", () => {
    const error = asError(kit);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("The user rejected this request.");
  });

  it("are shown with their reason, not the fallback", () => {
    expect(msg(kit)).toBe("The user rejected this request.");
    expect(msg(undefined)).toBe("That did not work.");
  });
});
