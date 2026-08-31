'use client';

import type { ThreadBriefV1 } from '@cat-cafe/shared';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useThreadBrief } from '@/hooks/useThreadBrief';

interface ThreadProgressCardProps {
  readonly threadId: string;
  readonly onOpenProgress: () => void;
}

export function ThreadProgressCard({ threadId, onOpenProgress }: ThreadProgressCardProps) {
  const { brief, loading, error } = useThreadBrief(threadId);
  const { getCatById } = useCatData();
  const isDesktop = useIsDesktop();
  const [density, setDensity] = usePersistedState('cat-cafe:thread-progress-density', -1);
  const collapsed = density === -1 ? !isDesktop : density === 0;
  const resolveCatName = (catId: string) => {
    const cat = getCatById(catId);
    return cat ? formatCatName(cat) : '一只猫';
  };

  return (
    <ThreadProgressCardView
      brief={brief}
      loading={loading}
      error={error}
      collapsed={collapsed}
      resolveCatName={resolveCatName}
      onToggle={() => setDensity(collapsed ? 1 : 0)}
      onOpenProgress={onOpenProgress}
    />
  );
}

export interface ThreadProgressCardViewProps {
  readonly brief: ThreadBriefV1 | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly collapsed: boolean;
  readonly resolveCatName: (catId: string) => string;
  readonly onToggle: () => void;
  readonly onOpenProgress: () => void;
}

export function ThreadProgressCardView({
  brief,
  loading,
  error,
  collapsed,
  resolveCatName,
  onToggle,
  onOpenProgress,
}: ThreadProgressCardViewProps) {
  const needsUser = brief?.presentationState === 'needs_user';
  const status = cardStatusText(brief, error, loading, resolveCatName);
  const runningWhileNeedsUser = needsUser ? confirmedActorText(brief, resolveCatName) : null;

  return (
    <section
      className={`console-divider-b bg-cafe-surface/35 ${collapsed ? 'h-10' : 'min-h-[84px]'}`}
      aria-label="会话进度"
      data-testid="thread-progress-card"
      data-density={collapsed ? 'collapsed' : 'summary'}
      data-state={brief?.presentationState ?? (error ? 'unknown' : 'loading')}
    >
      <div className="flex h-10 items-center gap-2 px-4 text-xs">
        <ProgressStateDot needsUser={needsUser} />
        <span className="min-w-0 flex-1 truncate font-medium text-cafe-black">{status}</span>
        {runningWhileNeedsUser && (
          <span className="shrink-0 text-micro text-cafe-muted">{runningWhileNeedsUser}仍在推进</span>
        )}
        <NeedsUserBadge visible={needsUser} />
        <button
          type="button"
          className="rounded-md px-2 py-1 text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-black"
          onClick={onOpenProgress}
        >
          查看完整进展
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-black"
          aria-label={collapsed ? '展开会话进度摘要' : '收起会话进度摘要'}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronIcon expanded={!collapsed} />
        </button>
      </div>
      <ProgressSummary brief={brief} collapsed={collapsed} />
    </section>
  );
}

function cardStatusText(
  brief: ThreadBriefV1 | null,
  error: boolean,
  loading: boolean,
  resolveCatName: (catId: string) => string,
): string {
  if (error) return '暂时无法确认';
  if (loading && !brief) return '正在读取会话进度';
  if (brief) return statusText(brief, resolveCatName);
  return '正在读取会话进度';
}

function ProgressStateDot({ needsUser }: { needsUser: boolean }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${needsUser ? 'bg-[var(--semantic-warning)]' : 'bg-[var(--semantic-info)]'}`}
      aria-hidden="true"
    />
  );
}

function NeedsUserBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span className="rounded-md bg-[var(--semantic-warning-surface)] px-2 py-0.5 font-medium text-[var(--semantic-warning)]">
      需要你
    </span>
  );
}

function ProgressSummary({ brief, collapsed }: { brief: ThreadBriefV1 | null; collapsed: boolean }) {
  if (collapsed) return null;
  const recent = brief?.recentProgress[0]?.headline ?? (brief?.hasHistory === false ? '还没有关键进展记录' : '');
  const next = brief?.nextStep ?? '下一步尚未明确';
  const action = brief?.currentExecutions[0]?.action;
  return (
    <div className="grid min-h-11 grid-cols-1 gap-x-6 gap-y-1 px-4 pb-2 text-xs md:grid-cols-2">
      <p className="truncate text-cafe-secondary">
        <span className="text-cafe-muted">最近：</span>
        {recent || '暂时无法读取'}
      </p>
      <p className="truncate text-cafe-secondary">
        <span className="text-cafe-muted">下一步：</span>
        {next}
      </p>
      {action && (
        <p className="truncate text-cafe-secondary md:col-span-2">
          <span className="text-cafe-muted">当前动作：</span>
          {action}
        </p>
      )}
    </div>
  );
}

function statusText(brief: ThreadBriefV1, resolveCatName: (catId: string) => string): string {
  if (brief.presentationState === 'needs_user') return brief.attention[0]?.label ?? '有一项内容需要你处理';
  if (brief.presentationState === 'waiting_external') return brief.waits[0]?.label ?? '正在等待外部条件';
  if (brief.presentationState === 'idle') return '当前无人执行';
  const confirmed = brief.currentExecutions.filter((execution) => execution.confidence === 'confirmed');
  if (brief.presentationState === 'running' && confirmed.length > 0) {
    const names = confirmed.slice(0, 2).map((execution) => resolveCatName(execution.catId));
    const remainder = confirmed.length - names.length;
    return `${names.join('、')}正在推进${remainder > 0 ? `，另有 ${remainder} 只猫` : ''}`;
  }
  if (brief.currentExecutions.some((execution) => execution.confidence === 'degraded')) return '状态确认中';
  return '暂时无法确认';
}

function confirmedActorText(brief: ThreadBriefV1 | null, resolveCatName: (catId: string) => string): string | null {
  const names = brief?.currentExecutions
    .filter((execution) => execution.confidence === 'confirmed')
    .slice(0, 2)
    .map((execution) => resolveCatName(execution.catId));
  return names && names.length > 0 ? names.join('、') : null;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
