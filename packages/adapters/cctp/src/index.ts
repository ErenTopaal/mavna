export type { Attestation, AttestationStatus } from "./attestation.js";
export { AttestationService, HASH_FORMAT } from "./attestation.js";
export type { CctpDomain, CctpNetworkConfig } from "./config.js";
export {
  CCTP_CONTRACTS,
  CCTP_DOMAINS,
  IRIS_BASE_URL,
  STELLAR_DOMAIN,
  stellarDomainFor,
} from "./config.js";
export type { DeliveryInputs } from "./delivery.js";
export {
  buildDelivery,
  canonicalToLocal,
  localToCanonical,
  MAX_FEE_IS_IN_LOCAL_DECIMALS,
} from "./delivery.js";
export type { ForwardRecipientKind } from "./hook.js";
export {
  buildForwarderHookData,
  classifyForwardRecipient,
  contractAddressToBytes32,
  fromHex,
  HOOK_LAYOUT,
  MAGIC_IS_ZEROED_BECAUSE_CIRCLE_DOES_NOT_FORWARD_TO_STELLAR,
  parseForwarderHookData,
  toHex,
} from "./hook.js";
