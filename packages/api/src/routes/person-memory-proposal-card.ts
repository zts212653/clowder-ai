import {
  type CandidateInteractionDraft,
  type PersonMemoryInformedEvidence,
  type RichPersonMemoryProposalCardBlock,
  type TemporalValue,
} from '@cat-cafe/shared';
import { projectCandidateInteractionInformedEvidence } from '../domains/memory/people/PersonMemoryInformedEvidence.js';
import type { StoredPersonMemoryCandidate } from '../domains/memory/people/PersonMemoryStore.js';

const SOURCE_ROLE_LABEL = {
  owner_explicit: 'You 明确陈述',
  quoted_third_party: '第三方引述',
} as const;

function draftKindLabel(
  draft:
    | StoredPersonMemoryCandidate['claimDrafts'][number]
    | NonNullable<StoredPersonMemoryCandidate['relationshipDraft']>
    | NonNullable<StoredPersonMemoryCandidate['interactionDraft']>,
): string {
  if ('eventKind' in draft.payload) return '互动事件';
  if ('status' in draft.payload) return '人物关系';
  return draft.payload.kind === 'reported_fact' ? '事实' : 'You 判断';
}

function isInteractionDraft(
  draft:
    | StoredPersonMemoryCandidate['claimDrafts'][number]
    | NonNullable<StoredPersonMemoryCandidate['relationshipDraft']>
    | NonNullable<StoredPersonMemoryCandidate['interactionDraft']>,
): draft is NonNullable<StoredPersonMemoryCandidate['interactionDraft']> {
  return 'sourceEvidence' in draft && 'eventKind' in draft.payload;
}

const EVIDENCE_FIELD_LABEL: Record<CandidateInteractionDraft['sourceEvidence'][number]['supports'][number], string> = {
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
  return `${value.raw}（冲突：${value.alternatives
    .map((alternative) => `${formatTemporalAlternativeLabel(alternative.label)}=${alternative.value}`)
    .join(' / ')}）`;
}

function formatTemporalAlternativeLabel(label: string): string {
  if (label === 'explicit_date') return '明确日期';
  if (label === 'weekday_resolution') return '按星期推算';
  return label.replaceAll('_', ' ');
}

function renderInformedEvidence(evidence: PersonMemoryInformedEvidence[]): string {
  return evidence
    .map((source, index) => {
      const scope = source.confirmationScope ? ` · ${source.confirmationScope}` : '';
      return `   证据 ${index + 1}（${source.targetFields.map((field) => EVIDENCE_FIELD_LABEL[field]).join('、')}）[${source.sourceKind} · ${source.assertionRoles.join(' / ')}${scope}]：“${source.boundedExcerpt}”`;
    })
    .join('\n');
}

function renderInteractionDraft(
  draft: CandidateInteractionDraft,
  index: number,
  displayName: string,
  informedEvidence: PersonMemoryInformedEvidence[],
): string {
  const payload = draft.payload;
  const evidence =
    informedEvidence.length > 0
      ? renderInformedEvidence(informedEvidence)
      : draft.sourceEvidence
          .map(
            (source, sourceIndex) =>
              `   证据 ${sourceIndex + 1}（${source.supports.map((field) => EVIDENCE_FIELD_LABEL[field]).join('、')}）：“${source.evidenceExcerpt}”`,
          )
          .join('\n');
  return [
    `${index + 1}. **互动事件**`,
    `   人物：${displayName}`,
    `   发生了什么：${payload.headline}`,
    `   时间：${formatTemporalValue(payload.occurredAt)}`,
    `   时长：${formatTemporalValue(payload.duration)}`,
    `   主题/重要性：${payload.importanceOrTopic}`,
    `   仍不确定：${payload.uncertaintyNotes.length > 0 ? payload.uncertaintyNotes.join('；') : '无'}`,
    evidence,
  ].join('\n');
}

function typedEvidenceSummary(candidate: StoredPersonMemoryCandidate, draftId: string): string {
  const bundle = candidate.sourceBundle;
  if (!bundle) return '';
  const sources = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  const summaries = bundle.assertionBindings
    .filter((binding) => binding.target.draftId === draftId)
    .map((binding) => {
      const source = sources.get(binding.sourceId);
      if (!source) return '';
      const scope = source.kind === 'owner_confirmed_transcript' ? ` · ${source.confirmationScope}` : '';
      return `${source.kind} · ${binding.role}${scope}`;
    })
    .filter((summary, index, all) => summary.length > 0 && all.indexOf(summary) === index);
  return summaries.length > 0 ? `\n   证据契约：${summaries.join('；')}` : '';
}

export function buildPersonMemoryProposalCard(
  candidate: StoredPersonMemoryCandidate,
): RichPersonMemoryProposalCardBlock {
  if (!candidate.personDraft) throw new Error('F276 proposal card requires a non-terminal person draft');
  const drafts = [
    ...candidate.claimDrafts,
    ...(candidate.relationshipDraft ? [candidate.relationshipDraft] : []),
    ...(candidate.interactionDraft ? [candidate.interactionDraft] : []),
  ].filter((draft) => candidate.remainingDraftIds.includes(draft.draftId));
  const bodyMarkdown = drafts
    .map((draft, index) => {
      if (isInteractionDraft(draft)) {
        return renderInteractionDraft(
          draft,
          index,
          candidate.personDraft?.displayName ?? '未命名人物',
          projectCandidateInteractionInformedEvidence(candidate, draft.draftId),
        );
      }
      return `${index + 1}. **${draft.normalizedDraft}**\n   类型：${draftKindLabel(draft)} · 来源：${SOURCE_ROLE_LABEL[draft.sourceRole]}\n   原话：“${draft.evidenceExcerpt}”${typedEvidenceSummary(candidate, draft.draftId)}`;
    })
    .join('\n\n');
  const card: RichPersonMemoryProposalCardBlock = {
    id: `person-memory-${candidate.candidateId}`,
    kind: 'card',
    v: 1,
    title: `要把 ${candidate.personDraft.displayName} 记下来吗？`,
    bodyMarkdown,
    tone: 'info',
    fields: [
      { label: '范围', value: '仅你的私人记忆' },
      { label: '写入', value: '在 Approval Hub 逐项勾选后自动完成' },
      ...(candidate.replacesProposalId ? [{ label: '纠错', value: '新卡审批前会撤回旧卡，并保留替换关联' }] : []),
    ],
    actions: [
      {
        label: '去审批',
        action: 'person-memory:open-approval-hub',
        payload: { candidateId: candidate.candidateId },
      },
    ],
    meta: {
      kind: 'person_memory_proposal',
      candidateId: candidate.candidateId,
      subjectDisplayName: candidate.personDraft.displayName,
      envelopeRef: `approval:F276:${candidate.candidateId}`,
      decisionSurface: 'approval_hub',
      status: candidate.state === 'staged' ? 'pending_approval' : candidate.state,
    },
  };
  return card;
}

export function personMemoryProposalCardText(card: RichPersonMemoryProposalCardBlock): string {
  return [
    card.title,
    card.bodyMarkdown ?? '',
    ...(card.fields ?? []).flatMap((field) => [field.label, field.value]),
  ].join('\n');
}
