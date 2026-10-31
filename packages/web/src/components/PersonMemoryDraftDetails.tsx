'use client';

import {
  type ApprovalHubItem,
  candidateInteractionDraftSchema,
  type PersonMemoryInformedEvidence,
  type PersonMemoryInteractionApprovalDetail,
  personMemoryInformedEvidenceSchema,
  personMemoryInteractionApprovalDetailSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ShellLanguage } from './shell/shell-language';

export { EventDraftDetails } from './PersonMemoryEventDetails';

export interface PersonMemoryDraftView {
  draftId: string;
  claimKind: 'reported_fact' | 'user_assessment' | 'relationship' | 'interaction_event';
  normalizedDraft: string;
  sourceRole: 'owner_explicit' | 'quoted_third_party';
  evidenceExcerpt: string;
  event?: PersonMemoryInteractionApprovalDetail;
  informedEvidence: PersonMemoryInformedEvidence[];
}

const informedEvidenceListSchema = z.array(personMemoryInformedEvidenceSchema).max(8);
const proposalDraftBaseSchema = z.object({
  draftId: z.string(),
  claimKind: z.enum(['reported_fact', 'user_assessment', 'relationship', 'interaction_event']),
  normalizedDraft: z.string(),
  sourceRole: z.enum(['owner_explicit', 'quoted_third_party']),
  evidenceExcerpt: z.string(),
  informedEvidence: informedEvidenceListSchema.optional().default([]),
  event: z.unknown().optional(),
});

function parseEvent(
  claimKind: PersonMemoryDraftView['claimKind'],
  value: unknown,
  informedEvidence: PersonMemoryInformedEvidence[],
): PersonMemoryInteractionApprovalDetail | undefined {
  if (claimKind !== 'interaction_event') return undefined;
  const parsedLegacyEvent = personMemoryInteractionApprovalDetailSchema.safeParse(value);
  if (parsedLegacyEvent.success) return parsedLegacyEvent.data;
  if (informedEvidence.length === 0 || typeof value !== 'object' || value === null) return undefined;
  const payload = { ...(value as Record<string, unknown>) };
  delete payload.sourceEvidence;
  const parsedPayload = candidateInteractionDraftSchema.shape.payload.safeParse(payload);
  return parsedPayload.success ? { ...parsedPayload.data, sourceEvidence: [] } : undefined;
}

function parseDraft(value: unknown, remaining: Set<string>): PersonMemoryDraftView | undefined {
  const parsed = proposalDraftBaseSchema.safeParse(value);
  if (!parsed.success || !remaining.has(parsed.data.draftId)) return undefined;
  const event = parseEvent(parsed.data.claimKind, parsed.data.event, parsed.data.informedEvidence);
  if (parsed.data.claimKind === 'interaction_event' && !event) return undefined;
  return {
    draftId: parsed.data.draftId,
    claimKind: parsed.data.claimKind,
    normalizedDraft: parsed.data.normalizedDraft,
    sourceRole: parsed.data.sourceRole,
    evidenceExcerpt: parsed.data.evidenceExcerpt,
    informedEvidence: parsed.data.informedEvidence,
    ...(event ? { event } : {}),
  };
}

export function readDrafts(item: ApprovalHubItem): PersonMemoryDraftView[] {
  if (!Array.isArray(item.detail.drafts)) return [];
  const remaining = new Set(
    Array.isArray(item.detail.remainingDraftIds)
      ? item.detail.remainingDraftIds.filter((value): value is string => typeof value === 'string')
      : [],
  );
  return item.detail.drafts.flatMap((value) => {
    const draft = parseDraft(value, remaining);
    return draft ? [draft] : [];
  });
}

export function kindLabel(
  kind: PersonMemoryDraftView['claimKind'],
  language: ShellLanguage = 'zh',
  ownerName = 'ME',
): string {
  if (language === 'en')
    return kind === 'reported_fact'
      ? 'Fact'
      : kind === 'user_assessment'
        ? 'Owner assessment'
        : kind === 'relationship'
          ? 'Relationship'
          : 'Interaction';
  if (kind === 'reported_fact') return '事实';
  if (kind === 'user_assessment') return `${ownerName} 判断`;
  if (kind === 'relationship') return '人物关系';
  return '互动事件';
}

export function sourceLabel(
  role: PersonMemoryDraftView['sourceRole'],
  language: ShellLanguage = 'zh',
  ownerName = 'ME',
): string {
  if (language === 'en') return role === 'owner_explicit' ? 'Owner statement' : 'Third party quoted by owner';
  return role === 'owner_explicit' ? `${ownerName} 明确陈述` : `${ownerName} 引述第三方`;
}
