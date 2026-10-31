import type { ProposalApproveOverrides, ThreadProposal } from '@cat-cafe/shared';

export function finalizedProposalFields(updated: ThreadProposal): string[] {
  const fields: string[] = [
    'status',
    'approved',
    'approvedAt',
    String(updated.approvedAt ?? 0),
    'claimedAt',
    '0',
    'title',
    updated.title,
    'parentThreadId',
    updated.parentThreadId,
    'preferredCats',
    JSON.stringify(updated.preferredCats),
    // F128: persist project ownership on finalize so an approve-time re-home (overrides
    // .projectPath, applied by applyOverrides) is durable. Without this HSET the hash keeps
    // the create-time projectPath and a fresh get() hydrates a stale value — a Redis-only
    // divergence the in-memory store can't surface (LL: in-memory masks Redis behavior).
    'projectPath',
    updated.projectPath,
    'reportingMode',
    updated.reportingMode ?? '',
    'declaredWorkMode',
    updated.declaredWorkMode ?? '',
  ];
  if (updated.createdThreadId) fields.push('createdThreadId', updated.createdThreadId);
  if (updated.attentionGroupId !== undefined) fields.push('attentionGroupId', updated.attentionGroupId ?? '');
  fields.push('initialMessage', updated.initialMessage ?? '');
  if (updated.approvedTaskContract) fields.push('approvedTaskContract', JSON.stringify(updated.approvedTaskContract));
  return fields;
}

export function createdThreadCheckpointFields(
  threadId: string,
  overrides: ProposalApproveOverrides | undefined,
): string[] {
  const fields = ['createdThreadId', threadId];
  if (!overrides) return fields;
  if (overrides.attentionGroupId !== undefined) fields.push('attentionGroupId', overrides.attentionGroupId ?? '');
  if (overrides.title !== undefined) fields.push('title', overrides.title);
  if (overrides.parentThreadId !== undefined) fields.push('parentThreadId', overrides.parentThreadId);
  if (overrides.preferredCats !== undefined) fields.push('preferredCats', JSON.stringify(overrides.preferredCats));
  if (overrides.projectPath !== undefined) fields.push('projectPath', overrides.projectPath);
  if (overrides.reportingMode !== undefined) fields.push('reportingMode', overrides.reportingMode);
  if (overrides.declaredWorkMode !== undefined) fields.push('declaredWorkMode', overrides.declaredWorkMode);
  if (overrides.initialMessage === null) fields.push('initialMessage', '');
  else if (typeof overrides.initialMessage === 'string') fields.push('initialMessage', overrides.initialMessage);
  return fields;
}
