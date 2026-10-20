import type { NetworkConfig, RpcClient } from "@mavna/stellar";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assertFeeWithin, assertOnlyExecutorCompose, ComposeRefused, Composer } from "./compose.js";

const CONTRACT = "CDAIQ522QK5AFCCVGENKVE7SDF6KRCDCAPRFGUWQ4GXO4NJZRVOHQN6X";
const executor = Keypair.random().publicKey();
const args = [
  new Address(executor).toScVal(),
  nativeToScVal(7, { type: "u32" }),
  xdr.ScVal.scvBytes(Buffer.from("01", "hex")),
];

function invocation(
  contract: string,
  fn: string,
  callArgs: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args: callArgs,
      }),
    ),
    subInvocations: subs,
  });
}

function byAddress(
  who: string,
  root: xdr.SorobanAuthorizedInvocation,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(who).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

/** The same signature as the network records it now, CAP-71's address credentials. */
function byAddressV2(
  who: string,
  root: xdr.SorobanAuthorizedInvocation,
  delegated = false,
): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(who).toScAddress(),
    nonce: 1n,
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: delegated
      ? xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
          new xdr.SorobanAddressCredentialsWithDelegates({
            addressCredentials: credentials,
            delegates: [],
          }),
        )
      : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: root,
  });
}

const expected = { executor, contract: CONTRACT, args };
const good = byAddress(executor, invocation(CONTRACT, "lz_compose", args));

describe("what a finish may authorize", () => {
  it("accepts exactly the executor's lz_compose on the configured contract", () => {
    expect(() => assertOnlyExecutorCompose([good], expected)).not.toThrow();
  });

  it("accepts the executor's signature in the encoding the network records now", () => {
    const v2 = byAddressV2(executor, invocation(CONTRACT, "lz_compose", args));
    expect(() => assertOnlyExecutorCompose([v2], expected)).not.toThrow();
  });

  it("refuses another key's v2 signature, and one that carries delegates", () => {
    for (const entry of [
      byAddressV2(Keypair.random().publicKey(), invocation(CONTRACT, "lz_compose", args)),
      byAddressV2(executor, invocation(CONTRACT, "lz_compose", args), true),
    ]) {
      expect(() => assertOnlyExecutorCompose([entry], expected)).toThrow(ComposeRefused);
    }
  });

  it("refuses anything a token in the message could have added", () => {
    // what the review's hostile wanted token produced: a transfer nested under lz_compose
    const nested = invocation(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "transfer",
      [new Address(executor).toScVal()],
    );
    const cases: xdr.SorobanAuthorizationEntry[][] = [
      [],
      [good, good],
      [byAddress(executor, invocation(CONTRACT, "lz_compose", args, [nested]))],
      [byAddress(Keypair.random().publicKey(), invocation(CONTRACT, "lz_compose", args))],
      [byAddress(executor, invocation(CONTRACT, "config", args))],
      [
        byAddress(
          executor,
          invocation(
            "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
            "lz_compose",
            args,
          ),
        ),
      ],
      [byAddress(executor, invocation(CONTRACT, "lz_compose", args.slice(0, 2)))],
      [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: invocation(CONTRACT, "lz_compose", args),
        }),
      ],
    ];
    for (const entries of cases) {
      expect(() => assertOnlyExecutorCompose(entries, expected)).toThrow(ComposeRefused);
    }
  });
});

describe("the executor key", () => {
  it("must not be the key that pays", () => {
    const payer = Keypair.random().secret();
    expect(
      () =>
        new Composer({
          rpc: {} as RpcClient,
          network: { passphrase: "Test SDF Network ; September 2015" } as NetworkConfig,
          contract: CONTRACT,
          payerSecret: payer,
          executorSecret: payer,
        }),
    ).toThrow(/separate/);
  });
});

describe("what the sponsor pays to sign a compose transaction", () => {
  it("is refused above its ceiling, before anything is signed", () => {
    expect(() => assertFeeWithin(10_000_001n, 10_000_000n, "finishing this conversion")).toThrow(
      /finishing this conversion would cost 1\.0000001 XLM, more than the 1 XLM/,
    );
    expect(() => assertFeeWithin(10_000_000n, 10_000_000n, "x")).not.toThrow();
  });
});
