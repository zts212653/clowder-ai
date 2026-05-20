'use client';

import type { BacklogItem, BacklogStatus, CatId } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { useFeatureDocDetail } from '../../hooks/useFeatureDocDetail';
import { extractFeatureId } from './FeatureBirdEyePanel';
import { FeatureProgressPanel } from './FeatureProgressPanel';

interface ThreadSituationSummary {
  id: string;
  title?: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
}

interface FeatureRowListProps {
  items: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  threadCountByFeature: Record<string, number>;
  threadsByFeatureId?: Record<string, ThreadSituationSummary[]>;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}

const STATUS_DOT: Record<BacklogStatus, string> = {
  open: 'bg-[var(--mc-status-open-dot)]',
  suggested: 'bg-[var(--mc-status-suggested-dot)]',
  approved: 'bg-[var(--mc-status-suggested-dot)]',
  dispatched: 'bg-[var(--mc-status-dispatched-dot)]',
  done: 'bg-[var(--mc-status-done-dot)]',
};

const STATUS_BADGE: Record<BacklogStatus, { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-[var(--mc-status-open-bg)]', text: 'text-cafe-secondary', label: '待建议' },
  suggested: {
    bg: 'bg-[var(--mc-status-suggested-bg)]',
    text: 'text-[var(--mc-status-suggested-text)]',
    label: '待审批',
  },
  approved: {
    bg: 'bg-[var(--mc-status-suggested-bg)]',
    text: 'text-[var(--mc-status-suggested-text)]',
    label: '已批准',
  },
  dispatched: {
    bg: 'bg-[var(--mc-status-dispatched-bg)]',
    text: 'text-[var(--mc-status-dispatched-text)]',
    label: '执行中',
  },
  done: { bg: 'bg-[var(--mc-status-done-bg)]', text: 'text-[var(--mc-status-done-text)]', label: '已完成' },
};

function groupByFeature(items: BacklogItem[]): [string, BacklogItem[]][] {
  const groups = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const fid = extractFeatureId(item.tags);
    const list = groups.get(fid) ?? [];
    list.push(item);
    groups.set(fid, list);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'Untagged') return 1;
    if (b[0] === 'Untagged') return -1;
    return a[0].localeCompare(b[0]);
  });
}

function isAllDone(featureItems: BacklogItem[]): boolean {
  return featureItems.length > 0 && featureItems.every((i) => i.status === 'done');
}

/** Determine the "worst" (most actionable) status for a Feature group */
function featureStatus(featureItems: BacklogItem[]): BacklogStatus {
  if (featureItems.some((i) => i.status === 'suggested' || i.status === 'approved')) return 'suggested';
  if (featureItems.some((i) => i.status === 'dispatched')) return 'dispatched';
  if (featureItems.some((i) => i.status === 'open')) return 'open';
  return 'done';
}

function featureName(featureItems: BacklogItem[]): string | null {
  const first = featureItems[0];
  if (!first) return null;
  const match = first.title.match(/^\[F\d+\]\s*(.+)/);
  return match?.[1]?.trim() ?? null;
}

