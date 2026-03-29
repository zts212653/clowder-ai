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
  open: 'bg-[#C4B5A0]',
  suggested: 'bg-[#E4A853]',
  approved: 'bg-[#E4A853]',
  dispatched: 'bg-[#5B9BD5]',
  done: 'bg-[#7CB87C]',
};

const STATUS_BADGE: Record<BacklogStatus, { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-[#F0EAE0]', text: 'text-[#6B5D4F]', label: '待建议' },
  suggested: { bg: 'bg-[#FFF3E0]', text: 'text-[#C48A2A]', label: '待审批' },
  approved: { bg: 'bg-[#FFF3E0]', text: 'text-[#C48A2A]', label: '已批准' },
  dispatched: { bg: 'bg-[#E3F0FC]', text: 'text-[#4A7FB5]', label: '执行中' },
  done: { bg: 'bg-[#E8F5E2]', text: 'text-[#3A6E34]', label: '已完成' },
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
            className="flex w-full items-center gap-2 rounded-xl bg-[#F4EFE7] px-4 py-3"
          >
            <span className="text-xs text-[#9A866F]">{doneExpanded ? '▼' : '▸'}</span>
            <span className="text-[13px] font-semibold text-[#7A6B5A]">已完成</span>
            <span className="rounded-full bg-[#E7DAC7] px-2 py-0.5 text-[11px] font-bold text-[#7A6B5A]">
              {doneGroups.length}
            </span>
            <span className="text-xs text-[#B5A48E]">{doneGroups.map(([t]) => t).join(' · ')}</span>
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
      className={`rounded-xl border ${expanded ? 'border-[#8B6F47] border-2' : 'border-[#E7DAC7]'} bg-[#FFFDF8] overflow-hidden`}
      data-testid={`mc-feature-row-${tag}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
        <span className="w-11 shrink-0 text-[13px] font-bold text-[#8B6F47]">{tag}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-[#2B2118]">{name ?? featureItems[0]?.title ?? ''}</span>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${badge.bg} ${badge.text}`}>
          {badge.label}
        </span>
        {totalThreadCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-[#9A866F]">
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
        <span className="shrink-0 text-xs text-[#C4B5A0]">{expanded ? '▼' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-[#E7DAC7] px-4 py-3" data-testid={`mc-feature-detail-${tag}`}>
          <div className="grid gap-4 md:grid-cols-[1fr_280px]">
            <div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#9A866F]">任务进度</p>
              <div className="space-y-1.5">
                {featureItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectItem(item.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      selectedItemId === item.id ? 'bg-[#F7EEDB]' : 'hover:bg-[#FAF5ED]'
                    }`}
                  >
                    {item.status === 'done' ? (
                      <svg
                        className="h-4 w-4 shrink-0 text-[#7CB87C]"
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
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[#E4A853]" />
                    ) : (
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-[#C4B5A0]" />
                    )}
                    <span className={item.status === 'done' ? 'text-[#9A866F] line-through' : 'text-[#2B2118]'}>
                      {item.title}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[item.status].bg} ${STATUS_BADGE[item.status].text}`}
                    >
                      {STATUS_BADGE[item.status].label}
                    </span>
                  </button>
                ))}
              </div>
              {featureItems[0]?.dependencies && (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[#9A866F]">依赖关系</p>
                  <div className="flex flex-wrap gap-1">
                    {featureItems[0].dependencies.evolvedFrom?.map((id) => (
                      <span
                        key={`ef-${id}`}
                        className="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                      >
                        ← {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.blockedBy?.map((id) => (
                      <span
                        key={`bb-${id}`}
                        className="rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
                      >
                        ⊘ {id.toUpperCase()}
                      </span>
                    ))}
                    {featureItems[0].dependencies.related?.map((id) => (
                      <span
                        key={`rel-${id}`}
                        className="rounded-md border border-cafe bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-cafe-secondary"
                      >
                        ↔ {id.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detailLoading && <p className="mt-3 text-[11px] text-[#B5A48E] animate-pulse">加载 Phase 进度...</p>}
              {detail && (
                <div className="mt-3">
                  <FeatureProgressPanel detail={detail} />
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#9A866F]">关联线程</p>
              <div className="space-y-1.5">
                {featureItems
                  .filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id])
                  .map((i) => {
                    const thread = threadsByBacklogId[i.id];
                    return (
                      <a
                        key={thread.id}
                        href={`/thread/${thread.id}`}
                        className="flex items-center gap-1.5 rounded-lg bg-[#F4EFE7] px-2.5 py-1.5 text-xs text-[#5A4A38] transition-colors hover:bg-[#EDE4D6]"
                      >
                        <svg
                          className="h-3.5 w-3.5 shrink-0 text-[#8B6F47]"
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
                      className="flex items-center gap-1.5 rounded-lg bg-[#F0EBE2] px-2.5 py-1.5 text-xs text-[#5A4A38] transition-colors hover:bg-[#EDE4D6]"
                    >
                      <svg
                        className="h-3.5 w-3.5 shrink-0 text-[#9A866F]"
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
                      <span className="ml-auto shrink-0 text-[10px] text-[#B5A48E]">标题匹配</span>
                    </a>
                  ))}
                {titleMatchedThreads.length === 0 &&
                  featureItems.filter((i) => i.status === 'dispatched' && threadsByBacklogId[i.id]).length === 0 && (
                    <p className="text-[11px] text-[#B5A48E]">暂无关联线程</p>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
