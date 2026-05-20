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
  open: 'bg-[var(--mc-status-open-bg)] text-cafe-secondary',
  suggested: 'bg-[var(--mc-status-suggested-bg)] text-[var(--mc-status-suggested-text)]',
  approved: 'bg-[var(--mc-status-dispatched-bg)] text-[var(--mc-status-dispatched-text)]',
  dispatched: 'bg-[var(--mc-status-suggested-bg)] text-[var(--mc-status-suggested-text)]',
  done: 'bg-[var(--mc-status-done-bg)] text-[var(--mc-status-done-text)]',
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
    <section
      className="rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-3"
      data-testid="mc-feature-bird-eye"
    >
      <h2 className="mb-2 text-sm font-semibold text-cafe">Feature 鸟瞰</h2>
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
            className="flex w-full items-center justify-between rounded-lg border border-dashed border-[var(--mc-status-done-dot)] bg-[var(--mc-status-done-bg)] px-2 py-1.5 text-left"
          >
            <span className="text-xs font-medium text-[var(--mc-status-done-text)]">
              已完成 · {doneGroups.length} 个 Feature
            </span>
            <span className="text-xs text-[var(--mc-status-done-text)]">{doneExpanded ? '收起 ▲' : '展开 ▼'}</span>
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
      className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2"
      data-testid={`mc-bird-eye-feature-${tag}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-cafe shrink-0">{tag}</span>
          {featureName && <span className="text-xs text-cafe-secondary truncate">{featureName}</span>}
        </div>
        <span className="text-xs text-cafe-secondary shrink-0 ml-2">{featureItems.length} 项</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {(Object.entries(counts) as [BacklogStatus, number][]).map(([status, count]) => (
          <span
            key={status}
            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-micro font-medium ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]} {count}
          </span>
        ))}
      </div>
      {totalThreads > 0 && <p className="mt-1 text-xs text-cafe-secondary">{totalThreads} 个线程关联</p>}
    </article>
  );
}

/** Compact chip for done features in the collapsed summary */
function DoneFeatureChip({ tag, featureItems }: { tag: string; featureItems: BacklogItem[] }) {
  const featureName = extractFeatureName(featureItems);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--mc-status-done-bg)] px-2 py-0.5 text-micro text-[var(--mc-status-done-text)]"
      data-testid={`mc-bird-eye-done-chip-${tag}`}
    >
      <span className="font-medium">{tag}</span>
      {featureName && <span className="text-[var(--mc-status-done-text)] max-w-[120px] truncate">{featureName}</span>}
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
