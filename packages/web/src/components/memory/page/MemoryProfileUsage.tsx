import { type ProfileUsageSummary, profileUsageSummarySchema } from '@cat-cafe/shared';
import Link from 'next/link';
import { useCatData } from '@/hooks/useCatData';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

const isUsage = (value: unknown): value is ProfileUsageSummary => profileUsageSummarySchema.safeParse(value).success;

export function MemoryProfileUsage({ endpoint }: { endpoint: string }) {
  const usage = useMemoryRead(endpoint, isUsage);
  const { cats } = useCatData();
  if (usage.loading) return <p className="text-xs text-cafe-muted">正在读取使用次数…</p>;
  if (usage.error || !usage.data)
    return (
      <p className="text-xs text-cafe-muted">
        次数暂时读不到 ·{' '}
        <button type="button" onClick={usage.retry} className="shell-focusable underline">
          重读次数
        </button>
      </p>
    );
  const { currentVersion, allVersions, recent, directReadRecordedSince, earliestRecordedAt, openingMode } = usage.data;
  return (
    <div className="space-y-2 text-xs text-cafe-muted">
      <p>当前版本 · 已记录</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-cafe">
        {openingMode === 'on_demand' && currentVersion.opening === 0 ? (
          <span>按需回看 · 不自动带上</span>
        ) : (
          <span>新对话带上 {currentVersion.opening} 次</span>
        )}
        <span>被猫翻到 {currentVersion.read} 次</span>
      </p>
      <p>次数只表示带上或读到，不代表实际采用。未留存的历史未知。</p>
      <details className="space-y-2">
        <summary className="shell-focusable cursor-pointer">统计范围与原使用记录</summary>
        <p>
          直接读取从 {formatMemoryDate(directReadRecordedSince)} 起留存。更早的记录可能不完整，0 表示没有已记录的次数。
        </p>
        {earliestRecordedAt !== null && <p>现存记录最早可追溯至 {formatMemoryDate(earliestRecordedAt)}。</p>}
        <p>
          之前版本：新对话带上 {allVersions.opening - currentVersion.opening} 次 · 被猫翻到{' '}
          {allVersions.read - currentVersion.read} 次。
        </p>
        {recent.length > 0 ? (
          <ul className="space-y-2">
            {recent.map((event) => {
              const cat = cats.find((item) => item.id === event.catId);
              return (
                <li key={event.eventId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {formatMemoryDate(event.occurredAt)} · {cat?.nickname || cat?.displayName || '猫'} ·{' '}
                    {event.kind === 'opening' ? '新对话带上' : '翻到这份画像'}
                  </span>
                  {event.threadId && (
                    <Link
                      className="shell-focusable text-cafe-accent underline"
                      href={`/thread/${encodeURIComponent(event.threadId)}`}
                    >
                      查看对话
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>当前版本还没有使用记录。</p>
        )}
        {recent.length === 10 && <p>这里显示当前版本最近 10 条，次数包含全部已留存记录。</p>}
      </details>
    </div>
  );
}
