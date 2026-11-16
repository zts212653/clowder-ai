import type { WatcherDailyMetric } from '@cat-cafe/shared';
import { type DailyDisplayRow, hasRequestFacts } from './watcher-daily-pages';

interface Entry {
  id: string;
  title: string;
  startedAt?: number;
  endedAt?: number;
  metrics: Partial<Record<WatcherDailyMetric, number | null>>;
}
const labels = {
  inputTokens: '已报输入',
  outputTokens: '已报输出',
  cacheReadTokens: '已报缓存读取',
  cacheCreationTokens: '已报缓存新建',
  rewrittenTokens: '已报重写',
  workingContextTokens: '预算上界记录',
} as const;

export function WatcherDailyUnattributed({ rows, timezone }: { rows: readonly DailyDisplayRow[]; timezone: string }) {
  const entries: Entry[] = rows.flatMap((row): Entry[] =>
    hasRequestFacts(row)
      ? row.unattributedLegacy.map((part) => ({
          id: part.invocationId,
          title: row.title ?? row.threadId,
          startedAt: part.startedAt,
          endedAt: part.endedAt,
          metrics: part.usages[0] ?? {},
        }))
      : [{ id: `旧接口对话汇总：${row.threadId}`, title: row.title ?? row.threadId, metrics: row }],
  );
  if (entries.length === 0) return null;
  const time = (at: number | undefined) =>
    at === undefined ? '未记录' : new Date(at).toLocaleString('zh-CN', { timeZone: timezone });
  return (
    <details
      className="mt-3 rounded border border-cafe px-3 py-2 text-xs text-cafe-secondary"
      data-testid="watcher-unattributed-usage"
    >
      <summary className="cursor-pointer">日期归属未知的整轮 / 旧版汇总（{entries.length}）</summary>
      <p className="mt-2">以下保留整轮已报数，不计入本日小计；请求数及缺报仍未知。</p>
      {entries.map((entry) => (
        <div key={entry.id} className="mt-2 border-t border-cafe pt-2">
          <p>{entry.title}</p>
          <p className="mt-1 break-all text-cafe-muted">记录：{entry.id}</p>
          <p className="mt-1 text-cafe-muted">
            起始：{time(entry.startedAt)}；结束：{time(entry.endedAt)}（{timezone}）
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {Object.entries(labels).map(([key, label]) => {
              const value = entry.metrics[key as WatcherDailyMetric];
              return (
                <span key={key}>
                  {label} {value === null || value === undefined ? '未知' : value.toLocaleString('zh-CN')}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </details>
  );
}
