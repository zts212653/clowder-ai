'use client';
import type { MemorySearchRow } from './memory-search-types';

const AUTHORITY: Record<string, string> = {
  observed: '已观测',
  candidate: '候选',
  validated: '已验证',
  constitutional: '宪法级',
};
function resultDate(value: string | number | null, withTime: boolean) {
  if (value === null || value === '') return '时间没有记录下来';
  const calendar = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间没有记录下来';
  const year = calendar ? Number(calendar[1]) : date.getFullYear();
  const month = calendar ? Number(calendar[2]) : date.getMonth() + 1;
  const day = calendar ? Number(calendar[3]) : date.getDate();
  const prefix = year === new Date().getFullYear() ? '' : `${year} 年 `;
  const time =
    withTime && !calendar
      ? ` ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
      : '';
  return `${prefix}${month} 月 ${day} 日${time}`;
}
export function MemorySearchResult({
  row,
  onOpen,
  onGraph,
}: {
  row: MemorySearchRow;
  onOpen: (row: MemorySearchRow) => void;
  onGraph: (graph: NonNullable<MemorySearchRow['graph']>) => void;
}) {
  return (
    <article className="min-w-0 space-y-2 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-cafe-muted">
        <span className="rounded-md bg-cafe-surface-sunken px-2 py-1 text-cafe-secondary">{row.displayType}</span>
        {row.authority && <span>{AUTHORITY[row.authority] ?? '可信度没有记录'}</span>}
        <time>{resultDate(row.updatedAt, row.destination?.kind === 'message')}</time>
        {row.destination ? (
          <button type="button" onClick={() => onOpen(row)} className="ml-auto text-compact text-cafe-accent underline">
            打开 ↗
          </button>
        ) : (
          <span className="ml-auto">原文暂时读不到</span>
        )}
        <details className="relative">
          <summary aria-label={`更多操作：${row.title}`} className="cursor-pointer list-none px-2 text-base">
            ⋯
          </summary>
          <div className="absolute right-0 z-10 w-48 rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-3 shadow-sm">
            {row.graph ? (
              <button
                type="button"
                onClick={() => {
                  if (row.graph) onGraph(row.graph);
                }}
                className="text-compact text-cafe-accent"
              >
                查看关系图
              </button>
            ) : (
              <p className="text-compact text-cafe-muted">这类结果的关系图还没接进来</p>
            )}
          </div>
        </details>
      </div>
      <h2 className="break-words text-sm font-medium">{row.title || '标题没有记录下来'}</h2>
      <p className="whitespace-pre-wrap break-words text-compact leading-relaxed text-cafe-secondary">
        {row.snippet || '没有可读取的摘要'}
      </p>
    </article>
  );
}
