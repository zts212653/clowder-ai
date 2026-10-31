'use client';

import type { BacklogItem, BacklogStatus, CatId } from '@cat-cafe/shared';
import { CompactLabel } from '@/components/content-overflow';
import { useFeatureDocDetail } from '../../hooks/useFeatureDocDetail';
import { FeatureProgressPanel } from './FeatureProgressPanel';

export interface ThreadSituationSummary {
  id: string;
  title?: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
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

function featureStatus(featureItems: BacklogItem[]): BacklogStatus {
  if (featureItems.some((item) => item.status === 'suggested' || item.status === 'approved')) return 'suggested';
  if (featureItems.some((item) => item.status === 'dispatched')) return 'dispatched';
  if (featureItems.some((item) => item.status === 'open')) return 'open';
  return 'done';
}

function featureName(featureItems: BacklogItem[]): string | null {
  const first = featureItems[0];
  if (!first) return null;
  const match = first.title.match(/^\[F\d+\]\s*(.+)/);
  return match?.[1]?.trim() ?? null;
}

interface FeatureRowProps {
  tag: string;
  featureItems: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  threadCount: number;
  titleMatchedThreads: ThreadSituationSummary[];
  expanded: boolean;
  onToggle: () => void;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}

export function FeatureRow({
  tag,
  featureItems,
  threadsByBacklogId,
  threadCount,
  titleMatchedThreads,
  expanded,
  onToggle,
  selectedItemId,
  onSelectItem,
}: FeatureRowProps) {
  const status = featureStatus(featureItems);
  const name = featureName(featureItems);
  const displayName = name ?? featureItems[0]?.title ?? '';
  const badge = STATUS_BADGE[status];
  const dispatchedItems = featureItems.filter((item) => item.status === 'dispatched' && threadsByBacklogId[item.id]);
  const totalThreadCount = Math.max(threadCount, dispatchedItems.length);
  const { detail, loading: detailLoading } = useFeatureDocDetail(expanded ? tag : null);

  return (
    <div
      className={`overflow-hidden rounded-xl bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)] ${
        expanded ? 'ring-1 ring-[var(--console-border-soft)]' : ''
      }`}
      data-testid={`mc-feature-row-${tag}`}
    >
      <div data-feature-row-header className="relative flex w-full items-center gap-2 px-4 py-3 text-left sm:gap-3">
        <button
          type="button"
          data-feature-row-toggle
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${tag} ${displayName}`}
          onClick={onToggle}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent focus-visible:ring-inset"
        >
          <span className="sr-only">
            {tag} {displayName}
          </span>
        </button>
        <span
          aria-hidden="true"
          className={`pointer-events-none relative z-10 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
        />
        <span className="pointer-events-none relative z-10 w-11 shrink-0 text-sm font-bold text-cafe-secondary">
          {tag}
        </span>
        <CompactLabel
          label="Feature 名称"
          value={displayName}
          density="compact"
          className="pointer-events-none relative z-10 min-w-0 flex-1 text-sm text-cafe [&>button]:pointer-events-auto"
        />
        <span
          className={`pointer-events-none relative z-10 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
        {totalThreadCount > 0 && (
          <span
            data-feature-thread-count
            className="pointer-events-none relative z-10 hidden shrink-0 items-center gap-1 text-xs text-cafe-secondary sm:flex"
          >
            <ThreadIcon />
            {totalThreadCount}
          </span>
        )}
        <span aria-hidden="true" className="pointer-events-none relative z-10 shrink-0 text-xs text-cafe-muted">
          {expanded ? '▼' : '▸'}
        </span>
      </div>

      {expanded && (
        <div className="console-divider-t px-4 py-3" data-testid={`mc-feature-detail-${tag}`}>
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
                    <TaskStatusIcon status={item.status} />
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
              <FeatureDependencies item={featureItems[0]} />
              {detailLoading && <p className="mt-3 animate-pulse text-xs text-cafe-muted">加载 Phase 进度...</p>}
              {detail && (
                <div className="mt-3">
                  <FeatureProgressPanel detail={detail} />
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-cafe-secondary">关联线程</p>
              <div className="space-y-1.5">
                {dispatchedItems.map((item) => {
                  const thread = threadsByBacklogId[item.id];
                  return <ThreadLinkRow key={thread.id} thread={thread} />;
                })}
                {titleMatchedThreads.length > 0 &&
                  dispatchedItems.length === 0 &&
                  titleMatchedThreads.map((thread) => <ThreadLinkRow key={thread.id} thread={thread} titleMatched />)}
                {titleMatchedThreads.length === 0 && dispatchedItems.length === 0 && (
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

function ThreadLinkRow({ thread, titleMatched = false }: { thread: ThreadSituationSummary; titleMatched?: boolean }) {
  const title = thread.title ?? thread.id;
  return (
    <div
      data-thread-link-row={thread.id}
      className="relative flex min-w-0 items-center gap-1.5 rounded-lg bg-[var(--console-hover-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary"
    >
      <a
        href={`/thread/${thread.id}`}
        aria-label={`打开关联线程 ${title}`}
        className="absolute inset-0 z-0 rounded-lg transition-colors hover:bg-[var(--console-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      >
        <span className="sr-only">打开关联线程 {title}</span>
      </a>
      <span className="pointer-events-none relative z-10">
        <ThreadIcon />
      </span>
      <CompactLabel
        label="关联线程标题"
        value={title}
        density="compact"
        className="pointer-events-none relative z-10 min-w-0 flex-1 [&>button]:pointer-events-auto"
      />
      {titleMatched && (
        <span className="pointer-events-none relative z-10 ml-auto shrink-0 text-micro text-cafe-muted">标题匹配</span>
      )}
    </div>
  );
}

function ThreadIcon() {
  return (
    <svg
      aria-hidden="true"
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
  );
}

function TaskStatusIcon({ status }: { status: BacklogStatus }) {
  if (status === 'done') {
    return (
      <svg
        aria-hidden="true"
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
    );
  }

  const border =
    status === 'dispatched' ? 'border-[var(--mc-status-suggested-dot)]' : 'border-[var(--console-border-soft)]';
  return <span aria-hidden="true" className={`h-4 w-4 shrink-0 rounded-full border-2 ${border}`} />;
}

function FeatureDependencies({ item }: { item?: BacklogItem }) {
  if (!item?.dependencies) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-bold uppercase tracking-wider text-cafe-secondary">依赖关系</p>
      <div className="flex flex-wrap gap-1">
        {item.dependencies.evolvedFrom?.map((id) => (
          <span
            key={`ef-${id}`}
            className="rounded-md border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-medium text-[var(--semantic-info)]"
          >
            ← {id.toUpperCase()}
          </span>
        ))}
        {item.dependencies.blockedBy?.map((id) => (
          <span
            key={`bb-${id}`}
            className="rounded-md border border-conn-red-ring bg-conn-red-bg px-1.5 py-0.5 text-micro font-medium text-conn-red-text"
          >
            ⊘ {id.toUpperCase()}
          </span>
        ))}
        {item.dependencies.related?.map((id) => (
          <span
            key={`rel-${id}`}
            className="rounded-md bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe-secondary"
          >
            ↔ {id.toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}
