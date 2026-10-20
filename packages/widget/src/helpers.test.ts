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

describe("rememberConnection, when the wallet changes underneath it", () => {
  const counting = (addresses: string[]) => {
    let opened = 0;
    const wallet = rememberConnection({
      connect: async () => {
        opened += 1;
        return addresses[Math.min(opened, addresses.length) - 1] ?? "";
      },
      sign: async (xdr) => xdr,
      disconnect: async () => {},
    });
    return { wallet, opened: () => opened };
  };

  it("opens one picker for two connects asked at once", async () => {
    const { wallet, opened } = counting(["GABC"]);
    expect(await Promise.all([wallet.connect(), wallet.connect()])).toEqual(["GABC", "GABC"]);
    expect(opened()).toBe(1);
  });

  it("asks the wallet again once told the remembered address was the wrong one", async () => {
    const { wallet, opened } = counting(["GOLD", "GNEW"]);
    expect(await wallet.connect()).toBe("GOLD");
    wallet.forget?.();
    expect(await wallet.connect()).toBe("GNEW");
    expect(opened()).toBe(2);
  });
});

describe("rememberConnection, telling the header", () => {
  const changing = () => {
    let tell: ((address: string | undefined) => void) | undefined;
    let opened = 0;
    const wallet = rememberConnection({
      connect: async () => {
        opened += 1;
        return "GOLD";
      },
      sign: async (xdr) => xdr,
      disconnect: async () => {},
      onChange: (listener) => {
        tell = listener;
        return () => {
          tell = undefined;
        };
      },
    });
    return { wallet, change: (a: string | undefined) => tell?.(a), opened: () => opened };
  };

  it("says the connected address, then nothing once it is forgotten", async () => {
    const { wallet } = changing();
    const heard: Array<string | undefined> = [];
    wallet.onChange?.((a) => heard.push(a));
    await wallet.connect();
    wallet.forget?.();
    expect(heard).toEqual(["GOLD", undefined]);
  });

  it("follows an account switched in the wallet, without opening the picker again", async () => {
    const { wallet, change, opened } = changing();
    const heard: Array<string | undefined> = [];
    wallet.onChange?.((a) => heard.push(a));
    await wallet.connect();
    change("GNEW");
    expect(heard).toEqual(["GOLD", "GNEW"]);
    expect(await wallet.connect()).toBe("GNEW");
    expect(opened()).toBe(1);
  });
});

describe("rememberConnection, letting go of the wallet", () => {
  it("stops listening to the wallet once nothing listens to it, and starts again after", () => {
    let listening = 0;
    const wallet = rememberConnection({
      connect: async () => "G",
      sign: async (xdr) => xdr,
      disconnect: async () => {},
      onChange: () => {
        listening += 1;
        return () => {
          listening -= 1;
        };
      },
    });
    expect(listening).toBe(0);
    const stop = wallet.onChange?.(() => {});
    expect(listening).toBe(1);
    stop?.();
    expect(listening).toBe(0);
    const again = wallet.onChange?.(() => {});
    expect(listening).toBe(1);
    again?.();
    expect(listening).toBe(0);
  });
});
