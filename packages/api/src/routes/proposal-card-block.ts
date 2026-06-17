/**
 * F128 proposal card rendering.
 *
 * The proposal card is the ONLY user-facing approval entry point (no pending dashboard
 * fallback), so it must surface the create-time contract the user is about to approve:
 * reporting mode (editable before approve creates the thread) and project ownership.
 * Extracted from callback-propose-thread-routes.ts to keep that route within the F128 AC-X1
 * 350-line cap.
 */

import type { ReportingMode, RichCardBlock, ThreadProposal } from '@cat-cafe/shared';

// F128: user-facing label for each reporting mode. Phase AA makes `final-only`
// the default; Phase AC lets the approver override this before creation.
const REPORTING_MODE_LABEL: Record<ReportingMode, string> = {
  none: 'autonomous（下游自治，无强制回报）',
  'final-only': 'final-only（默认 · 完成时回报一次）',
  'state-transitions': 'state-transitions（每阶段边界回报）',
  'blocking-ack': 'blocking-ack（遇阻塞点等 ack）',
};

export function buildProposalCardBlock(proposal: ThreadProposal): RichCardBlock {
  const fields: Array<{ label: string; value: string }> = [
    { label: '父 Thread', value: proposal.parentThreadId },
    {
      label: '建议成员',
      value: proposal.preferredCats.length > 0 ? proposal.preferredCats.join(', ') : '（未指定）',
    },
    { label: '回报模式', value: REPORTING_MODE_LABEL[proposal.reportingMode ?? 'final-only'] },
    {
      // F128: surface project ownership so the user sees which repo the child thread lands in
      // before approving. `default` is shown explicitly (NOT hidden) — 砚砚 review: a silent
      // missing-ownership is exactly the bug that sent cats into the runtime sanctuary cwd.
      label: '项目归属',
      value:
        proposal.projectPath && proposal.projectPath !== 'default'
          ? proposal.projectPath
          : '未指定（default · 子 thread 无项目归属，cat 会回落运行时默认目录）',
    },
  ];
  if (proposal.initialMessage) fields.push({ label: '首条消息', value: proposal.initialMessage });
  return {
    id: `proposal-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: `提议新建 thread：${proposal.title}`,
    bodyMarkdown: proposal.reason,
    tone: 'info',
    fields,
    actions: [
      { label: '批准并创建', action: 'propose:approve', payload: { proposalId: proposal.proposalId } },
      { label: '驳回', action: 'propose:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}
