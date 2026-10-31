import {
  type EntityMemoryProposalView,
  memoryOwnerRevisionSchema,
  PERSON_MEMORY_CANDIDATE_STATES,
  type PersonMemoryProposalView,
  type ProfileMemoryProposalView,
} from '@cat-cafe/shared';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string';
const nonempty = (value: unknown) => text(value) && String(value).trim().length > 0;
const strings = (value: unknown) => Array.isArray(value) && value.every(text);
function hasProposalLocator(value: Record<string, unknown>, endpoint: string) {
  const ref = value.approvalCardRef;
  return (
    ['proposalId', 'sourceCatId', 'sourceThreadId'].every((key) => nonempty(value[key])) &&
    value.decisionEndpointBase === endpoint &&
    ['staged', 'anchored', 'tombstoned', 'legacy_unanchored'].includes(String(value.approvalState)) &&
    (ref === undefined || (record(ref) && nonempty(ref.threadId) && nonempty(ref.messageId))) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0 &&
    (value.rejectionReason === undefined || text(value.rejectionReason))
  );
}
export function isProfileProposal(value: unknown): value is ProfileMemoryProposalView {
  return (
    record(value) &&
    hasProposalLocator(value, '/api/profile-updates') &&
    ['pending', 'approving', 'approved', 'rejected'].includes(String(value.status)) &&
    memoryOwnerRevisionSchema.safeParse(value.expectedRevision).success &&
    text(value.suggestedContent) &&
    text(value.rationale)
  );
}
export function isEntityProposal(value: unknown): value is EntityMemoryProposalView {
  if (
    !record(value) ||
    !hasProposalLocator(value, '/api/entity-proposals') ||
    !['pending', 'approved', 'rejected'].includes(String(value.status)) ||
    !text(value.rationale) ||
    !record(value.suggestedPatch)
  )
    return false;
  const patch = value.suggestedPatch;
  return (
    ['person', 'cat', 'feature', 'concept', 'external'].includes(String(patch.entityType)) &&
    ['canonicalName', 'stance', 'visibilityScope'].every((key) => text(patch[key])) &&
    strings(patch.aliases)
  );
}
export function isPersonProposal(value: unknown): value is PersonMemoryProposalView {
  return (
    record(value) &&
    hasProposalLocator(value, '/api/person-memory-proposals') &&
    value.approvalState === 'anchored' &&
    PERSON_MEMORY_CANDIDATE_STATES.some((state) => state === value.status) &&
    text(value.displayName) &&
    strings(value.remainingDraftIds) &&
    (value.replacesProposalId === undefined || nonempty(value.replacesProposalId))
  );
}

/** A missing projection preserves old canonical reads; malformed projections fail the read. */
export function hasValidOriginalProposals(value: Record<string, unknown>, validate: (item: unknown) => boolean) {
  return value.proposals === undefined || (Array.isArray(value.proposals) && value.proposals.every(validate));
}
