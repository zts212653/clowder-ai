'use client';

import type { BacklogItem, BacklogStatus, CatId } from '@cat-cafe/shared';
import { useState } from 'react';

interface ThreadSituationSummary {
  id: string;
  title?: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
}

interface FeatureBirdEyePanelProps {
  items: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  /** F058 Phase G: thread count per feature from title matching */
  threadCountByFeature?: Record<string, number>;
}

const STATUS_LABELS: Record<BacklogStatus, string> = {
  open: '待建议',
  suggested: '待批准',
  approved: '已批准',
  dispatched: '执行中',
  done: '已完成',
};

const STATUS_COLORS: Record<BacklogStatus, string> = {
  open: 'bg-[#E8E0D5] text-[#6B5D4F]',
  suggested: 'bg-[#FFF0D4] text-[#8B6914]',
  approved: 'bg-[#DDEEFF] text-[#1A5FA0]',
  dispatched: 'bg-[#FDE8D0] text-[#A85E00]',
  done: 'bg-[#D4E8D0] text-[#2C5A28]',
};

/** Extract feature ID from tags. Supports `feature:f058` (import format) and bare `F058`. */
export function extractFeatureId(tags: readonly string[]): string {
  for (const tag of tags) {
    // Primary: `feature:f058` format from backlog-doc-import
    const prefixed = tag.match(/^feature:(f\d+)$/i);
    if (prefixed) return prefixed[1].toUpperCase();
    // Fallback: bare `F058`
    if (/^F\d+$/i.test(tag)) return tag.toUpperCase();
  }
  return 'Untagged';
}

function groupByFeature(items: BacklogItem[]): [string, BacklogItem[]][] {
  const groups = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const featureTag = extractFeatureId(item.tags);
    const list = groups.get(featureTag) ?? [];
    list.push(item);
    groups.set(featureTag, list);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'Untagged') return 1;
    if (b[0] === 'Untagged') return -1;
    return a[0].localeCompare(b[0]);
  });
}

function countByStatus(items: BacklogItem[]): Partial<Record<BacklogStatus, number>> {
  const counts: Partial<Record<BacklogStatus, number>> = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
}

function isFeatureAllDone(featureItems: BacklogItem[]): boolean {
  return featureItems.length > 0 && featureItems.every((i) => i.status === 'done');
}

/** Extract readable feature name from item title like "[F058] Mission Control 增强" → "Mission Control 增强" */
function extractFeatureName(items: BacklogItem[]): string | null {
  const first = items[0];
  if (!first) return null;
  const match = first.title.match(/^\[F\d+\]\s*(.+)/);
  return match?.[1]?.trim() ?? null;
}

export function FeatureBirdEyePanel({ items, threadsByBacklogId, threadCountByFeature }: FeatureBirdEyePanelProps) {
  const [doneExpanded, setDoneExpanded] = useState(false);
  const groups = groupByFeature(items);
  if (groups.length === 0) return null;

  const activeGroups = groups.filter(([, featureItems]) => !isFeatureAllDone(featureItems));
  const doneGroups = groups.filter(([, featureItems]) => isFeatureAllDone(featureItems));

  return (
    <section className="rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-feature-bird-eye">
      <h2 className="mb-2 text-sm font-semibold text-[#2C2118]">Feature 鸟瞰</h2>
      <div className="space-y-2">
        {activeGroups.map(([tag, featureItems]) => (
          <FeatureCard
            key={tag}
            tag={tag}
            featureItems={featureItems}
            threadsByBacklogId={threadsByBacklogId}
            titleThreadCount={threadCountByFeature?.[tag]}
          />
        ))}
      </div>
      {doneGroups.length > 0 && (
        <div className="mt-2" data-testid="mc-bird-eye-done-section">
          <button
            type="button"
            onClick={() => setDoneExpanded(!doneExpanded)}
            className="flex w-full items-center justify-between rounded-lg border border-dashed border-[#D4E8D0] bg-[#F6FBF5] px-2 py-1.5 text-left"
          >
            <span className="text-[11px] font-medium text-[#2C5A28]">已完成 · {doneGroups.length} 个 Feature</span>
            <span className="text-[11px] text-[#6B8F65]">{doneExpanded ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {doneExpanded && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {doneGroups.map(([tag, featureItems]) => (
                <DoneFeatureChip key={tag} tag={tag} featureItems={featureItems} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FeatureCard({
  tag,
  featureItems,
  threadsByBacklogId,
  titleThreadCount,
}: {
  tag: string;
  featureItems: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  titleThreadCount?: number;
}) {
  const counts = countByStatus(featureItems);
  const activeThreadCount = featureItems.filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id]).length;
  const featureName = extractFeatureName(featureItems);
  // Combine dispatched-linked threads + title-matched threads (avoid double-counting)
  const totalThreads = Math.max(activeThreadCount, titleThreadCount ?? 0);

  return (
    <article
      className="rounded-xl border border-[#EADFCF] bg-[#FFF9F0] px-3 py-2"
      data-testid={`mc-bird-eye-feature-${tag}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-[#4B3A2A] shrink-0">{tag}</span>
          {featureName && <span className="text-[11px] text-[#8B7864] truncate">{featureName}</span>}
        </div>
        <span className="text-[11px] text-[#8B7864] shrink-0 ml-2">{featureItems.length} 项</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {(Object.entries(counts) as [BacklogStatus, number][]).map(([status, count]) => (
          <span
            key={status}
            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]} {count}
          </span>
        ))}
      </div>
      {totalThreads > 0 && <p className="mt-1 text-[11px] text-[#6E5A46]">{totalThreads} 个线程关联</p>}
    </article>
  );
}

/** Compact chip for done features in the collapsed summary */
function DoneFeatureChip({ tag, featureItems }: { tag: string; featureItems: BacklogItem[] }) {
  const featureName = extractFeatureName(featureItems);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[#E8F5E2] px-2 py-0.5 text-[10px] text-[#3A6E34]"
      data-testid={`mc-bird-eye-done-chip-${tag}`}
    >
      <span className="font-medium">{tag}</span>
      {featureName && <span className="text-[#6B8F65] max-w-[120px] truncate">{featureName}</span>}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-2.5 w-2.5"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}
