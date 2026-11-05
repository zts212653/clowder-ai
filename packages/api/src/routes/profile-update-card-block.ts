/**
 * F231 Phase C: profile-update confirmation card.
 *
 * Like the F128 thread-proposal card, this is the ONLY user-facing approval entry point — it
 * surfaces the before/after primer diff + the whitelist signal source (KD-9) the operator is about to
 * approve. Actions target the profile-update decision routes (`profile-update:approve|reject`).
 */

import type { ProfileUpdateProposal, RichCardBlock } from '@cat-cafe/shared';
import { getCoCreatorDisplay } from '../config/co-creator-display.js';

function signalKindLabel(kind: ProfileUpdateProposal['signalProvenance']['kind']): string {
  const nickname = getCoCreatorDisplay().nickname;
  const labels: Record<ProfileUpdateProposal['signalProvenance']['kind'], string> = {
    'cvo-instructed': `cvo-instructed（${nickname}指示）`,
    'cat-declared': 'cat-declared（猫主动声明）',
    'magic-word': 'magic-word（Magic Word 触发）',
    'message-coordinate': 'message-coordinate（消息坐标锚定）',
    'sign-off': `sign-off（${nickname}签字/驳回）`,
    reaction: `reaction（${nickname}反馈/表情）`,
  };
  return labels[kind];
}

export function buildProfileUpdateCardBlock(proposal: ProfileUpdateProposal): RichCardBlock {
  return {
    id: `profile-update-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title:
      proposal.targetLayer === 'capsule'
        ? '提议更新开场简介'
        : proposal.targetLayer === 'corpus'
          ? '提议更新共享事实档案（corpus）'
          : `提议更新 ${proposal.sourceCatId} 的关系档案（primer）`,
    bodyMarkdown: renderDiff(proposal),
    tone: 'info',
    fields: [
      { label: '目标', value: proposal.targetPath },
      { label: '来源', value: signalKindLabel(proposal.signalProvenance.kind) },
    ],
    actions: [
      { label: '批准并写入', action: 'profile-update:approve', payload: { proposalId: proposal.proposalId } },
      { label: '驳回', action: 'profile-update:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}

function renderDiff(proposal: ProfileUpdateProposal): string {
  const beforeContent = proposal.beforeContent || '（空 — 首次写入）';
  const fence = markdownFenceFor(beforeContent, proposal.afterContent);
  return [
    proposal.rationale,
    '',
    '**当前内容：**',
    fence,
    beforeContent,
    fence,
    '',
    '**提议改为：**',
    fence,
    proposal.afterContent,
    fence,
  ].join('\n');
}

function markdownFenceFor(...contents: string[]): string {
  const longestFence = contents.reduce((max, content) => {
    const runs = content.match(/`+/g) ?? [];
    return Math.max(max, ...runs.map((run) => run.length));
  }, 0);
  return '`'.repeat(Math.max(3, longestFence + 1));
}