export function FeatureRowList({
  items,
  threadsByBacklogId,
  threadCountByFeature,
  threadsByFeatureId = {},
  selectedItemId,
  onSelectItem,
}: FeatureRowListProps) {
  const groups = useMemo(() => groupByFeature(items), [items]);
  const activeGroups = useMemo(() => groups.filter(([, fi]) => !isAllDone(fi)), [groups]);
  const doneGroups = useMemo(() => groups.filter(([, fi]) => isAllDone(fi)), [groups]);
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);

  return (
    <div className="space-y-2" data-testid="mc-feature-row-list">
      {activeGroups.map(([tag, featureItems]) => (
        <FeatureRow
          key={tag}
          tag={tag}
          featureItems={featureItems}
          threadsByBacklogId={threadsByBacklogId}
          threadCount={threadCountByFeature[tag] ?? 0}
          titleMatchedThreads={threadsByFeatureId[tag] ?? []}
          expanded={expandedFeature === tag}
          onToggle={() => setExpandedFeature(expandedFeature === tag ? null : tag)}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
        />
      ))}

      {doneGroups.length > 0 && (
        <div data-testid="mc-feature-done-section">
          <button
            type="button"
            onClick={() => setDoneExpanded(!doneExpanded)}
            className="flex w-full items-center gap-2 rounded-xl bg-[var(--console-hover-bg)] px-4 py-3"
          >
            <span className="text-xs text-cafe-secondary">{doneExpanded ? '▼' : '▸'}</span>
            <span className="text-sm font-semibold text-cafe-secondary">已完成</span>
            <span className="rounded-full bg-[var(--console-border-soft)] px-2 py-0.5 text-xs font-bold text-cafe-secondary">
              {doneGroups.length}
            </span>
            <span className="text-xs text-cafe-muted">{doneGroups.map(([t]) => t).join(' · ')}</span>
          </button>
          {doneExpanded && (
            <div className="mt-2 space-y-2">
              {doneGroups.map(([tag, featureItems]) => (
                <FeatureRow
                  key={tag}
                  tag={tag}
                  featureItems={featureItems}
                  threadsByBacklogId={threadsByBacklogId}
                  threadCount={threadCountByFeature[tag] ?? 0}
                  titleMatchedThreads={threadsByFeatureId[tag] ?? []}
                  expanded={expandedFeature === tag}
                  onToggle={() => setExpandedFeature(expandedFeature === tag ? null : tag)}
                  selectedItemId={selectedItemId}
                  onSelectItem={onSelectItem}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FeatureRow({
  tag,
  featureItems,
  threadsByBacklogId,
  threadCount,
  titleMatchedThreads,
  expanded,
  onToggle,
  selectedItemId,
  onSelectItem,
}: {
  tag: string;
  featureItems: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  threadCount: number;
  titleMatchedThreads: ThreadSituationSummary[];
  expanded: boolean;
  onToggle: () => void;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}) {
  const status = featureStatus(featureItems);
  const name = featureName(featureItems);
  const badge = STATUS_BADGE[status];
  const dispatchedThreadCount = featureItems.filter(
    (i) => i.status === 'dispatched' && threadsByBacklogId[i.id],
  ).length;
  const totalThreadCount = Math.max(threadCount, dispatchedThreadCount);
  const { detail, loading: detailLoading } = useFeatureDocDetail(expanded ? tag : null);

  return (
    <div
      className={`rounded-xl border ${expanded ? 'border-[var(--console-border-soft)] border-2' : 'border-[var(--console-border-soft)]'} bg-[var(--console-card-bg)] overflow-hidden`}
      data-testid={`mc-feature-row-${tag}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
        <span className="w-11 shrink-0 text-sm font-bold text-cafe-secondary">{tag}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-cafe">{name ?? featureItems[0]?.title ?? ''}</span>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${badge.bg} ${badge.text}`}>
          {badge.label}
        </span>
        {totalThreadCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-cafe-secondary">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
            </svg>
            {totalThreadCount}
          </span>
        )}
        <span className="shrink-0 text-xs text-cafe-muted">{expanded ? '▼' : '▸'}</span>
      </button>

      {expanded && (
        <div
          className="border-t border-[var(--console-border-soft)] px-4 py-3"
          data-testid={`mc-feature-detail-${tag}`}
        >
          <div className="grid gap-4 md:grid-cols-[1fr_280px]">
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-cafe-secondary">任务进度</p>
              <div className="space-y-1.5">
                {featureItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectItem(item.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      selectedItemId === item.id ? 'bg-[var(--console-hover-bg)]' : 'hover:bg-[var(--console-hover-bg)]'
                    }`}
                  >
                    {item.status === 'done' ? (
                      <svg
                        className="h-4 w-4 shrink-0 text-[var(--mc-status-done-dot)]"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                    ) : item.status === 'dispatched' ? (
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[var(--mc-status-suggested-dot)]" />
                    ) : (
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[var(--console-border-soft)]" />
                    )}
                    <span className={item.status === 'done' ? 'text-cafe-secondary line-through' : 'text-cafe'}>
                      {item.title}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-micro font-semibold ${STATUS_BADGE[item.status].bg} ${STATUS_BADGE[item.status].text}`}
                    >
                      {STATUS_BADGE[item.status].label}
                    </span>
                  </button>
                ))}
              </div>
              {featureItems[0]?.dependencies && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-bold uppercase tracking-wider text-cafe-secondary">依赖关系</p>
                  <div className="flex flex-wrap gap-1">
                    {featureItems[0].dependencies.evolvedFrom?.map((id) => (
                      <span
                        key={`ef-${id}`}
                        className="rounded-md border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-medium text-blue-700"
                      >
                        ← {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.blockedBy?.map((id) => (
                      <span
                        key={`bb-${id}`}
                        className="rounded-md border border-conn-red-ring bg-conn-red-bg px-1.5 py-0.5 text-micro font-medium text-red-700"
                      >
                        ⊘ {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.related?.map((id) => (
                      <span
                        key={`rel-${id}`}
                        className="rounded-md border border-cafe bg-cafe-surface-elevated px-1.5 py-0.5 text-micro font-medium text-cafe-secondary"
                      >
                        ↔ {id.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detailLoading && <p className="mt-3 text-xs text-cafe-muted animate-pulse">加载 Phase 进度...</p>}
              {detail && (
                <div className="mt-3">
                  <FeatureProgressPanel detail={detail} />
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-cafe-secondary">关联线程</p>
              <div className="space-y-1.5">
                {featureItems
                  .filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id])
                  .map((i) => {
                    const thread = threadsByBacklogId[i.id];
                    return (
                      <a
                        key={thread.id}
                        href={`/thread/${thread.id}`}
                        className="flex items-center gap-1.5 rounded-lg bg-[var(--console-hover-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)]"
                      >
                        <svg
                          className="h-3.5 w-3.5 shrink-0 text-cafe-secondary"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
                        </svg>
                        <span className="truncate">{thread.title ?? thread.id}</span>
                      </a>
                    );
                  })}
                {titleMatchedThreads.length > 0 &&
                  featureItems.filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id]).length === 0 &&
                  titleMatchedThreads.map((t) => (
                    <a
                      key={t.id}
                      href={`/thread/${t.id}`}
                      className="flex items-center gap-1.5 rounded-lg bg-[var(--console-hover-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)]"
                    >
                      <svg
                        className="h-3.5 w-3.5 shrink-0 text-cafe-secondary"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
                      </svg>
                      <span className="truncate">{t.title ?? t.id}</span>
                      <span className="ml-auto shrink-0 text-micro text-cafe-muted">标题匹配</span>
                    </a>
                  ))}
                {titleMatchedThreads.length === 0 &&
                  featureItems.filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id]).length === 0 && (
                    <p className="text-xs text-cafe-muted">暂无关联线程</p>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
