import { MavnaError, type NetworkId } from "@mavna/core";
import type { RpcClient } from "@mavna/stellar";
import {
  Contract,
  Networks,
  Asset as StellarAsset,
  StrKey,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { type Abi, decodeFunctionResult, encodeFunctionData } from "viem";
import {
  type EvmSource,
  LAYERZERO_DVN_METADATA_URL,
  LAYERZERO_METADATA_URL,
  LAYERZERO_OFT_REGISTRY_URL,
  ROUTED_SYMBOLS,
  STELLAR_SIDE,
  sourceFor,
} from "./config.js";
import { assertDvnStackIsSound, SEND_ULN_ABI, type UlnConfig } from "./dvn.js";
import { EvmReader, type EvmReaderOptions } from "./evm.js";
import {
  bytes32ToStellarContract,
  ENDPOINT_ABI,
  ERC20_ABI,
  isZeroBytes32,
  MSG_TYPE_SEND,
  OFT_ABI,
} from "./oft.js";

/**
 * Working out where LayerZero is, and refusing to guess.
 *
 * Nothing about a LayerZero deployment is a constant in this package, for a
 * reason that is measured rather than cautious. The project specification
 * recorded three Stellar testnet addresses as verified on-chain. All three are
 * still deployed, still answer, and are no longer the deployment LayerZero
 * advertises: a second complete stack went up on 4 August 2026 and the registry
 * was repointed at it. Both endpoints report endpoint id 40600. Nothing about
 * using the wrong one fails loudly.
 *
 * So every piece is derived and then cross-examined:
 *   the Stellar endpoint comes from LayerZero's registry;
 *   the EVM endpoint comes from the OFT contract, not from the registry;
 *   the source endpoint id comes from that endpoint;
 *   the Stellar OFT comes from the EVM OFT's own peer entry;
 *   and the Stellar OFT is then asked which endpoint IT is registered on.
 *
 * That last check is the one that matters. It is what stops a transfer being
 * built into an OFT that lives on a superseded endpoint, which is a failure with
 * no error message and no automatic recovery.
 */

/** Registries answer in well under a second normally; this is the give-up point. */
const REGISTRY_TIMEOUT_MS = 6000;

export interface StellarDeployment {
  readonly eid: number;
  readonly endpoint: string;
  readonly sendUln302: string;
  readonly executor: string;
}

export interface StellarOftFacts {
  /** Which endpoint this OFT is registered on. The whole point of reading it. */
  readonly endpoint: string;
  /** The Stellar token contract the OFT credits, a SAC for a classic asset. */
  readonly token: string;
  /** Local decimals minus shared decimals, as the contract itself records it. */
  readonly decimalsDiff: number;
  /** Whether it mints on arrival or releases from a lock-up. */
  readonly kind: string;
}

/** A Stellar classic asset, as a person and the order book name it. */
export interface StellarClassicAsset {
  readonly code: string;
  readonly issuer: string;
  /** `CODE:ISSUER`, the only form of the name that is an identity. */
  readonly id: string;
}

export interface ResolvedRoute {
  readonly chainId: string;
  readonly source: EvmSource;
  readonly symbol: string;
  /** The OFT or OFT adapter on the source chain. Also the approval's spender. */
  readonly oft: string;
  readonly token: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly sharedDecimals: number;
  readonly approvalRequired: boolean;
  readonly endpoint: string;
  readonly sourceEid: number;
  /** The Stellar contract this OFT is peered to, decoded from its own storage. */
  readonly stellarOft: string;
  readonly stellar: StellarOftFacts;
  /**
   * The classic asset behind the Stellar token, read from the token's own
   * storage, or undefined when the token is a plain Soroban contract with no
   * code and issuer to address it by.
   */
  readonly delivers: StellarClassicAsset | undefined;
  /** What the OApp already enforces, so nothing has to be invented. */
  readonly enforcedOptions: `0x${string}`;
  readonly sendLibrary: string;
  /** Merged with the network defaults. What will actually be used. */
  readonly uln: UlnConfig;
  /** Raw, unmerged. The only thing that shows whether anybody chose it. */
  readonly appUln: UlnConfig;
  /**
   * What LayerZero calls each verifier in `uln`, keyed by lowercase address.
   * One missing from LayerZero's list is absent here and gets named by its
   * address.
   */
  readonly dvnNames: ReadonlyMap<string, string>;
}

interface DvnListing {
  readonly dvns?: Readonly<Record<string, { readonly canonicalName?: string }>>;
}

interface RegistryDeployment {
  readonly version?: number;
  readonly eid?: string;
  readonly endpointV2?: { readonly address?: string };
  readonly sendUln302?: { readonly address?: string };
  readonly executor?: { readonly address?: string };
}

interface RegistryChain {
  readonly deployments?: readonly RegistryDeployment[];
}

interface OftDeployment {
  readonly address?: string;
  readonly type?: string;
}

interface OftEntry {
  readonly name?: string;
  readonly deployments?: Readonly<Record<string, OftDeployment>>;
}

export interface DiscoveryOptions {
  readonly network: NetworkId;
  /** Reads the Stellar side, through the freshness guard. */
  readonly rpc: RpcClient;
  /** Injectable so a caller can bring their own nodes or their own transport. */
  readonly evm?: EvmReaderOptions;
  /** Extra OFTs to consider, named by the caller rather than found in a registry. */
  readonly ofts?: readonly OftLocation[];
  readonly fetch?: typeof globalThis.fetch;
}

/** An OFT a caller knows about that LayerZero's registry does not. */
export interface OftLocation {
  /** One of this rail's source chain ids. */
  readonly chainId: string;
  /** The OFT or OFT adapter contract. */
  readonly address: `0x${string}`;
  /** What to call it in the interface. */
  readonly symbol: string;
}

export class Discovery {
  private readonly network: NetworkId;
  private readonly rpc: RpcClient;
  private readonly evmOptions: EvmReaderOptions;
  private readonly extraOfts: readonly OftLocation[];
  private readonly fetchImpl: typeof globalThis.fetch;

  private readonly readers = new Map<string, EvmReader>();
  private stellarDeployment: Promise<StellarDeployment> | undefined;
  private oftRegistry: Promise<Readonly<Record<string, readonly OftEntry[]>>> | undefined;
  private dvnList: Promise<Readonly<Record<string, DvnListing>>> | undefined;
  private readonly routes = new Map<string, Promise<ResolvedRoute>>();
  private readonly settled = new Map<string, ResolvedRoute>();

  constructor(options: DiscoveryOptions) {
    this.network = options.network;
    this.rpc = options.rpc;
    this.evmOptions = options.evm ?? {};
    this.extraOfts = options.ofts ?? [];
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Where LayerZero is on Stellar, according to LayerZero.
   *
   * Exactly one version 2 deployment is expected. Zero means it is gone; more
   * than one means a rotation is in progress, and choosing during a rotation is
   * how a transfer routes into the deployment being retired.
   */
  async stellar(): Promise<StellarDeployment> {
    if (this.stellarDeployment !== undefined) return this.stellarDeployment;
    const pending = this.loadStellarDeployment();
    this.stellarDeployment = pending;
    // A rejected load is dropped so the next call asks again. Caching it would
    // turn one registry hiccup into a rail that is off until the process restarts.
    pending.catch(() => {
      if (this.stellarDeployment === pending) this.stellarDeployment = undefined;
    });
    return pending;
  }

  private async loadStellarDeployment(): Promise<StellarDeployment> {
    const side = STELLAR_SIDE[this.network];
    const response = await this.fetchImpl(LAYERZERO_METADATA_URL, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new MavnaError(
        `Could not reach LayerZero's deployment registry (HTTP ${response.status}).`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = (await response.json()) as Readonly<Record<string, RegistryChain>>;
    const chain = body[side.chainKey];
    if (chain === undefined) {
      throw new MavnaError(
        `LayerZero's registry no longer lists "${side.chainKey}". Refusing to fall back to a ` +
          "written-down address, because the last set of those was superseded while still live.",
        { retryable: false },
      );
    }

    const v2 = (chain.deployments ?? []).filter((d) => d.version === 2);
    if (v2.length !== 1) {
      throw new MavnaError(
        `Expected exactly one LayerZero V2 deployment on ${side.chainKey}, found ${v2.length}. ` +
          "Zero means it is gone; more than one means a redeployment is in progress.",
        { retryable: true },
      );
    }

    const deployment = v2[0];
    const endpoint = deployment?.endpointV2?.address;
    const sendUln302 = deployment?.sendUln302?.address;
    const executor = deployment?.executor?.address;
    if (endpoint === undefined || sendUln302 === undefined || executor === undefined) {
      throw new MavnaError(
        `LayerZero's registry gave an incomplete Stellar deployment for ${side.chainKey}.`,
        { retryable: false },
      );
    }

    const eid = Number(deployment?.eid);
    if (eid !== side.eid) {
      throw new MavnaError(
        `LayerZero now says ${side.chainKey} is endpoint ${eid}, not ${side.eid}. An endpoint ` +
          "id changing means the pathway has been rebuilt; every peer configured against the " +
          "old one is stale. Refusing to route until this package is updated.",
        { retryable: false },
      );
    }

    return { eid, endpoint, sendUln302, executor };
  }

  /** Candidate OFTs on a chain, from LayerZero's registry plus anything named directly. */
  async candidatesFor(chainId: string): Promise<readonly OftLocation[]> {
    const source = sourceFor(this.network, chainId);
    if (source === undefined) return [];

    const named = this.extraOfts.filter((oft) => oft.chainId === chainId);
    const symbols = ROUTED_SYMBOLS[this.network];
    if (symbols.length === 0) return named;

    const registry = await this.registry();
    const found: OftLocation[] = [];
    for (const symbol of symbols) {
      for (const entry of registry[symbol] ?? []) {
        // The registry files several products under one symbol. Only the one
        // whose name is the symbol is the token itself; the others are meshes
        // and pools that happen to be denominated in it.
        if (entry.name !== symbol) continue;
        const address = entry.deployments?.[source.layerZeroKey]?.address;
        if (address === undefined) continue;
        found.push({ chainId, address: address as `0x${string}`, symbol });
      }
    }

    // Anything named by the caller wins, so a caller testing their own OFT is not
    // silently served the registry's instead.
    const explicit = new Set(named.map((o) => o.address.toLowerCase()));
    return [...named, ...found.filter((o) => !explicit.has(o.address.toLowerCase()))];
  }

  private async registry(): Promise<Readonly<Record<string, readonly OftEntry[]>>> {
    if (this.oftRegistry !== undefined) return this.oftRegistry;
    const pending = (async () => {
      const response = await this.fetchImpl(LAYERZERO_OFT_REGISTRY_URL, {
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new MavnaError(
          `Could not reach LayerZero's OFT registry (HTTP ${response.status}).`,
          {
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }
      return (await response.json()) as Readonly<Record<string, readonly OftEntry[]>>;
    })();
    this.oftRegistry = pending;
    pending.catch(() => {
      if (this.oftRegistry === pending) this.oftRegistry = undefined;
    });
    return pending;
  }

  /** LayerZero's DVN list, cached for the session like the OFT registry. */
  private async dvnListing(): Promise<Readonly<Record<string, DvnListing>>> {
    if (this.dvnList !== undefined) return this.dvnList;
    const pending = (async () => {
      const response = await this.fetchImpl(LAYERZERO_DVN_METADATA_URL, {
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new MavnaError(
          `Could not reach LayerZero's list of verifiers (HTTP ${response.status}).`,
          { retryable: response.status === 429 || response.status >= 500 },
        );
      }
      return (await response.json()) as Readonly<Record<string, DvnListing>>;
    })();
    this.dvnList = pending;
    pending.catch(() => {
      if (this.dvnList === pending) this.dvnList = undefined;
    });
    return pending;
  }

  /**
   * The names of the verifiers in a set, as LayerZero lists them for that chain.
   *
   * The list covers mainnet only, so testnet asks nothing and every verifier
   * there is named by its address.
   */
  private async dvnNamesFor(source: EvmSource, uln: UlnConfig): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (this.network !== "mainnet") return names;
    const listed = (await this.dvnListing())[source.layerZeroKey]?.dvns ?? {};
    for (const dvn of [...uln.requiredDVNs, ...uln.optionalDVNs]) {
      const name = listed[dvn.toLowerCase()]?.canonicalName;
      if (typeof name === "string" && name !== "") names.set(dvn.toLowerCase(), name);
    }
    return names;
  }

  /**
   * The first candidate on a chain that survives every check, or an error saying
   * why none did.
   *
   * Cached per chain, because all of it is configuration rather than price:
   * peers, decimals and verifier sets do not move between one quote and the
   * next, and the racing budget is three seconds for the whole adapter.
   */
  async routeFrom(chainId: string): Promise<ResolvedRoute> {
    const existing = this.routes.get(chainId);
    if (existing !== undefined) return existing;

    const pending = this.resolveRoute(chainId);
    this.routes.set(chainId, pending);
    pending.then(
      (route) => this.settled.set(chainId, route),
      // A failed resolution is not cached: a chain that could not be reached
      // this minute is not a chain with no deployment, and remembering the
      // difference is what stops a transient node failure looking permanent.
      () => this.routes.delete(chainId),
    );
    return pending;
  }

  private async resolveRoute(chainId: string): Promise<ResolvedRoute> {
    const source = sourceFor(this.network, chainId);
    if (source === undefined) {
      throw new MavnaError(`This rail does not send from ${chainId}.`, { retryable: false });
    }

    const candidates = await this.candidatesFor(chainId);
    if (candidates.length === 0) {
      throw new MavnaError(noCandidatesExplanation(this.network, chainId), { retryable: false });
    }

    const stellar = await this.stellar();
    const reader = this.readerFor(chainId, source);
    const problems: string[] = [];
    let retryable = false;

    for (const candidate of candidates) {
      try {
        return await this.inspect(candidate, source, stellar, reader);
      } catch (cause) {
        // One candidate failing for want of a node is enough to say the answer
        // is not final, since the others may only have been refused on the way.
        if (cause instanceof MavnaError && cause.retryable) retryable = true;
        problems.push(
          `${candidate.symbol} at ${candidate.address}: ` +
            (cause instanceof Error ? cause.message : String(cause)),
        );
      }
    }

    throw new MavnaError(
      `No OFT on ${source.name} can reach Stellar right now. ${problems.join(" ")}`,
      { retryable },
    );
  }

  private async inspect(
    candidate: OftLocation,
    source: EvmSource,
    stellar: StellarDeployment,
    reader: EvmReader,
  ): Promise<ResolvedRoute> {
    const oft = candidate.address;

    // Read what the OFT says it is before reading anything through it. A wrong
    // address answers every call with a revert, and one clear message about an
    // address with no code beats six about missing functions.
    if (!(await reader.hasCode(oft))) {
      throw new MavnaError("there is no contract at that address", { retryable: false });
    }

    const peer = await this.read(reader, oft, OFT_ABI, "peers", [stellar.eid]);
    if (peer === undefined || isZeroBytes32(peer as string)) {
      throw new MavnaError(
        `it has no peer set for endpoint ${stellar.eid}, so it cannot send to Stellar`,
        { retryable: false },
      );
    }

    const [token, approvalRequired, sharedDecimals, endpoint, enforced] = await Promise.all([
      this.require(reader, oft, OFT_ABI, "token", []),
      this.require(reader, oft, OFT_ABI, "approvalRequired", []),
      this.require(reader, oft, OFT_ABI, "sharedDecimals", []),
      this.require(reader, oft, OFT_ABI, "endpoint", []),
      this.require(reader, oft, OFT_ABI, "enforcedOptions", [stellar.eid, MSG_TYPE_SEND]),
    ]);

    const endpointAddress = endpoint as `0x${string}`;
    const sourceEid = Number(await this.require(reader, endpointAddress, ENDPOINT_ABI, "eid", []));

    // The endpoint's own view of whether this pathway exists. An OFT can carry a
    // peer for a pathway the protocol beneath it does not carry.
    const supported = await this.require(reader, endpointAddress, ENDPOINT_ABI, "isSupportedEid", [
      stellar.eid,
    ]);
    if (supported !== true) {
      throw new MavnaError(
        `${source.name}'s LayerZero endpoint does not carry the Stellar pathway ` +
          `(endpoint ${stellar.eid}), whatever the token's peer says`,
        { retryable: false },
      );
    }

    const sendLibrary = (await this.require(
      reader,
      endpointAddress,
      ENDPOINT_ABI,
      "getSendLibrary",
      [oft, stellar.eid],
    )) as `0x${string}`;

    const [uln, appUln] = await Promise.all([
      this.require(reader, sendLibrary, SEND_ULN_ABI, "getUlnConfig", [oft, stellar.eid]),
      this.require(reader, sendLibrary, SEND_ULN_ABI, "getAppUlnConfig", [oft, stellar.eid]),
    ]);

    assertDvnStackIsSound({
      effective: uln as UlnConfig,
      app: appUln as UlnConfig,
      oft,
      eid: stellar.eid,
    });

    const [tokenSymbol, tokenDecimals, dvnNames] = await Promise.all([
      this.require(reader, token as `0x${string}`, ERC20_ABI, "symbol", []),
      this.require(reader, token as `0x${string}`, ERC20_ABI, "decimals", []),
      this.dvnNamesFor(source, uln as UlnConfig),
    ]);

    // The Stellar side, asked directly. This is the check the whole module is
    // built around: a peer pointing at an OFT registered on a superseded
    // endpoint looks completely healthy from the EVM side.
    const stellarOft = bytes32ToStellarContract(peer as string);
    const facts = await readStellarOft(this.rpc, stellarOft);
    if (facts.endpoint !== stellar.endpoint) {
      throw new MavnaError(
        `its Stellar peer ${stellarOft} is registered on endpoint ${facts.endpoint}, but ` +
          `LayerZero's registry says the current Stellar endpoint is ${stellar.endpoint}. ` +
          "Sending would deliver into a deployment that is no longer the advertised one",
        { retryable: false },
      );
    }

    const delivers = await readStellarToken(
      this.rpc,
      facts.token,
      this.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    );

    const local = Number(sharedDecimals) + facts.decimalsDiff;
    if (local !== 7) {
      throw new MavnaError(
        `its Stellar side reports ${local} local decimals, and Stellar assets have seven. ` +
          "The amount delivered would not be the amount quoted",
        { retryable: false },
      );
    }

    return {
      chainId: candidate.chainId,
      source,
      symbol: candidate.symbol,
      oft,
      token: token as string,
      tokenSymbol: tokenSymbol as string,
      tokenDecimals: Number(tokenDecimals),
      sharedDecimals: Number(sharedDecimals),
      approvalRequired: approvalRequired === true,
      endpoint: endpointAddress,
      sourceEid,
      stellarOft,
      stellar: facts,
      delivers,
      enforcedOptions: enforced as `0x${string}`,
      sendLibrary,
      uln: uln as UlnConfig,
      appUln: appUln as UlnConfig,
      dvnNames,
    };
  }

  /** Quote the pathway. Returns undefined when the contract refuses to price it. */
  async quoteNativeFee(
    route: ResolvedRoute,
    sendParam: unknown,
  ): Promise<{ readonly nativeFee: bigint; readonly lzTokenFee: bigint } | undefined> {
    const reader = this.readerFor(route.chainId, route.source);
    const result = await this.read(reader, route.oft, OFT_ABI, "quoteSend", [sendParam, false]);
    if (result === undefined) return undefined;
    const fee = result as { nativeFee: bigint; lzTokenFee: bigint };
    return { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee };
  }

  /** What the pathway says will actually arrive, in the source chain's units. */
  async quoteDelivered(route: ResolvedRoute, sendParam: unknown): Promise<bigint | undefined> {
    const reader = this.readerFor(route.chainId, route.source);
    const result = await this.read(reader, route.oft, OFT_ABI, "quoteOFT", [sendParam]);
    if (result === undefined) return undefined;
    const receipt = (result as readonly unknown[])[2] as { amountReceivedLD: bigint } | undefined;
    return receipt?.amountReceivedLD;
  }

  /**
   * What the OFT enforces for another message type on the Stellar pathway. A
   * compose send is SEND_AND_CALL, which the OApp configures separately.
   */
  async enforcedOptionsFor(route: ResolvedRoute, msgType: number): Promise<`0x${string}`> {
    const stellar = await this.stellar();
    const reader = this.readerFor(route.chainId, route.source);
    return (await this.require(reader, route.oft, OFT_ABI, "enforcedOptions", [
      stellar.eid,
      msgType,
    ])) as `0x${string}`;
  }

  /**
   * Where a source OFT sends Stellar-bound messages from and to, read off the
   * chain rather than taken from an indexer.
   *
   * Status uses this to decide whether a message it found is one of this
   * rail's, so it skips the gates `routeFrom` applies before sending. Those
   * gates are about whether a new transfer is safe; a transfer already sent
   * has to stay readable even if one of them fails today.
   */
  async pathwayOf(
    chainId: string,
    oft: string,
  ): Promise<{ readonly sourceEid: number; readonly peer: `0x${string}` }> {
    const source = sourceFor(this.network, chainId);
    if (source === undefined) {
      throw new MavnaError(`This rail does not send from ${chainId}.`, { retryable: false });
    }
    const reader = this.readerFor(chainId, source);
    const [peer, endpoint] = await Promise.all([
      this.require(reader, oft, OFT_ABI, "peers", [STELLAR_SIDE[this.network].eid]),
      this.require(reader, oft, OFT_ABI, "endpoint", []),
    ]);
    const sourceEid = Number(
      await this.require(reader, endpoint as `0x${string}`, ENDPOINT_ABI, "eid", []),
    );
    return { sourceEid, peer: (peer as string).toLowerCase() as `0x${string}` };
  }

  /**
   * A route already resolved, without going near the network.
   *
   * Status is read after a transfer has been built, so the route it was built
   * from has been resolved already. Returning undefined rather than resolving
   * again keeps `status` from turning into a dozen chain reads on a path a
   * caller may be polling.
   */
  cachedRoute(chainId: string): ResolvedRoute | undefined {
    return this.settled.get(chainId);
  }

  readerFor(chainId: string, source: EvmSource): EvmReader {
    const existing = this.readers.get(chainId);
    if (existing !== undefined) return existing;
    const reader = new EvmReader(source.rpc, source.evmChainId, this.evmOptions);
    this.readers.set(chainId, reader);
    return reader;
  }

  /**
   * One `eth_call`, encoded and decoded.
   *
   * Typed against viem's general `Abi` rather than each ABI's literal type. The
   * precise generics cannot survive a helper that takes the function name as a
   * value, and the alternative is repeating four lines at nineteen call sites.
   */
  private async read(
    reader: EvmReader,
    to: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await reader.call(to, data);
    if (result === undefined) return undefined;
    return decodeFunctionResult({ abi, functionName, data: result as `0x${string}` });
  }

  /** The same, where the contract not answering is a hard failure rather than data. */
  private async require(
    reader: EvmReader,
    to: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    const result = await this.read(reader, to, abi, functionName, args);
    if (result === undefined) {
      throw new MavnaError(`${to} would not answer ${functionName}`, { retryable: false });
    }
    return result;
  }
}

/**
 * What a Stellar OFT says about itself, read from its instance storage.
 *
 * Storage rather than a contract call on purpose: one ledger read answers every
 * question at once, needs no simulation and no fee, and cannot be affected by
 * whatever the contract would do if invoked.
 */
export async function readStellarOft(rpc: RpcClient, contract: string): Promise<StellarOftFacts> {
  const entry = await readInstance(rpc, `Stellar OFT ${contract}`, contract);

  if (entry === undefined) {
    throw new MavnaError(
      `the Stellar contract ${contract} it is peered to does not exist, or its storage has ` +
        "been archived",
      { retryable: false },
    );
  }

  const storage = entry.val.contractData().val().instance().storage() ?? [];
  const values = new Map<string, unknown>();
  for (const item of storage) {
    const name = scValToNative(item.key()) as unknown;
    if (Array.isArray(name) && typeof name[0] === "string") {
      values.set(name[0], scValToNative(item.val()) as unknown);
    }
  }

  const endpoint = values.get("Endpoint");
  const token = values.get("Token");
  const decimalsDiff = values.get("DecimalsDiff");
  const oftType = values.get("OftType");

  if (typeof endpoint !== "string" || typeof token !== "string") {
    throw new MavnaError(
      `the Stellar contract ${contract} it is peered to does not look like a LayerZero OFT`,
      { retryable: false },
    );
  }

  return {
    endpoint,
    token,
    decimalsDiff: Number(decimalsDiff ?? 0),
    kind: Array.isArray(oftType) && typeof oftType[0] === "string" ? oftType[0] : "unknown",
  };
}

async function readInstance(
  rpc: RpcClient,
  label: string,
  contract: string,
): Promise<{ readonly val: xdr.LedgerEntryData } | undefined> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contract).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  return rpc.read(label, async () => {
    const response = await rpc.server.getLedgerEntries(key);
    return { value: response.entries[0], ledger: response.latestLedger };
  });
}

/**
 * The classic asset a Stellar token stands for, read from the token itself.
 *
 * A Stellar asset contract keeps the asset it wraps in an `AssetInfo` slot, and
 * that is the only place the code and issuer can be learned without trusting a
 * document. The answer is then checked the other way round: an asset contract's
 * id is a hash of its asset, so a derived id that is not this contract means the
 * storage was misread, and a transfer labelled with a misread identity is
 * labelled as something it is not.
 *
 * Undefined for a token deployed from its own Wasm, or one wrapping native XLM.
 * Neither has a code and issuer, so neither can be named the way the rest of
 * this codebase names a Stellar asset.
 */
export async function readStellarToken(
  rpc: RpcClient,
  token: string,
  passphrase: string,
): Promise<StellarClassicAsset | undefined> {
  const entry = await readInstance(rpc, `Stellar token ${token}`, token);
  if (entry === undefined) {
    throw new MavnaError(
      `the Stellar token ${token} its OFT credits does not exist, or its storage has been archived`,
      { retryable: false },
    );
  }
  const instance = entry.val.contractData().val().instance();
  if (instance.executable().switch().name !== "contractExecutableStellarAsset") return undefined;

  let info: xdr.ScVal | undefined;
  for (const item of instance.storage() ?? []) {
    const key = item.key();
    if (key.switch().name !== "scvVec") continue;
    const head = key.vec()?.[0];
    if (head?.switch().name === "scvSymbol" && head.sym().toString() === "AssetInfo") {
      info = item.val();
    }
  }
  const parts = info?.switch().name === "scvVec" ? (info.vec() ?? []) : [];
  const head = parts[0];
  const variant = head?.switch().name === "scvSymbol" ? head.sym().toString() : undefined;
  if (variant !== "AlphaNum4" && variant !== "AlphaNum12") return undefined;

  const fields = new Map<string, xdr.ScVal>();
  for (const field of parts[1]?.map() ?? []) {
    if (field.key().switch().name === "scvSymbol") {
      fields.set(field.key().sym().toString(), field.val());
    }
  }
  const rawCode = fields.get("asset_code");
  const rawIssuer = fields.get("issuer");
  if (rawCode === undefined || rawIssuer?.switch().name !== "scvBytes") {
    throw new MavnaError(
      `the Stellar asset contract ${token} has no readable asset code and issuer`,
      { retryable: false },
    );
  }
  // stored at its fixed width, padded with NULs
  const code = String(scValToNative(rawCode)).replace(/\0+$/, "");
  const issuer = StrKey.encodeEd25519PublicKey(rawIssuer.bytes());

  let derived = "";
  try {
    derived = new StellarAsset(code, issuer).contractId(passphrase);
  } catch {
    // an unbuildable asset derives nothing, which the check below refuses
  }
  if (derived !== token) {
    throw new MavnaError(
      `the Stellar asset contract ${token} says it wraps ${code}:${issuer}, which does not ` +
        "derive its own address. Refusing to label a transfer with an identity that does not " +
        "check out",
      { retryable: false },
    );
  }
  return { code, issuer, id: `${code}:${issuer}` };
}

/**
 * Why a chain has nothing to offer, said in full rather than as "unsupported".
 *
 * Testnet gets its own sentence because the reason is specific and a user
 * deserves to know it is not their input that is wrong.
 */
function noCandidatesExplanation(network: NetworkId, chainId: string): string {
  // Written for whoever reads it on screen, which is a person deciding how to
  // move their money and not a developer reading an API reference. "OFT",
  // "registry" and the name of a configuration field all belong in the comment
  // above rather than in front of them. What they need is that it is not their
  // input that is wrong and that there is another route.
  if (network === "mainnet") {
    return `This route carries no token from ${chainId} to Stellar. Another route may.`;
  }
  return (
    "This route carries no token on the test network. It works on the main network, " +
    "where it is the only way to bring USDT to Stellar. Another route may work here."
  );
}
