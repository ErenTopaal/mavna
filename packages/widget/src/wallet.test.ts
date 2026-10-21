import { createWalletClient, custom, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { isUserRejection } from "./wallet";

const SENDER = "0xb11111F63A875Ac80Fb870f797eB6A2Bf2836a25";

/** What viem throws when the wallet itself answers a send with EIP-1193's 4001. */
async function rejectedByWallet(code: number): Promise<unknown> {
  const wallet = createWalletClient({
    account: SENDER,
    transport: custom({
      async request({ method }) {
        if (method === "eth_chainId") return "0x66eee";
        if (method === "eth_sendTransaction") {
          throw Object.assign(new Error("User rejected the request."), { code });
        }
        throw new Error(`not answered: ${method}`);
      },
    }),
  });
  return wallet
    .writeContract({
      chain: {
        id: 421_614,
        name: "Arbitrum Sepolia",
        nativeCurrency: { name: "", symbol: "", decimals: 18 },
        rpcUrls: { default: { http: [] } },
      },
      account: SENDER,
      address: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
      abi: erc20Abi,
      functionName: "approve",
      args: ["0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", 1n],
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    .catch((e: unknown) => e);
}

describe("a signature the user turned down", () => {
  it("is recognised through viem's wrapping, however deep the wallet's code sits", async () => {
    // a live approval refused in the wallet reached the screen as viem's whole
    // error, calldata and docs link included, because the 4001 sat three causes down
    expect(isUserRejection(await rejectedByWallet(4001))).toBe(true);
  });

  it("is not mistaken for any other failure", async () => {
    expect(isUserRejection(await rejectedByWallet(-32603))).toBe(false);
  });
});
