import { MavnaError, type NetworkId } from "@mavna/core";
import { tokenIdFromIndex } from "./assets.js";
import { type EvmReader, EvmRevert } from "./evm.js";
import type { StellarItsReader } from "./stellar-its.js";

/**
 * Deciding whether a token can actually make the trip, before anyone signs.
 *
 * Getting this wrong is not a failed transaction, it is a message that leaves and
 * does not arrive. So every claim here is checked against a contract rather than
 * an index, on both sides, and anything that cannot be established is a refusal
 * rather than an assumption.
 */

/**
 * How a token manager takes the tokens, read from Axelar's own enum.
 *
 * The ordering is not what it looks like and is worth writing down: burn-from
 * sits at 1 and plain mint-burn at 4, so a reasonable guess at this enum puts
 * `LOCK_UNLOCK` where `MINT_BURN_FROM` is. That mistake would emit an approval
 * for a token that needs none and skip it for one that does.
 */
export const TOKEN_MANAGER = {
  nativeInterchainToken: 0,
  mintBurnFrom: 1,
  lockUnlock: 2,
  lockUnlockFee: 3,
  mintBurn: 4,
} as const;

/**
 * Whether the user has to approve before the service can take their tokens.
 *
 * Traced through the source rather than guessed. The service delegatecalls its
 * token handler, so the handler's `safeTransferFrom` and `burnFrom` run in the
 * SERVICE's context and the allowance is checked against the service. Lock and
 * burn-from both go that way. The other two call `burnToken` on the token
 * manager, which burns using a minter role it already holds, so there is no
 * allowance in the path at all.
 */
export function needsApproval(tokenManagerType: number): boolean {
  return (
    tokenManagerType === TOKEN_MANAGER.mintBurnFrom ||
    tokenManagerType === TOKEN_MANAGER.lockUnlock ||
    tokenManagerType === TOKEN_MANAGER.lockUnlockFee
  );
}

export interface ItsToken {
  readonly tokenId: string;
  /** The ERC-20 on the sending chain, as the token service has it registered. */
  readonly sourceToken: string;
  readonly sourceDecimals: number;
  readonly tokenManager: string;
  readonly tokenManagerType: number;
  /**
   * Who to approve, when an approval is needed at all.
   *
   * The token SERVICE, never the token manager. The tokens land in the manager
   * but the transfer is executed by the service, so an allowance naming the
   * manager leaves the transfer reverting for want of one.
   */
  readonly approvalSpender: string | undefined;
  /** The contract this arrives as on Stellar. */
  readonly stellarToken: string;
}

export interface ResolveInputs {
  readonly network: NetworkId;
  /** The API-facing chain name, because the only use here is an index lookup. */
  readonly sourceChainId: string;
  readonly tokenService: string;
  readonly tokenAddress: string;
  readonly evm: EvmReader;
  readonly stellar: StellarItsReader;
}

/**
 * The token id for an address, asking the token first and the index second.
 *
 * A token the service deployed knows its own id and will say so. A plain ERC-20
 * brought in as a canonical token has no such method and reverts, and for those
 * Axelar's published list is the only place the id exists off-chain. Whichever
 * answers, the id is then verified against the service, so a stale index entry
 * cannot get past this.
 */
async function resolveTokenId(inputs: ResolveInputs): Promise<string> {
  try {
    return await inputs.evm.interchainTokenId(inputs.tokenAddress);
  } catch (cause) {
    if (!(cause instanceof EvmRevert)) throw cause;
  }

  const indexed = await tokenIdFromIndex(inputs.network, inputs.sourceChainId, inputs.tokenAddress);
  if (indexed === undefined) {
    throw new UnsupportedToken(
      "That token has not been set up to travel to Stellar on this route.",
    );
  }
  return indexed;
}

/**
 * Establish that a token really can go from this chain to Stellar.
 *
 * Throws `UnsupportedToken` when the answer is a plain no, which the adapter
 * turns into a rejection a user can read. Anything else is a real failure and is
 * left alone to propagate.
 */
export async function resolveItsToken(inputs: ResolveInputs): Promise<ItsToken> {
  const tokenId = await resolveTokenId(inputs);

  const registered = await inputs.evm
    .registeredTokenAddress(inputs.tokenService, tokenId)
    .catch(asUnsupported("That token is not set up on this chain for interchain transfers."));

  if (registered.toLowerCase() !== inputs.tokenAddress.toLowerCase()) {
    // The service has a token under this id and it is not the one asked about.
    // Sending anyway would move a different asset than the user chose.
    throw new UnsupportedToken(
      "The transfer service has a different token recorded under that name on this chain.",
    );
  }

  const tokenManager = await inputs.evm
    .deployedTokenManager(inputs.tokenService, tokenId)
    .catch(asUnsupported("That token has not been linked for transfers on this chain yet."));

  const kind = await inputs.evm.tokenManagerKind(tokenManager);
  if (kind.token.toLowerCase() !== inputs.tokenAddress.toLowerCase()) {
    throw new UnsupportedToken(
      "The transfer service disagrees with itself about which token this is. " +
        "Nothing will be sent while that is true.",
    );
  }

  // The receiving side is checked separately and on purpose. A token the sending
  // chain is happy with can still be unknown on Stellar, and that failure lands
  // after the funds have left.
  const stellarToken = await inputs.stellar.registeredTokenAddress(tokenId);
  if (stellarToken === undefined) {
    throw new UnsupportedToken("That token cannot be received on Stellar yet.");
  }

  const sourceDecimals = await inputs.evm.decimals(inputs.tokenAddress);

  return {
    tokenId,
    sourceToken: registered,
    sourceDecimals,
    tokenManager,
    tokenManagerType: kind.type,
    approvalSpender: needsApproval(kind.type) ? inputs.tokenService : undefined,
    stellarToken,
  };
}

/**
 * Both sides agree the other is reachable.
 *
 * Asking only the sending chain is the observed failure: a name can pass there
 * and be dropped afterwards, and the tokens and the gas go with it. So the answer
 * has to come from both, and disagreement is a no.
 *
 * BOTH names here are the contract-facing ones. A contract answers a name it does
 * not know with a plain `false` rather than an error, so passing an API name
 * gives a confident no: Stellar's token service on mainnet says false to
 * "ethereum" and true to "Ethereum", and nothing about the first answer looks
 * wrong.
 */
export async function chainsTrustEachOther(inputs: {
  readonly evm: EvmReader;
  readonly stellar: StellarItsReader;
  readonly tokenService: string;
  readonly sourceAxelarId: string;
  readonly stellarAxelarId: string;
}): Promise<boolean> {
  const [sending, receiving] = await Promise.all([
    inputs.evm.trustsChain(inputs.tokenService, inputs.stellarAxelarId),
    inputs.stellar.trustsChain(inputs.sourceAxelarId),
  ]);
  return sending && receiving;
}

/** A token that cannot make this trip. An answer, not a malfunction. */
export class UnsupportedToken extends MavnaError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = "UnsupportedToken";
  }
}

function asUnsupported(explanation: string): (cause: unknown) => never {
  return (cause: unknown) => {
    if (cause instanceof EvmRevert) throw new UnsupportedToken(explanation);
    throw cause;
  };
}
