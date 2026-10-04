'use client';
import { useMemo, useState } from 'react';
import { groupHumanBrakes } from './brake-model';
import { MemoryBrakeCard } from './MemoryBrakeCard';
import { MemoryReadState } from './MemoryReadState';
import { useBrakes } from './use-brakes';

export function MemoryBrakes() {
  const [days, setDays] = useState(30);
  const data = useBrakes(days);
  const [word, setWord] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => groupHumanBrakes(data.events), [data.events]);
  const words = [...new Set(rows.flatMap((row) => row.words))];
  const filtered = word ? rows.filter((row) => row.words.includes(word)) : rows;
  const current = filtered.find((row) => row.key === selected) ?? filtered[0];
  return (
    <section className="space-y-5" aria-label="拉闸记录">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display-sm font-medium">拉闸记录</h1>
          <p className="mt-2 text-sm text-cafe-muted">
            你用拉闸词叫停或提醒猫的每一次。同一条消息里的几个词合成一条，点开能回到原消息。
          </p>
        </div>
        <select
          aria-label="拉闸时间范围"
          value={days}
          onChange={(event) => {
            setDays(Number(event.target.value));
            setWord(null);
          }}
          className="rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2 text-compact"
        >
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
          <option value={0}>全部时间</option>
        </select>
      </header>
      {(rows.length > 0 || (!data.loading && !data.error)) && (
        <fieldset className="flex flex-wrap gap-2" aria-label="拉闸词筛选">
          {[null, ...words].map((item) => (
            <button
              type="button"
              key={item ?? 'all'}
              aria-pressed={word === item}
              onClick={() => setWord(item)}
              className={`rounded-lg border border-cafe-subtle px-3 py-2 text-compact ${word === item ? 'bg-cafe-surface-sunken' : 'bg-[var(--console-card-bg)]'}`}
            >
              {item ?? '全部'} {item ? rows.filter((row) => row.words.includes(item)).length : `${rows.length} 条消息`}
            </button>
          ))}
        </fieldset>
      )}
      <MemoryReadState
        loading={data.loading && !rows.length}
        error={data.error && !rows.length}
        empty={!filtered.length && !data.loading && !data.error}
        noun="拉闸记录"
        retry={data.retry}
      />
      {data.error && rows.length > 0 && (
        <p role="alert" className="text-sm text-cafe-muted">
          部分读到：较早的拉闸暂时读不到。
          <button type="button" onClick={data.retry} className="ml-2 text-cafe-accent underline">
            重试
          </button>
        </p>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {filtered.map((row) => (
            <MemoryBrakeCard
              key={row.key}
              row={row}
              active={current?.key === row.key}
              onSelect={() => setSelected(row.key)}
            />
          ))}
        </div>
        {current && (
          <div className="xl:sticky xl:top-0">
            <MemoryBrakeCard
              key={current.key}
              row={current}
              active={false}
              onSelect={() => setSelected(current.key)}
              detail
            />
          </div>
        )}
      </div>
      {data.hasMore && (
        <button
          type="button"
          disabled={data.loading}
          onClick={data.loadMore}
          className="rounded-lg border border-cafe-subtle px-4 py-2 text-compact"
        >
          {data.loading ? '正在读取较早的记录…' : '读取更多拉闸记录'}
        </button>
      )}
      <p className="text-xs text-cafe-muted">
        {data.hasMore ? '以上计数只包含已加载的消息。' : ''}词表或引用等低置信事件不计入拉闸。
      </p>
    </section>
  );
}
