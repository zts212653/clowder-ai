'use client';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { WatcherDailyUnattributed } from './WatcherDailyUnattributed';
import {
  cacheRatioText,
  contextBudgetText,
  metricText,
  requestCountText,
  usageCoverageText,
} from './watcher-daily-format';
import { type DailyPage, dailyDisplayRows, replaceDailyPage } from './watcher-daily-pages';

export function WatcherDailyUsage() {
  const [day, setDay] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [pages, setPages] = useState<DailyPage[]>([]);
  const page = pages.at(-1);
  const rows = dailyDisplayRows(pages);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function readPage(cursor?: number): Promise<DailyPage> {
    const response = await apiFetch(
      `/api/watcher/daily?day=${day}&timezone=${encodeURIComponent(timezone)}${cursor === undefined ? '' : `&cursor=${cursor}`}`,
    );
    if (!response.ok) throw new Error('读取每日用量失败');
    return response.json();
  }
  async function load(more = false) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      let next = await readPage(more && page ? page.nextCursor : undefined);
      const previous = more ? pages : [];
      if (previous.length > 0 && previous[0]?.usageVersion !== next.usageVersion) {
        // One bounded restart avoids combining incompatible page contracts during an API upgrade.
        next = await readPage();
        setPages([next]);
      } else {
        setPages(replaceDailyPage(previous, next));
      }
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
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-cafe-secondary">
        <label htmlFor="watcher-usage-day">日期（本地）</label>
        <input
          id="watcher-usage-day"
          type="date"
          value={day}
          disabled={loading}
          onChange={(event) => {
            setDay(event.target.value);
            setPages([]);
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
      {page?.hasMore && (
        <p role="status" className="mt-2 text-sm text-cafe-muted">
          仅已加载部分记录，尚非全日汇总；请继续加载。
        </p>
      )}
      {page && rows.length === 0 && !page.hasMore && (
        <p className="mt-2 text-sm text-cafe-muted">
          本次未找到可归日记录；旧整轮汇总可能列在执行起始日，不能据此认定历史请求为零。
        </p>
      )}
      {page && rows.length > 0 && (
        <div className="mt-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-left text-xs text-cafe-secondary">
              <thead>
                <tr>
                  {[
                    '对话',
                    '醒来次数',
                    '模型调用',
                    '未成功执行',
                    '用量记录',
                    '输入 token（含缓存）',
                    '输出 token',
                    '缓存读取 token / 占比',
                    '重写 token',
                    '新建缓存 token',
                    '已记录请求预算上界（最大值）',
                  ].map((title) => (
                    <th key={title} className="whitespace-nowrap px-2 py-2 font-medium">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.threadId}>
                    <td className="max-w-44 truncate px-2 py-2" title={row.threadId}>
                      {row.title ?? row.threadId}
                    </td>
                    <td className="px-2 py-2">{row.count}</td>
                    <td className="px-2 py-2">{requestCountText(row)}</td>
                    <td className="px-2 py-2" title="已结算的失败或取消执行，不是等待中">
                      {row.failed}
                    </td>
                    <td className="px-2 py-2">{usageCoverageText(row, page.hasMore)}</td>
                    <td className="px-2 py-2">{metricText(row, 'inputTokens', page.hasMore)}</td>
                    <td className="px-2 py-2">{metricText(row, 'outputTokens', page.hasMore)}</td>
                    <td className="px-2 py-2">
                      <div>{metricText(row, 'cacheReadTokens', page.hasMore)}</div>
                      <div className="text-cafe-muted">{cacheRatioText(row, page.hasMore)}</div>
                    </td>
                    <td className="px-2 py-2">{metricText(row, 'rewrittenTokens', page.hasMore)}</td>
                    <td className="px-2 py-2">{metricText(row, 'cacheCreationTokens', page.hasMore)}</td>
                    <td className="px-2 py-2">{contextBudgetText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 max-w-prose text-xs text-cafe-muted">
            仅计可归日记录，输入含缓存。“至少”仅表示已报下界；日期不明的旧汇总另列。预算上界含估算输入和预留输出，不是实际用量，缺记录时也不是整日上界。未成功执行均已结算。
          </p>
        </div>
      )}
      <WatcherDailyUnattributed rows={rows} timezone={timezone} />
      {page?.hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(true)}
          className="mt-2 text-xs text-cafe-primary"
        >
          加载更多记录
        </button>
      )}
    </details>
  );
}
