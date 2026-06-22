'use client';

/**
 * F233 Phase C C3 — Trajectory 事件卡片（设计稿 §2.3 四层 + §3 提包球高亮）。
 *
 * 四层：Header(kind badge + 多源标签) / 提包球 warning / Payload summary / Meta + provenance 下钻。
 * 暗色霓虹玻璃拟态（设计稿要求的"暗色传播资产"气质）。
 */

import type { FeatTrajectoryEntry, GitRefSnapshot } from '@cat-cafe/shared';
import { useState } from 'react';
import { isCarryingBag, KIND_VISUALS, SOURCE_LABELS, TONE_CLASSES } from './trajectory-kind-styles';

/* ── payload 安全提取 helper（payload 是 Record<string, unknown>，不裸用 any）── */
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function formatAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getSnapshot(entry: FeatTrajectoryEntry): GitRefSnapshot | undefined {
  if (entry.source !== 'git-ref-snapshot') return undefined;
  const snap = entry.payload.snapshot;
  return snap && typeof snap === 'object' ? (snap as GitRefSnapshot) : undefined;
}

/** payload → 人类可读摘要。git-ref 精细；event-stream 保守用 kind label（不猜字段结构）。 */
function buildSummary(entry: FeatTrajectoryEntry, label: string): { title: string; detail?: string } {
  const p = entry.payload;
  if (entry.source === 'git-ref-snapshot') {
    const snap = getSnapshot(entry);
    const branch = snap?.branchName ?? '';
    const sha = snap?.headCommitSha?.slice(0, 7);
    const bucket = asStr(p.staleBucket);
    switch (entry.kind) {
      case 'branch_stale_unmerged':
        return { title: `分支滞留未合并，已 ${bucket ?? '?'}`, detail: branch };
      case 'pr_opened':
        return { title: `PR #${snap?.prNumber ?? '?'} 开启`, detail: branch };
      case 'branch_merged_to_main':
        return { title: `已合入主干（PR #${snap?.prNumber ?? '?'}）`, detail: branch };
      case 'branch_pushed':
        return { title: '分支已推送', detail: sha ? `${branch} @ ${sha}` : branch };
      default:
        return { title: label, detail: branch };
    }
  }
  if (entry.source === 'historical-stitched') {
    return { title: `历史考古拼接（${label}）`, detail: asStr(p.stitchType) };
  }
  // event-stream — TODO(opus-48): 拿到 opus-47 真实 dump 后按 BallCustodyEvent 字段精修摘要
  return { title: label };
}

function extractAuthor(entry: FeatTrajectoryEntry, snapshot: GitRefSnapshot | undefined): string | undefined {
  if (snapshot?.authorIdentity) return snapshot.authorIdentity;
  const p = entry.payload;
  return asStr(p.author) ?? asStr(p.by) ?? asStr(p.actorCatId) ?? asStr(p.actor);
}

export function TrajectoryCard({
  entry,
  onJumpToThread,
}: {
  entry: FeatTrajectoryEntry;
  onJumpToThread?: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const visual = KIND_VISUALS[entry.kind] ?? {
    tone: 'gray' as const,
    label: entry.kind,
    icon: '•',
    family: 'historical' as const,
  };
  const tone = TONE_CLASSES[visual.tone];
  const snapshot = getSnapshot(entry);
  const headCommitAt = snapshot?.headCommitAt ?? entry.at;
  const isStale = isCarryingBag(entry.kind, snapshot?.lastThreadMessageAt ?? null, headCommitAt);
  const isStitched = entry.source === 'historical-stitched';
  const summary = buildSummary(entry, visual.label);
  const author = extractAuthor(entry, snapshot);
  const staleBucket = entry.kind === 'branch_stale_unmerged' ? asStr(entry.payload.staleBucket) : undefined;
  const threadId = snapshot?.associatedThreadIds?.[0] ?? asStr(entry.payload.threadId);

  return (
    <div className="relative pl-8 pb-5 group" data-testid="trajectory-card" data-kind={entry.kind} data-stale={isStale}>
      {/* 时间轴连接线 */}
      <div
        className={`absolute left-3 top-3 bottom-0 w-px -translate-x-1/2 ${
          isStitched ? 'border-l border-dashed border-conn-gray-ring/40' : tone.line
        }`}
      />
      {/* 节点圆圈 */}
      <div
        className={`absolute left-3 top-2.5 h-3 w-3 -translate-x-1/2 rounded-full ring-4 ${tone.dot} ${
          isStale ? 'animate-pulse' : ''
        }`}
      />

      {/* 卡片本体（暗色霓虹玻璃拟态） */}
      <div
        className={`rounded-xl border p-3 bg-neutral-900/50 backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 ${tone.cardBorder}`}
      >
        {/* Header: kind badge + 多源标签 */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span
            className={`inline-flex items-center gap-1 text-micro font-bold px-2 py-0.5 rounded-full border ${tone.badge}`}
          >
            <span aria-hidden>{visual.icon}</span>
            {visual.label}
            {staleBucket && <span className="opacity-80">· {staleBucket}</span>}
          </span>
          <span className="text-micro font-mono text-neutral-500" title={`数据源: ${entry.source}`}>
            {SOURCE_LABELS[entry.source]}
          </span>
        </div>

        {/* 提包球警示 banner */}
        {isStale && (
          <div className="mb-2 px-2 py-1.5 rounded-lg bg-conn-amber-bg/15 border border-conn-amber-ring/30 text-xs text-conn-amber-text flex items-center gap-2">
            <span>⚠️ 猫咪已提包离线{staleBucket ? ` [stale: ${staleBucket}]` : ''}</span>
            {threadId && onJumpToThread && (
              <button
                type="button"
                onClick={() => onJumpToThread(threadId)}
                className="ml-auto text-micro underline hover:no-underline whitespace-nowrap"
              >
                一键催醒 →
              </button>
            )}
          </div>
        )}

        {/* Payload summary */}
        <p className="text-xs text-neutral-300 leading-relaxed">{summary.title}</p>
        {summary.detail && <p className="text-micro font-mono text-neutral-500 mt-0.5 truncate">{summary.detail}</p>}

        {/* Meta: 时间 + 作者 + provenance 下钻入口 */}
        <div className="mt-2 flex items-center gap-2 text-micro text-neutral-500">
          <span>{formatAt(entry.at)}</span>
          {author && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-conn-cyan-text/60" />
              {author}
            </span>
          )}
          {entry.provenance && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="ml-auto text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              置信度 {entry.provenance.confidence} {expanded ? '▴' : '▾'}
            </button>
          )}
        </div>

        {/* 下钻：provenance 溯源链 */}
        {expanded && entry.provenance && (
          <div className="mt-2 pt-2 border-t border-neutral-700/50 text-micro text-neutral-400 space-y-1.5">
            <div className="text-neutral-500">派生来源（derivedFrom）：</div>
            <div className="flex flex-wrap gap-1">
              {entry.provenance.derivedFrom.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static provenance list, never reordered/mutated
                <span key={`${d}:${i}`} className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono">
                  {d}
                </span>
              ))}
            </div>
            {entry.provenance.note && <div className="text-neutral-500 italic">{entry.provenance.note}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
