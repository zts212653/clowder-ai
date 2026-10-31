import type { ThreadProposal } from '@cat-cafe/shared';
import { z } from 'zod';

const revisionSchema = z
  .object({
    messageId: z.string().min(1),
    instruction: z.string().min(1),
    requestedBy: z.string().min(1),
    requestedAt: z.number().finite(),
    queuedAt: z.number().finite().optional(),
    choices: z
      .object({
        suggestedGroupId: z
          .string()
          .regex(/^attention_[A-Za-z0-9_-]+$/)
          .nullable()
          .optional(),
        projectPath: z.string().min(1).optional(),
        pinned: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function serializeProposalRevision(proposal: ThreadProposal): string[] {
  const fields: string[] = [];
  for (const key of [
    'suggestedGroupId',
    'groupSuggestionReason',
    'supersedesProposalId',
    'supersededByProposalId',
  ] as const)
    if (proposal[key]) fields.push(key, proposal[key]);
  if (proposal.attentionGroupId !== undefined) fields.push('attentionGroupId', proposal.attentionGroupId ?? '');
  if (proposal.revisionRequest) fields.push('revisionRequest', JSON.stringify(proposal.revisionRequest));
  if (proposal.suggestedPinned !== undefined) fields.push('suggestedPinned', String(proposal.suggestedPinned));
  return fields;
}

export function hydrateProposalRevision(proposal: ThreadProposal, data: Record<string, string>): void {
  if (data.suggestedPinned === 'true' || data.suggestedPinned === 'false')
    proposal.suggestedPinned = data.suggestedPinned === 'true';
  for (const key of ['suggestedGroupId', 'supersedesProposalId', 'supersededByProposalId'] as const)
    if (data[key]) proposal[key] = data[key];
  if (['source-thread', 'feature-title', 'explicit', 'none'].includes(data.groupSuggestionReason ?? ''))
    proposal.groupSuggestionReason = data.groupSuggestionReason as ThreadProposal['groupSuggestionReason'];
  if (data.attentionGroupId !== undefined) proposal.attentionGroupId = data.attentionGroupId || null;
  if (!data.revisionRequest) return;
  try {
    const request = revisionSchema.safeParse(JSON.parse(data.revisionRequest));
    if (request.success) proposal.revisionRequest = request.data;
  } catch {
    /* corrupt revision data never authorizes a replacement */
  }
}
