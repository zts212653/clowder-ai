import {
  type ApprovalEnvelope,
  type ApprovalHubItem,
  developmentScopeV1Schema,
  type ThreadProposal,
  validateApprovalEnvelope,
} from '@cat-cafe/shared';
import { useApprovalStatus } from '@/components/rich/use-approval-status';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicationMatches(publication: unknown, item: ApprovalHubItem): boolean {
  if (publication === undefined) return true; // the original producer explicitly allows pre-publication records
  if (!isRecord(publication)) return false;
  if (publication.state === 'legacy_unanchored') return true;
  if (publication.state !== 'anchored' || !isRecord(publication.envelope)) return false;
  const envelope = publication.envelope;
  try {
    validateApprovalEnvelope(envelope as unknown as ApprovalEnvelope);
  } catch {
    return false;
  }
  return (
    envelope.canonicalProposalId === item.proposalId &&
    envelope.ownerUserId === item.ownerUserId &&
    envelope.requesterCatId === item.requesterCatId &&
    envelope.sourceFeatureId === 'F128' &&
    envelope.createdAt === item.createdAt
  );
}

export function readableProposedFields(value: Record<string, unknown>): boolean {
  return typeof value.sourceThreadId === 'string' && !!value.sourceThreadId.trim() && readableProposedDetails(value);
}

/** Display fields alone confer no producer identity or write authority. */
export function readableProposedDetails(value: Record<string, unknown>): boolean {
  const required = ['reason', 'projectPath', 'parentThreadId', 'title'];
  if (required.some((field) => typeof value[field] !== 'string' || !(value[field] as string).trim())) return false;
  if (
    value.reportingMode !== undefined &&
    (typeof value.reportingMode !== 'string' ||
      !['none', 'final-only', 'state-transitions', 'blocking-ack'].includes(value.reportingMode))
  )
    return false;
  if (
    value.declaredWorkMode !== undefined &&
    (typeof value.declaredWorkMode !== 'string' ||
      !['subtask', 'parallel', 'investigation', 'standalone'].includes(value.declaredWorkMode))
  )
    return false;
  if (
    ['subjectTaskId', 'subjectTaskTitle'].some(
      (field) => value[field] !== undefined && typeof value[field] !== 'string',
    )
  )
    return false;
  if (
    value.approvedDevelopmentScope !== undefined &&
    !developmentScopeV1Schema.safeParse(value.approvedDevelopmentScope).success
  )
    return false;
  if (!Array.isArray(value.preferredCats) || value.preferredCats.some((cat) => typeof cat !== 'string' || !cat.trim()))
    return false;
  if (value.initialMessage !== undefined && typeof value.initialMessage !== 'string') return false;
  return true;
}

/** F128's original producer read, not a capability inferred from a card or a successful request. */
export function matchingThreadProposal(value: unknown, item: ApprovalHubItem): ThreadProposal | null {
  if (!isRecord(value) || value.status !== 'pending') return null;
  if (
    value.proposalId !== item.proposalId ||
    value.createdBy !== item.ownerUserId ||
    value.createdAt !== item.createdAt ||
    value.sourceCatId !== item.requesterCatId
  )
    return null;
  if (!readableProposedFields(value)) return null;
  const fields = ['title', 'reason', 'parentThreadId', 'projectPath', 'initialMessage', 'reportingMode'] as const;
  if (fields.some((field) => value[field] !== item.detail[field])) return null;
  if (JSON.stringify(value.preferredCats) !== JSON.stringify(item.detail.preferredCats)) return null;
  if (!publicationMatches(value.publication, item)) return null;
  return value as unknown as ThreadProposal;
}

export function useThreadProposalRead(item: ApprovalHubItem) {
  const result = useApprovalStatus(
    'F128',
    item.proposalId,
    `/api/proposals/${encodeURIComponent(item.proposalId)}`,
    true,
    item.ownerUserId,
  );
  return {
    proposal: result.failed || result.terminal ? null : matchingThreadProposal(result.record, item),
    checking: result.reading,
    reread: result.refresh,
  };
}
