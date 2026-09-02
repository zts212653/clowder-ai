'use client';

import type { ThreadBriefPresentationState, ThreadBriefV1 } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useRecentThreadBriefs } from '@/hooks/useRecentThreadBriefs';

const CURRENT_SECTIONS: ReadonlyArray<{
  readonly state: ThreadBriefPresentationState;
  readonly title: string;
}> = [
  { state: 'needs_user', title: '需要你' },
  { state: 'running', title: '正在推进' },
  { state: 'unknown', title: '状态确认中' },
  { state: 'waiting_external', title: '等待外部' },
];

export function RecentThreadsPage() {
  const { current, recent, nextCursor, loading, loadingMore, error, refetch, loadMore } = useRecentThreadBriefs();
  const router = useRouter();
  const { getCatById } = useCatData();
  const resolveCatName = (catId: string) => {
    const cat = getCatById(catId);
    return cat ? formatCatName(cat) : '一只猫';
  };
  const enterThread = (threadId: string) => router.push(`/thread/${encodeURIComponent(threadId)}`);
  const hasContent = current.length > 0 || recent.length > 0;

  return (
    <main className="min-h-full bg-[var(--console-shell-bg)] text-cafe-black" data-testid="recent-threads-page">
      <header className="console-divider-b flex min-h-[72px] items-center justify-between px-6 py-3 md:px-10">
        <div>
          <h1 className="text-xl font-semibold">近况</h1>
          <p className="mt-1 text-xs text-cafe-muted">你近期推进的会话 · 与会话内信息保持一致</p>
        </div>
        <button
          type="button"
          className="rounded-full bg-cafe-surface-sunken px-4 py-2 text-xs text-cafe-secondary hover:text-cafe-black"
          onClick={refetch}
        >
          最近更新
        </button>
      </header>

      <div className="mx-auto max-w-[1280px] px-5 py-6 md:px-10">
        {loading && !hasContent && <p className="text-sm text-cafe-muted">正在读取近况…</p>}
        {error && !hasContent && (
          <div className="rounded-xl border border-cafe-subtle bg-cafe-surface p-5">
            <p className="text-sm font-medium">近况暂时无法确认</p>
            <p className="mt-1 text-xs text-cafe-muted">稍后重新读取，不会用陈旧任务猜测当前状态。</p>
          </div>
        )}
        {!loading && !error && !hasContent && <RecentEmptyState />}
        {hasContent && (
          <div className="grid grid-cols-1 items-start gap-x-6 xl:grid-cols-2">
            <div>
              {CURRENT_SECTIONS.slice(0, 2).map((section) => (
                <BriefSection
                  key={section.state}
                  title={section.title}
                  briefs={current.filter((brief) => brief.presentationState === section.state)}
                  resolveCatName={resolveCatName}
                  onEnter={enterThread}
                />
              ))}
            </div>
            <div>
              {CURRENT_SECTIONS.slice(2).map((section) => (
                <BriefSection
                  key={section.state}
                  title={section.title}
                  briefs={current.filter((brief) => brief.presentationState === section.state)}
                  resolveCatName={resolveCatName}
                  onEnter={enterThread}
                />
              ))}
              <BriefSection
                title="最近有进展"
                briefs={recent}
                resolveCatName={resolveCatName}
                onEnter={enterThread}
                recent
              />
              {nextCursor && (
                <button
                  type="button"
                  className="mb-6 w-full rounded-xl border border-cafe-subtle py-2.5 text-xs text-cafe-secondary hover:bg-cafe-surface"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? '正在加载…' : '加载更早近况'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function BriefSection({
  title,
  briefs,
  resolveCatName,
  onEnter,
  recent = false,
}: {
  readonly title: string;
  readonly briefs: readonly ThreadBriefV1[];
  readonly resolveCatName: (catId: string) => string;
  readonly onEnter: (threadId: string) => void;
  readonly recent?: boolean;
}) {
  if (briefs.length === 0) return null;
  return (
    <section className="mb-6" aria-label={title}>
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-cafe-secondary">{title}</h2>
        <span className="rounded-full bg-cafe-surface-sunken px-2 py-0.5 text-micro text-cafe-muted">
          {briefs.length}
        </span>
      </div>
      <div className="space-y-2.5">
        {briefs.map((brief) => (
          <RecentBriefCard
            key={brief.thread.id}
            brief={brief}
            resolveCatName={resolveCatName}
            onEnter={onEnter}
            recent={recent}
          />
        ))}
      </div>
    </section>
  );
}

function RecentBriefCard({
  brief,
  resolveCatName,
  onEnter,
  recent,
}: {
  readonly brief: ThreadBriefV1;
  readonly resolveCatName: (catId: string) => string;
  readonly onEnter: (threadId: string) => void;
  readonly recent: boolean;
}) {
  const recentHeadline = brief.recentProgress[0]?.headline ?? '还没有关键进展记录';
  return (
    <article className="rounded-xl border border-cafe-subtle bg-cafe-surface px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate text-sm font-semibold">{brief.contextHeading.text}</h3>
        <span className="shrink-0 rounded-full bg-cafe-surface-sunken px-3 py-1 text-micro text-cafe-secondary">
          {recent ? '最近更新' : stateLabel(brief.presentationState)}
        </span>
      </div>
      <p className="mt-2 truncate text-xs text-cafe-secondary">
        <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--semantic-info)]" />
        {currentLine(brief, resolveCatName, recent)}
      </p>
      <p className="mt-2 truncate text-xs text-cafe-secondary">{recentHeadline}</p>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs">
        <p className="min-w-0 truncate text-cafe-muted">下一步：{brief.nextStep ?? '尚未明确'}</p>
        <button
          type="button"
          className="shrink-0 font-medium text-cafe-accent hover:underline"
          onClick={() => onEnter(brief.thread.id)}
        >
          进入会话 ›
        </button>
      </div>
    </article>
  );
}

function currentLine(brief: ThreadBriefV1, resolveCatName: (catId: string) => string, recent: boolean): string {
  if (recent) return brief.lastProgressAt ? `形成关键进展 · ${formatAge(brief.lastProgressAt)}` : '最近形成关键进展';
  if (brief.presentationState === 'needs_user') {
    const attention = brief.attention[0]?.label ?? '有一项内容需要你处理';
    const runningNames = brief.currentExecutions
      .filter((item) => item.confidence === 'confirmed')
      .slice(0, 2)
      .map((item) => resolveCatName(item.catId));
    return runningNames.length > 0 ? `${attention} · ${runningNames.join('、')}仍在推进` : attention;
  }
  if (brief.presentationState === 'waiting_external') return brief.waits[0]?.label ?? '正在等待外部条件';
  if (brief.presentationState === 'running') {
    const names = brief.currentExecutions.slice(0, 2).map((item) => resolveCatName(item.catId));
    return `${names.join('、') || '一只猫'}正在推进`;
  }
  return brief.currentExecutions.some((item) => item.confidence === 'degraded') ? '状态确认中' : '暂时无法确认';
}

function stateLabel(state: ThreadBriefPresentationState): string {
  if (state === 'needs_user') return '需要你';
  if (state === 'running') return '推进中';
  if (state === 'waiting_external') return '等待外部';
  return '状态确认中';
}

function formatAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function RecentEmptyState() {
  return (
    <div className="rounded-xl bg-cafe-surface-sunken p-5">
      <p className="text-sm font-medium">近况为空</p>
      <p className="mt-2 text-xs leading-5 text-cafe-muted">
        只有当前事实或关键进展回执会让会话出现在这里；不会因为旧消息、参与猫或陈旧待办自动入选。
      </p>
    </div>
  );
}
