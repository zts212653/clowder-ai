'use client';

import type { SettledApprovalHubItem } from '@cat-cafe/shared';
import { SettledHistoryCard } from '@/components/SettledHistoryCard';

const BASE_TIME = Date.UTC(2026, 7, 31, 3, 30);

const HISTORY_ITEMS: SettledApprovalHubItem[] = [
  {
    proposalId: 'f313-preview-eval-repair',
    sourceFeatureId: 'F266',
    requesterCatId: 'codex-sol',
    ownerUserId: 'preview-owner',
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    summary: 'Eval repair · Approval renderer vocabulary drift',
    detail: {
      expectedChange: '让所有 producer 只投影 canonical Approval lifecycle，不把 legacy 状态交给 renderer。',
      ownerAuthorizationRef: 'authorization:F246:F266:v1',
      targetVersionRef: 'target:F246:approval-renderer@exact-head',
    },
    navigation: {
      state: 'anchored',
      originRef: {
        kind: 'message',
        threadId: 'thread-preview-f313',
        messageId: 'message-preview-f313-origin',
      },
      approvalCardRef: {
        threadId: 'thread-preview-f313',
        messageId: 'message-preview-f313-card',
      },
    },
    createdAt: BASE_TIME - 90 * 60_000,
    decidedAt: BASE_TIME - 8 * 60_000,
    decidedBy: 'operator',
  },
  {
    proposalId: 'f246-preview-taste',
    sourceFeatureId: 'F221',
    requesterCatId: 'codex-sol',
    ownerUserId: 'preview-owner',
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    summary: 'Taste [architecture-aesthetics]: 窄法级路由指针必须常驻，具体内容按场景动态进入',
    detail: {
      scene: '讨论记忆系统与 Standing Reflex 如何唤醒 proposal/cue',
      quote: '不能把全部规则塞进每轮 query，否则会变成又臭又长的垃圾。',
      dimension: 'architecture-aesthetics',
      tags: ['prompt-budget', 'standing-reflex', '动态机会'],
      technicalNotes:
        '只常驻短小的窄法级路由指针；具体内容由场景 predicate 动态注入。完整技术依据在历史中保留，但默认折叠，不抢占扫描空间。',
    },
    navigation: {
      state: 'anchored',
      originRef: {
        kind: 'message',
        threadId: 'thread-preview-taste',
        messageId: 'message-preview-origin',
      },
      approvalCardRef: {
        threadId: 'thread-preview-taste',
        messageId: 'message-preview-card',
      },
    },
    createdAt: BASE_TIME - 2 * 60 * 60_000,
    decidedAt: BASE_TIME - 12 * 60_000,
    decidedBy: 'operator',
  },
  {
    proposalId: 'f246-preview-thread',
    sourceFeatureId: 'F128',
    requesterCatId: 'codex-terra',
    ownerUserId: 'preview-owner',
    resolution: 'rejected',
    materialization: { state: 'not_started' },
    summary: 'New thread: F128 提案缺少 owner 坐标，不应猜投',
    detail: {
      title: 'F128 提案缺少 owner 坐标，不应猜投',
      preferredCats: ['codex-terra'],
      reportingMode: 'standard',
      projectPath: '/workspace/cat-cafe',
      rationale: '无法从权威 feature truth 定位 owner thread，拒绝猜测路由。',
    },
    navigation: {
      state: 'anchored',
      originRef: {
        kind: 'event',
        anchor: 'preview:f128:missing-owner',
        summary: '未定位 owner thread',
      },
      approvalCardRef: {
        threadId: 'thread-preview-thread',
        messageId: 'message-preview-thread-card',
      },
    },
    createdAt: BASE_TIME - 3 * 60 * 60_000,
    decidedAt: BASE_TIME - 2 * 60 * 60_000,
    decidedBy: 'operator',
  },
];

export function F246HistoryDetailsPreview() {
  return (
    <main className="min-h-screen bg-cafe-surface-canvas px-3 py-6 text-cafe sm:px-6">
      <section className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-md">
        <header className="border-b border-cafe px-4 py-4 sm:px-6">
          <p className="text-micro font-semibold text-cafe-accent">审批 · 历史</p>
          <h1 className="mt-1 text-lg font-semibold">完整信息不丢，默认仍然好扫</h1>
          <p className="mt-1 text-sm text-cafe-secondary">摘要过长时可展开；完整技术详情默认收起，需要时原样查看。</p>
        </header>

        <div className="space-y-3 p-3 sm:p-4">
          {HISTORY_ITEMS.map((item) => (
            <SettledHistoryCard key={item.proposalId} item={item} />
          ))}
        </div>
      </section>
    </main>
  );
}
