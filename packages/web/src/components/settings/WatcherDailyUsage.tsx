'use client';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface Row {
  threadId: string;
  title?: string;
  count: number;
  wakeIds: string[];
  modelAttempts: number;
  failed: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  rewrittenTokens: number | null;
  workingContextTokens: number | null;
}
interface Page {
  rows: Row[];
  hasMore: boolean;
  nextCursor: number;
}
const value = (n: number | null) => (n === null ? '未知' : n.toLocaleString('zh-CN'));
function mergeRows(previous: Row[], additions: Row[]): Row[] {
  const rows = new Map(previous.map((row) => [row.threadId, { ...row }]));
  for (const row of additions) {
    const old = rows.get(row.threadId);
    if (!old) {
      rows.set(row.threadId, row);
      continue;
    }
    old.wakeIds = [...new Set([...old.wakeIds, ...row.wakeIds])];
    old.count = old.wakeIds.length;
    old.modelAttempts += row.modelAttempts;
    old.failed += row.failed;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'rewrittenTokens',
    ] as const)
      old[key] = old[key] === null || row[key] === null ? null : old[key] + row[key];
    old.workingContextTokens =
      old.workingContextTokens === null || row.workingContextTokens === null
        ? null
        : Math.max(old.workingContextTokens, row.workingContextTokens);
  }
  return [...rows.values()];
}
export function WatcherDailyUsage() {
  const [day, setDay] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(more = false) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/watcher/daily?day=${day}&timezone=${encodeURIComponent(timezone)}${more && page ? `&cursor=${page.nextCursor}` : ''}`,
      );
      if (!response.ok) throw new Error('读取每日用量失败');
      const next: Page = await response.json();
      setPage({ ...next, rows: more && page ? mergeRows(page.rows, next.rows) : next.rows });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="rounded-lg border border-cafe px-3 py-2"
      onToggle={(event) => {
        if (event.currentTarget.open && !page) void load();
      }}
    >
      <summary className="cursor-pointer text-sm text-cafe-secondary">每日用量</summary>
      <div className="mt-3 flex items-center gap-2 text-sm text-cafe-secondary">
        <label htmlFor="watcher-usage-day">日期（本地）</label>
        <input
          id="watcher-usage-day"
          type="date"
          value={day}
          disabled={loading}
          onChange={(event) => {
            setDay(event.target.value);
            setPage(null);
          }}
          className="rounded border border-cafe bg-cafe-surface px-2 py-1"
        />
        <button
          type="button"
          disabled={loading || !day}
          onClick={() => void load()}
          className="rounded px-2 py-1 text-cafe-primary"
        >
          查询
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="mt-2 text-sm text-cafe-muted">
          读取中…
        </p>
      )}
      {page && page.rows.length === 0 && <p className="mt-2 text-sm text-cafe-muted">这一天还没有守望记录</p>}
      {page && page.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs text-cafe-secondary">
            <thead>
              <tr>
                {[
                  '对话',
                  '醒来次数',
                  '模型调用',
                  '未完成',
                  '输入 token',
                  '输出 token',
                  '缓存命中',
                  '重写 token',
                  '新建缓存 token',
                  '上下文上界',
                ].map((title) => (
                  <th key={title} className="whitespace-nowrap px-2 py-2 font-medium">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.threadId}>
                  <td className="max-w-44 truncate px-2 py-2" title={row.threadId}>
                    {row.title ?? row.threadId}
                  </td>
                  <td className="px-2 py-2">{row.count}</td>
                  <td className="px-2 py-2">{row.modelAttempts}</td>
                  <td className="px-2 py-2">{row.failed}</td>
                  <td className="px-2 py-2">{value(row.inputTokens)}</td>
                  <td className="px-2 py-2">{value(row.outputTokens)}</td>
                  <td className="px-2 py-2">
                    {row.inputTokens === null || row.cacheReadTokens === null || row.inputTokens === 0
                      ? '未知'
                      : `${((row.cacheReadTokens / row.inputTokens) * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-2 py-2">{value(row.rewrittenTokens)}</td>
                  <td className="px-2 py-2">{value(row.cacheCreationTokens)}</td>
                  <td className="px-2 py-2">{value(row.workingContextTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.hasMore && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(true)}
              className="mt-2 text-xs text-cafe-primary"
            >
              加载更多记录
            </button>
          )}
        </div>
      )}
    </details>
  );
}
