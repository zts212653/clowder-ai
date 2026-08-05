/**
 * Compatibility barrel for the canonical F246 proposal port and test store.
 * Implementations import DispatchProposalStorePort directly so this barrel can
 * retain its historical test export without creating a port↔implementation cycle.
 */

export { InMemoryDispatchProposalStore } from '../InMemoryDispatchProposalStore.js';

export {
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  computeLegacyNegativeAuthorizationKey,
  computeLineageKey,
  computeNegativeAuthorizationKey,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  isNegativeAuthorizationProposalStatus,
  type NegativeAuthorizationProposalStatus,
} from './DispatchProposalStoreContracts.js';
export type { IDispatchProposalStore } from './DispatchProposalStorePort.js';
