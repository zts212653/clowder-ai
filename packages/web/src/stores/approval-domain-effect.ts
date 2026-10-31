import type { ApprovalHubItem } from '@cat-cafe/shared';
import type { DecisionAttempt } from './approval-decision-attempts';

/** The original writer's response witness; a host still needs a subsequent canonical terminal read. */
export type DomainApprovalEffect = 'dispatch-delivered' | 'taste-written' | 'entity-written';
export function domainAttemptEffect(
  attempt: DecisionAttempt | undefined,
  owner: string,
  feature: string,
  card: { threadId: string; messageId: string },
): DomainApprovalEffect | undefined {
  return attempt?.sourceFeatureId === feature &&
    attempt.ownerUserId === owner &&
    attempt.approvalCardRef?.threadId === card.threadId &&
    attempt.approvalCardRef.messageId === card.messageId &&
    attempt.state.phase === 'response_received' &&
    attempt.state.ok
    ? attempt.state.domainEffect
    : undefined;
}
export function readDomainWriteEffect(
  item: ApprovalHubItem | undefined,
  body: unknown,
  resolving = false,
): DomainApprovalEffect | undefined {
  if (!item || !body || typeof body !== 'object' || Array.isArray(body)) return;
  const value = body as Record<string, unknown>;
  if (item.sourceFeatureId === 'F193') {
    const proposal = value.proposal;
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return;
    const record = proposal as Record<string, unknown>;
    return record.proposalId === item.proposalId &&
      record.ownerUserId === item.ownerUserId &&
      record.status === 'approved' &&
      record.targetThreadId === item.detail.targetThreadId &&
      typeof record.deliveredMessageId === 'string' &&
      record.deliveredMessageId.trim()
      ? 'dispatch-delivered'
      : undefined;
  }
  if (value.proposalId !== item.proposalId || value.status !== 'approved') return;
  if (item.sourceFeatureId === 'F221')
    return typeof value.vignettePath === 'string' && value.vignettePath.trim() ? 'taste-written' : undefined;
  if (item.sourceFeatureId === 'F260')
    return typeof value.entityId === 'string' &&
      value.entityId.trim() &&
      (resolving || value.entityId === item.detail.entityId)
      ? 'entity-written'
      : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Called only after the history row has passed its owner/proposal/publication fence. */
export function canonicalDomainEffect(value: unknown): DomainApprovalEffect | undefined {
  const row = asRecord(value);
  if (row?.resolution !== 'accepted') return;
  const materialization = asRecord(row.materialization),
    detail = asRecord(row.detail);
  const proof = materialization?.effectProofRef;
  if (
    materialization?.state !== 'succeeded' ||
    typeof proof !== 'string' ||
    !proof.trim() ||
    proof !== detail?.canonicalEffectProofRef
  )
    return;
  if (row.sourceFeatureId === 'F193') return 'dispatch-delivered';
  if (row.sourceFeatureId === 'F260') return 'entity-written';
  if (row.sourceFeatureId === 'F221' && proof.startsWith(`taste-proposal:${row.proposalId}:vignette:`))
    return 'taste-written';
  return undefined;
}
