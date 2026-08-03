'use client';

import type { ApprovalItem } from '@cat-cafe/shared';
import { ApprovalItemCard } from '@/components/ApprovalItemCard';
import { PersonMemoryProposalCardView } from '@/components/rich/PersonMemoryProposalCardView';

const BODY =
  '1. **互动事件**\n   人物：黄挺\n   发生了什么：与黄挺线下见面并讨论终端用户计算\n   时间：7 月 23 日（周三）（冲突：明确日期=2026-07-23 / 按星期推算=2026-07-22）\n   时长：大约两个小时\n   主题/重要性：交流终端用户计算方向，也让双方关系更具体\n   仍不确定：日期与星期存在冲突\n   证据 1（事件类型、发生了什么、时间、时长）[message_text · reported_fact]：“线下见了大约两个小时”\n   证据 2（主题/重要性、不确定项）[message_text · user_assessment]：“聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突”';

const FIELDS = [
  { label: '范围', value: '仅你的私人记忆' },
  { label: '写入', value: '在 Approval Hub 逐项勾选后自动完成' },
];

const APPROVAL_ITEM: ApprovalItem = {
  proposalId: 'person_candidate_preview',
  sourceFeatureId: 'F276',
  requesterCatId: 'codex-sol',
  ownerUserId: 'owner-preview',
  status: 'pending',
  summary: '记住人物：黄挺',
  detail: {
    displayName: '黄挺',
    replacesProposalId: 'person_candidate_preview_original',
    drafts: [
      {
        draftId: 'person_draft_fact_preview',
        claimKind: 'reported_fact',
        normalizedDraft: '黄挺属于终端用户计算开发部',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
      },
      {
        draftId: 'person_draft_event_preview',
        claimKind: 'interaction_event',
        normalizedDraft: '与黄挺线下见面约两小时，讨论终端用户计算；日期待确认',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '线下见了大约两个小时',
        event: {
          eventKind: 'meeting',
          headline: '与黄挺线下见面并讨论终端用户计算',
          occurredAt: {
            kind: 'conflict',
            raw: '7 月 23 日（周三）',
            alternatives: [
              { label: 'explicit_date', value: '2026-07-23' },
              { label: 'weekday_resolution', value: '2026-07-22' },
            ],
          },
          duration: { kind: 'approximate', raw: '大约两个小时', qualifier: 'about' },
          importanceOrTopic: '交流终端用户计算方向，也让双方关系更具体',
          uncertaintyNotes: ['日期与星期存在冲突'],
          sourceEvidence: [],
        },
        informedEvidence: [
          {
            sourceId: 'typed-event-fact',
            sourceKind: 'message_text',
            assertionRoles: ['reported_fact'],
            targetFields: ['eventKind', 'headline', 'occurredAt', 'duration'],
            boundedExcerpt: '线下见了大约两个小时',
            drillSourceRef: { kind: 'message', threadId: 'thread_preview', messageId: 'message_event_1' },
          },
          {
            sourceId: 'typed-event-assessment',
            sourceKind: 'message_text',
            assertionRoles: ['user_assessment'],
            targetFields: ['importanceOrTopic', 'uncertaintyNotes'],
            boundedExcerpt: '聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突',
            drillSourceRef: { kind: 'message', threadId: 'thread_preview', messageId: 'message_event_2' },
          },
        ],
      },
    ],
    remainingDraftIds: ['person_draft_fact_preview', 'person_draft_event_preview'],
    candidateState: 'pending_approval',
  },
  navigation: {
    state: 'anchored',
    originRef: { kind: 'message', threadId: 'thread_preview', messageId: 'message_preview' },
    approvalCardRef: { threadId: 'thread_preview', messageId: 'card_preview' },
  },
  inlineApprovable: true,
  decisionMode: 'claim-select',
  createdAt: Date.now(),
};

export default function F276PersonMemoryPreviewPage() {
  return (
    <main className="min-h-screen bg-[var(--cafe-bg)] p-8 text-[var(--cafe-text)]">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cafe-muted">F276 acceptance fixture</p>
          <h1 className="mt-2 text-2xl font-semibold">人物关系记忆：双投影单一审批事实</h1>
        </header>
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">Chat 主呈现 · 待审批</h2>
            <PersonMemoryProposalCardView
              title="要把 黄挺 记下来吗？"
              bodyMarkdown={BODY}
              fields={FIELDS}
              hydrated
              hydrationError={null}
              statusLabel={null}
              receiptSummary={null}
              canNavigate
              navigateLabel="去审批"
              onNavigate={() => {}}
              canUndo={false}
              undoing={false}
              onUndo={() => {}}
            />
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">Chat 回执 · 可精确撤销</h2>
            <PersonMemoryProposalCardView
              title="要把 黄挺 记下来吗？"
              bodyMarkdown={BODY}
              fields={FIELDS}
              hydrated
              hydrationError={null}
              statusLabel="已写入"
              receiptSummary="1 条事实 · 1 条关系 · 0 个事件"
              canNavigate={false}
              navigateLabel="去审批"
              onNavigate={() => {}}
              canUndo
              undoing={false}
              onUndo={() => {}}
            />
          </div>
        </section>
        <section className="max-w-xl space-y-3">
          <h2 className="text-sm font-semibold">Approval Hub · 逐项唯一决策面</h2>
          <ApprovalItemCard item={APPROVAL_ITEM} />
        </section>
      </div>
    </main>
  );
}
