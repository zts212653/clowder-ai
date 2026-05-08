'use client';

import type { BacklogItem, BacklogStatus, CatId } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { getThreadHref } from '@/components/ThreadSidebar/thread-navigation';
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
  onDeleteItem?: (id: string) => Promise<void>;
}

const STATUS_DOT: Record<BacklogStatus, string> = {
  open: 'bg-conn-gray-bg',
  suggested: 'bg-conn-amber-text',
  approved: 'bg-conn-amber-text',
  dispatched: 'bg-conn-blue-text',
  done: 'bg-conn-emerald-text',
};

const STATUS_BADGE: Record<BacklogStatus, { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-[var(--console-pill-bg)]', text: 'text-cafe-secondary', label: '待建议' },
  suggested: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '待审批' },
  approved: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '已批准' },
  dispatched: { bg: 'bg-conn-blue-bg', text: 'text-conn-blue-text', label: '执行中' },
  done: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: '已完成' },
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
  onDeleteItem,
}: FeatureRowListProps) {
  const groups = useMemo(() => groupByFeature(items), [items]);
  const activeGroups = useMemo(() => groups.filter(([, fi]) => !isAllDone(fi)), [groups]);
  const doneGroups = useMemo(() => groups.filter(([, fi]) => isAllDone(fi)), [groups]);
  const [expandedFeature, setExpandedFeature] = useState<string | null>('Untagged');
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
          onDeleteItem={onDeleteItem}
        />
      ))}

      {doneGroups.length > 0 && (
        <div data-testid="mc-feature-done-section">
          <button
            type="button"
            onClick={() => setDoneExpanded(!doneExpanded)}
            className="flex w-full items-center gap-2 rounded-xl bg-[var(--console-pill-bg)] px-4 py-3"
          >
            <span className="text-xs text-cafe-muted">{doneExpanded ? '▼' : '▸'}</span>
            <span className="text-[13px] font-semibold text-cafe-secondary">已完成</span>
            <span className="rounded-full bg-[var(--console-pill-bg)] px-2 py-0.5 text-[11px] font-bold text-cafe-secondary">
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
                  onDeleteItem={onDeleteItem}
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
  onDeleteItem,
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
  onDeleteItem?: (id: string) => Promise<void>;
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
      className={`rounded-xl overflow-hidden bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] ${expanded ? 'ring-1 ring-[var(--cafe-accent)]/40' : ''}`}
      data-testid={`mc-feature-row-${tag}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
        <span className="shrink-0 text-[13px] font-bold text-[var(--cafe-accent)]">{tag}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-cafe">{name ?? featureItems[0]?.title ?? ''}</span>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${badge.bg} ${badge.text}`}>
          {badge.label}
        </span>
        {totalThreadCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-cafe-muted">
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
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-cafe-muted">任务进度</p>
              <div className="space-y-1.5">
                {featureItems.map((item) => (
                  <div
                    key={item.id}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                      selectedItemId === item.id ? 'bg-[var(--console-pill-bg)]' : 'hover:bg-[var(--console-card-bg)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectItem(item.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {item.status === 'done' ? (
                        <svg
                          className="h-4 w-4 shrink-0 text-conn-emerald-text"
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
                        <span className="h-4 w-4 shrink-0 rounded-full border-2 border-conn-amber-ring" />
                      ) : (
                        <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[var(--console-border-soft)]" />
                      )}
                      <span
                        className={`min-w-0 truncate ${item.status === 'done' ? 'text-cafe-muted line-through' : 'text-cafe'}`}
                      >
                        {item.title}
                      </span>
                    </button>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[item.status].bg} ${STATUS_BADGE[item.status].text}`}
                    >
                      {STATUS_BADGE[item.status].label}
                    </span>
                    {onDeleteItem && item.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => void onDeleteItem(item.id)}
                        className="shrink-0 text-cafe-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-conn-red-text"
                        title="删除"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {featureItems[0]?.dependencies && (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-cafe-muted">依赖关系</p>
                  <div className="flex flex-wrap gap-1">
                    {featureItems[0].dependencies.evolvedFrom?.map((id) => (
                      <span
                        key={`ef-${id}`}
                        className="rounded-md border border-[var(--color-cafe-accent)]/30 bg-[var(--color-cafe-accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-cafe-accent)]"
                      >
                        ← {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.blockedBy?.map((id) => (
                      <span
                        key={`bb-${id}`}
                        className="rounded-md border border-conn-red-ring bg-conn-red-bg px-1.5 py-0.5 text-[10px] font-medium text-conn-red-text"
                      >
                        ⊘ {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.related?.map((id) => (
                      <span
                        key={`rel-${id}`}
                        className="rounded-md border border-[var(--console-border-soft)] bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-cafe-secondary"
                      >
                        ↔ {id.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detailLoading && <p className="mt-3 text-[11px] text-cafe-muted animate-pulse">加载 Phase 进度...</p>}
              {detail && (
                <div className="mt-3">
                  <FeatureProgressPanel detail={detail} />
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-cafe-muted">关联线程</p>
              <div className="space-y-1.5">
                {featureItems
                  .filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id])
                  .map((i) => {
                    const thread = threadsByBacklogId[i.id];
                    return (
                      <a
                        key={thread.id}
                        href={getThreadHref(thread.id)}
                        className="flex items-center gap-1.5 rounded-lg bg-[var(--console-pill-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-pill-bg)]"
                      >
                        <svg
                          className="h-3.5 w-3.5 shrink-0 text-[var(--cafe-accent)]"
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
                      href={getThreadHref(t.id)}
                      className="flex items-center gap-1.5 rounded-lg bg-[var(--console-pill-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-pill-bg)]"
                    >
                      <svg
                        className="h-3.5 w-3.5 shrink-0 text-cafe-muted"
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
                      <span className="ml-auto shrink-0 text-[10px] text-cafe-muted">标题匹配</span>
                    </a>
                  ))}
                {titleMatchedThreads.length === 0 &&
                  featureItems.filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id]).length === 0 && (
                    <p className="text-[11px] text-cafe-muted">暂无关联线程</p>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
