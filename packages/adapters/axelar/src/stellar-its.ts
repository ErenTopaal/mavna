import { MavnaError } from "@mavna/core";
import type { RpcClient } from "@mavna/stellar";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Asking Stellar's token service the same questions, on the receiving side.
 *
 * The project specification is explicit that a destination chain must be checked
 * against BOTH sides, because drift between them is observed: a name can pass on
 * one side and be dropped on the other, taking the tokens and the gas with it.
 * The sending chain's answer alone is therefore not enough, and this is the other
 * half.
 *
 * These are reads, so they are simulated rather than submitted. Nothing here
 * signs, and the source account is a throwaway that never needs to exist: a
 * simulation of a read-only call does not touch it.
 */

/** Function names taken from Axelar's own Stellar tooling, not from memory. */
const IS_TRUSTED_CHAIN = "is_trusted_chain";
const REGISTERED_TOKEN_ADDRESS = "registered_token_address";

export class StellarItsReader {
  private readonly passphrase: string;
  private readonly client: RpcClient;
  private readonly service: string;

  constructor(client: RpcClient, service: string, network: "testnet" | "mainnet") {
    this.client = client;
    this.service = service;
    this.passphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  }

  /** Whether Stellar's token service will accept messages from this chain. */
  async trustsChain(chainId: string): Promise<boolean> {
    const value = await this.simulate(IS_TRUSTED_CHAIN, nativeToScVal(chainId, { type: "string" }));
    if (typeof value !== "boolean") {
      throw new MavnaError(
        `Stellar's token service answered ${IS_TRUSTED_CHAIN} with something other than ` +
          "a yes or a no. Refusing to read a trust decision out of it.",
        { retryable: false },
      );
    }
    return value;
  }

  /**
   * The Stellar contract this token id arrives as, or undefined when there is none.
   *
   * A token id Stellar has never heard of makes the contract fail rather than
   * return a zero address, which is the behaviour worth having: the failure is
   * the answer, and it cannot be mistaken for a valid address.
   */
  async registeredTokenAddress(tokenId: string): Promise<string | undefined> {
    const bytes = Buffer.from(tokenId.replace(/^0x/, ""), "hex");
    if (bytes.length !== 32) {
      throw new MavnaError(`A token id must be 32 bytes; got ${bytes.length}.`, {
        retryable: false,
      });
    }

    let value: unknown;
    try {
      value = await this.simulate(REGISTERED_TOKEN_ADDRESS, xdr.ScVal.scvBytes(bytes));
    } catch (cause) {
      if (cause instanceof ItsNotRegistered) return undefined;
      throw cause;
    }
    return typeof value === "string" ? value : undefined;
  }

  /**
   * How many decimals the token has ON STELLAR.
   *
   * Asked of the token rather than taken from Axelar's published list, because
   * the same token is registered with different precision on different chains
   * and this number decides what a user is told they will receive.
   */
  async tokenDecimals(token: string): Promise<number> {
    const value = await this.simulateOn(token, "decimals");
    if (typeof value !== "number" && typeof value !== "bigint") {
      throw new MavnaError(
        `The Stellar contract ${token} did not answer how many decimals it has.`,
        { retryable: false },
      );
    }
    return Number(value);
  }

  private simulate(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    return this.simulateOn(this.service, method, ...args);
  }

  private async simulateOn(target: string, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const contract = new Contract(target);
    // Sequence zero on a key that has never been used: a read-only simulation
    // never looks the account up, and inventing one here means this needs no
    // funded account and holds no key that matters.
    const source = new Account(Keypair.random().publicKey(), "0");
    const transaction = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.passphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.client.server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new ItsNotRegistered(
        `Stellar's token service refused ${method}: ${simulation.error.split("\n")[0] ?? "no reason given"}`,
      );
    }
    const returned = simulation.result?.retval;
    if (returned === undefined) {
      throw new MavnaError(`Stellar's token service returned nothing from ${method}.`, {
        retryable: true,
      });
    }
    return scValToNative(returned);
  }
}

/** The contract said no. Distinct from the network failing to ask it. */
export class ItsNotRegistered extends MavnaError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "ItsNotRegistered";
  }
}
