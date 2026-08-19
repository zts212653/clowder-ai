'use client';

import {
  type ApprovalItem,
  candidateInteractionDraftSchema,
  type PersonMemoryInformedEvidence,
  type PersonMemoryInteractionApprovalDetail,
  personMemoryInformedEvidenceSchema,
  personMemoryInteractionApprovalDetailSchema,
  type TemporalValue,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { jumpToApprovalAnchor } from './ApprovalProvenanceLinks';

interface PersonMemoryDraftView {
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
  if (!parsed.success || (remaining.size > 0 && !remaining.has(parsed.data.draftId))) return undefined;
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

function readDrafts(item: ApprovalItem): PersonMemoryDraftView[] {
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

function kindLabel(kind: PersonMemoryDraftView['claimKind']): string {
  if (kind === 'reported_fact') return '事实';
  if (kind === 'user_assessment') return 'You 判断';
  if (kind === 'relationship') return '人物关系';
  return '互动事件';
}

function sourceLabel(role: PersonMemoryDraftView['sourceRole']): string {
  return role === 'owner_explicit' ? 'You 明确陈述' : 'You 引述第三方';
}

const evidenceFieldLabel: Record<
  PersonMemoryInteractionApprovalDetail['sourceEvidence'][number]['supports'][number],
  string
> = {
  eventKind: '事件类型',
  headline: '发生了什么',
  occurredAt: '时间',
  duration: '时长',
  importanceOrTopic: '主题/重要性',
  uncertaintyNotes: '不确定项',
};

function formatTemporalValue(value: TemporalValue | undefined): string {
  if (!value) return '未说明';
  if (value.kind === 'exact') return value.value;
  if (value.kind === 'approximate') return value.raw;
  return `${value.raw}（${value.alternatives
    .map((alternative) => `${formatTemporalAlternativeLabel(alternative.label)}=${alternative.value}`)
    .join(' / ')}）`;
}

function formatTemporalAlternativeLabel(label: string): string {
  if (label === 'explicit_date') return '明确日期';
  if (label === 'weekday_resolution') return '按星期推算';
  return label.replaceAll('_', ' ');
}

function EventDraftDetails({
  displayName,
  event,
  informedEvidence,
  sourceRole,
}: {
  displayName: string;
  event: PersonMemoryInteractionApprovalDetail;
  informedEvidence: PersonMemoryInformedEvidence[];
  sourceRole: PersonMemoryDraftView['sourceRole'];
}) {
  return (
    <span className="block space-y-2 rounded-md bg-[var(--cafe-muted)] p-2 text-xs">
      <span className="block text-micro font-medium opacity-65">互动事件 · {sourceLabel(sourceRole)}</span>
      <span className="block font-medium">人物：{displayName}</span>
      <span className="block text-sm font-medium">发生了什么：{event.headline}</span>
      <span className="block">时间：{formatTemporalValue(event.occurredAt)}</span>
      <span className="block">时长：{formatTemporalValue(event.duration)}</span>
      <span className="block">主题/重要性：{event.importanceOrTopic}</span>
      <span className="block">
        仍不确定：{event.uncertaintyNotes.length > 0 ? event.uncertaintyNotes.join('；') : '无'}
      </span>
      <span className="block space-y-1 border-t border-[var(--cafe-border)] pt-2">
        {informedEvidence.length > 0
          ? informedEvidence.map((source, index) => {
              const sourceRef = source.drillSourceRef;
              return (
                <span key={source.sourceId} className="block rounded border border-[var(--cafe-border)] p-1.5">
                  <span className="block opacity-65">
                    证据 {index + 1} · {source.targetFields.map((field) => evidenceFieldLabel[field]).join('、')}
                  </span>
                  <span className="block opacity-65">
                    {source.sourceKind} · {source.assertionRoles.join(' / ')}
                    {source.confirmationScope ? ` · ${source.confirmationScope}` : ''}
                  </span>
                  <span className="block">“{source.boundedExcerpt}”</span>
                  {sourceRef ? (
                    <button
                      type="button"
                      className="mt-1 rounded border border-[var(--cafe-border)] px-2 py-0.5 font-medium hover:bg-[var(--cafe-surface)]"
                      data-testid={`person-memory-informed-source-${index}`}
                      onClick={(clickEvent) => {
                        clickEvent.preventDefault();
                        clickEvent.stopPropagation();
                        jumpToApprovalAnchor(sourceRef.threadId, sourceRef.messageId);
                      }}
                    >
                      查看原文
                    </button>
                  ) : null}
                </span>
              );
            })
          : event.sourceEvidence.map((source, index) => (
              <span key={source.sourceRef.messageId} className="block rounded border border-[var(--cafe-border)] p-1.5">
                <span className="block opacity-65">
                  证据 {index + 1} · {source.supports.map((field) => evidenceFieldLabel[field]).join('、')}
                </span>
                <span className="block">“{source.evidenceExcerpt}”</span>
                <button
                  type="button"
                  className="mt-1 rounded border border-[var(--cafe-border)] px-2 py-0.5 font-medium hover:bg-[var(--cafe-surface)]"
                  data-testid={`person-memory-event-source-${index}`}
                  onClick={(clickEvent) => {
                    clickEvent.preventDefault();
                    clickEvent.stopPropagation();
                    jumpToApprovalAnchor(source.sourceRef.threadId, source.sourceRef.messageId);
                  }}
                >
                  查看原文
                </button>
              </span>
            ))}
      </span>
    </span>
  );
}

export function PersonMemoryClaimSelector({ item, onReject }: { item: ApprovalItem; onReject: () => void }) {
  const drafts = useMemo(() => readDrafts(item), [item]);
  const displayName = typeof item.detail.displayName === 'string' ? item.detail.displayName : '未命名人物';
  const replacesProposalId =
    typeof item.detail.replacesProposalId === 'string' ? item.detail.replacesProposalId : undefined;
  const draftIds = useMemo(() => drafts.map((draft) => draft.draftId), [drafts]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(() => new Set(draftIds));
  const approvePersonMemory = useApprovalHubStore((state) => state.approvePersonMemory);
  const notNowPersonMemory = useApprovalHubStore((state) => state.notNowPersonMemory);
  const withdrawPersonMemory = useApprovalHubStore((state) => state.withdrawPersonMemory);
  const deciding = useApprovalHubStore((state) => state.deciding[item.proposalId]);

  useEffect(() => {
    setSelectedDraftIds(new Set(draftIds));
  }, [draftIds]);

  const toggleDraft = (draftId: string) => {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      if (next.has(draftId)) next.delete(draftId);
      else next.add(draftId);
      return next;
    });
  };

  const approveSelected = () => {
    const selected = drafts.filter((draft) => selectedDraftIds.has(draft.draftId)).map((draft) => draft.draftId);
    if (selected.length > 0) void approvePersonMemory(item.proposalId, selected);
  };

  return (
    <div className="space-y-2" data-testid="person-memory-claim-selector">
      <p className="text-micro opacity-70">逐项确认后才会写入；未勾选内容不会进入记忆或未来召回。</p>
      {replacesProposalId ? (
        <p
          className="rounded-md border border-[var(--cafe-border)] p-2 text-micro"
          data-testid="person-memory-replacement"
        >
          这是纠正版；旧卡会被撤回，审批记录不会被原地改写。
        </p>
      ) : null}
      <div className="space-y-2">
        {drafts.map((draft) => (
          <div key={draft.draftId} className="flex items-start gap-2 rounded-md border border-[var(--cafe-border)] p-2">
            <input
              type="checkbox"
              aria-label={`选择${kindLabel(draft.claimKind)}：${draft.normalizedDraft}`}
              checked={selectedDraftIds.has(draft.draftId)}
              onChange={() => toggleDraft(draft.draftId)}
              disabled={Boolean(deciding)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-1">
              {draft.event ? (
                <EventDraftDetails
                  displayName={displayName}
                  event={draft.event}
                  informedEvidence={draft.informedEvidence}
                  sourceRole={draft.sourceRole}
                />
              ) : (
                <>
                  <span className="block text-sm">{draft.normalizedDraft}</span>
                  <span className="block text-micro opacity-65">
                    {kindLabel(draft.claimKind)} · {sourceLabel(draft.sourceRole)}
                  </span>
                  <span className="block text-micro opacity-80">原话：“{draft.evidenceExcerpt}”</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={approveSelected}
          disabled={Boolean(deciding) || selectedDraftIds.size === 0}
          className="px-3 py-1 text-micro font-medium rounded-md text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          style={{ backgroundColor: 'var(--semantic-success, #22c55e)' }}
          data-testid="person-memory-approve-selected"
        >
          {deciding === 'approving' ? '写入中…' : `写入已选 ${selectedDraftIds.size} 项`}
        </button>
        <button
          type="button"
          onClick={() => void notNowPersonMemory(item.proposalId)}
          disabled={Boolean(deciding)}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] disabled:opacity-50"
          data-testid="person-memory-not-now"
        >
          {deciding === 'deferring' ? '稍候…' : '稍后决定'}
        </button>
        <button
          type="button"
          onClick={() => void withdrawPersonMemory(item.proposalId)}
          disabled={Boolean(deciding)}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] disabled:opacity-50"
          data-testid="person-memory-withdraw"
        >
          {deciding === 'withdrawing' ? '取消中…' : '取消这张卡'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={Boolean(deciding)}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--semantic-error,#ef4444)] hover:text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="person-memory-reject"
        >
          {deciding === 'rejecting' ? '拒绝中…' : '拒绝'}
        </button>
      </div>
    </div>
  );
}
