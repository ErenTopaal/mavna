import { describe, expect, it } from "vitest";
import { asError, msg, rememberConnection } from "./helpers";

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

describe("rememberConnection", () => {
  it("opens the wallet picker once per connection, not once per step", async () => {
    let opened = 0;
    const wallet = rememberConnection({
      connect: async () => {
        opened += 1;
        return "GABC";
      },
      sign: async (xdr) => xdr,
      disconnect: async () => {},
    });
    expect(await wallet.connect()).toBe("GABC");
    expect(await wallet.connect()).toBe("GABC");
    expect(opened).toBe(1);
    await wallet.disconnect();
    await wallet.connect();
    expect(opened).toBe(2);
  });

  it("asks again after a picker that was dismissed", async () => {
    let opened = 0;
    const wallet = rememberConnection({
      connect: async () => {
        opened += 1;
        if (opened === 1) throw { code: -1, message: "The user closed the modal." };
        return "GABC";
      },
      sign: async (xdr) => xdr,
      disconnect: async () => {},
    });
    await expect(wallet.connect()).rejects.toThrow("The user closed the modal.");
    expect(await wallet.connect()).toBe("GABC");
  });
});
