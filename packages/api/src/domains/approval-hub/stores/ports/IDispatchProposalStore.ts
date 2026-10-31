/**
 * Compatibility barrel for the canonical F246 proposal port and test store.
 * Implementations import DispatchProposalStorePort directly so this barrel can
 * retain its historical test export without creating a port↔implementation cycle.
 */

export { InMemoryDispatchProposalStore } from '../InMemoryDispatchProposalStore.js';

export {
  type CanonicalAdmissionProposalStatus,
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  canonicalizeDispatchAdmissionSubjectRef,
  computeDispatchCanonicalActionKey,
  computeLegacyNegativeAuthorizationKey,
  computeLineageKey,
  computeNegativeAuthorizationKey,
  type DispatchCanonicalAdmissionBlock,
  type DispatchCanonicalAdmissionLookup,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  isCanonicalAdmissionProposalStatus,
  isNegativeAuthorizationProposalStatus,
  type NegativeAuthorizationProposalStatus,
  tryCanonicalizeDispatchAdmissionSubjectRef,
  tryComputeDispatchCanonicalActionKey,
} from './DispatchProposalStoreContracts.js';
export type { IDispatchProposalStore } from './DispatchProposalStorePort.js';
