'use client';
import { useCallback, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { MemoryRecallFlow } from './MemoryRecallFlow';
import { MemoryRecallStats } from './MemoryRecallStats';
import { MemoryRecallTaste } from './MemoryRecallTaste';
import { isRecallLedger, type RecallLedger } from './recall-page-types';
import { isTasteBrowse, type TasteBrowse } from './taste-types';
import { useMemoryRead } from './use-memory-read';
import { useMemoryRecall } from './use-memory-recall';

export function MemoryRecall() {
  const [days, setDays] = useState(7);
  const [source, setSource] = useState('all');
  const [catId, setCatId] = useState('');
  const { cats } = useCatData();
  const validateLedger = useCallback(
    (value: unknown): value is RecallLedger => isRecallLedger(value) && value.days === days,
    [days],
  );
  const ledger = useMemoryRead<RecallLedger>(`/api/memory/recall/stats?days=${days}`, validateLedger);
  const taste = useMemoryRead<TasteBrowse>('/api/memory/taste', isTasteBrowse);
  const feed = useMemoryRecall(days, source, catId);
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display-sm">召回记录</h1>
        <fieldset className="inline-flex rounded-lg border border-cafe-subtle p-1" aria-label="统计和流水的时间窗">
          {[7, 14, 30].map((window) => (
            <button
              key={window}
              type="button"
              aria-pressed={days === window}
              onClick={() => setDays(window)}
              className={`rounded-md px-3 py-1.5 text-compact ${days === window ? 'bg-cafe-surface-sunken font-medium' : 'text-cafe-muted'}`}
            >
              近 {window} 天
            </button>
          ))}
        </fieldset>
      </div>
      <MemoryRecallStats days={days} ledger={ledger} taste={taste} />
      <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="mr-auto text-base font-medium">所有对话的召回流水</h2>
            <label className="text-xs text-cafe-muted">
              来源
              <select
                aria-label="筛选召回来源"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className="ml-2 rounded-md border border-cafe-subtle bg-[var(--console-card-bg)] p-2 text-compact text-cafe-black"
              >
                <option value="all">全部来源</option>
                <option value="pull">猫发起的检索</option>
                <option value="push">系统递送</option>
              </select>
            </label>
            <label className="text-xs text-cafe-muted">
              猫
              <select
                aria-label="筛选猫"
                value={catId}
                onChange={(event) => setCatId(event.target.value)}
                className="ml-2 rounded-md border border-cafe-subtle bg-[var(--console-card-bg)] p-2 text-compact text-cafe-black"
              >
                <option value="">全部猫</option>
                {cats.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.nickname || cat.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <MemoryRecallFlow feed={feed} />
        </div>
        <aside className="min-w-0">
          <MemoryRecallTaste taste={taste} />
        </aside>
      </div>
    </div>
  );
}
