'use client';
import { useEffect, useRef, useState } from 'react';
import { MemoryFamilyPane } from './MemoryFamilyPane';
import { MemoryReadState } from './MemoryReadState';
import { MemoryTasteCard } from './MemoryTasteCard';
import { MemoryTasteDetail } from './MemoryTasteDetail';
import { MemoryTasteSky } from './MemoryTasteSky';
import { MEMORY_FAMILIES, type MemoryFamily } from './memory-family';
import { isTasteBrowse, type TasteBrowse } from './taste-types';
import { useMemoryRead } from './use-memory-read';

export function MemoryTaste() {
  const list = useMemoryRead<TasteBrowse>('/api/memory/taste', isTasteBrowse);
  const host = useRef<HTMLDivElement>(null);
  const previousScroll = useRef(0);
  const [selectedId, selectId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [sort, setSort] = useState('recent');
  const [family, setFamily] = useState<MemoryFamily>('taste');
  const [peopleSummary, setPeopleSummary] = useState('可查看');
  const [profileSummary, setProfileSummary] = useState('可查看');
  const [entitiesSummary, setEntitiesSummary] = useState('可查看');
  const [eventsSummary, setEventsSummary] = useState('可查看');
  const entries = [...(list.data?.entries ?? [])].sort((a, b) =>
    sort === 'hits' ? (b.recall?.search?.hits ?? -1) - (a.recall?.search?.hits ?? -1) : b.when.localeCompare(a.when),
  );
  const selected = entries.find((entry) => entry.id === selectedId);
  useEffect(() => {
    const main = host.current?.closest('main');
    if (main) main.scrollTop = selectedId ? 0 : previousScroll.current;
  }, [selectedId]);
  const chooseFamily = (next: MemoryFamily) => {
    setFamily(next);
    if (next === 'profile') setExpanded(false);
  };
  const privateCount = entries.filter((entry) => entry.visibility === 'private').length;
  const reload = () => {
    selectId(null);
    list.retry();
  };
  return (
    <div ref={host}>
      <MemoryTasteSky
        expanded={expanded}
        countText={list.loading ? '正在读取' : list.error ? '暂时读不到' : `${entries.length} 条`}
        toggle={() => setExpanded((value) => !value)}
        peopleSummary={peopleSummary}
        onSelect={chooseFamily}
        summaries={{ profile: profileSummary, entity: entitiesSummary, event: eventsSummary }}
      />
      <div className="my-5 flex flex-wrap items-center gap-2 text-compact">
        <button
          type="button"
          onClick={() => chooseFamily('taste')}
          aria-pressed={family === 'taste'}
          className={`shell-focusable rounded-lg border px-3 py-2 ${family === 'taste' ? 'border-cafe-subtle bg-cafe-surface-sunken font-medium' : 'border-transparent text-cafe-muted'}`}
        >
          品味 {list.data && !list.loading && !list.error ? entries.length : ''}
        </button>
        {MEMORY_FAMILIES.filter((item) => item.id !== 'taste').map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => chooseFamily(item.id)}
            aria-pressed={family === item.id}
            className={`shell-focusable rounded-lg border px-3 py-2 ${family === item.id ? 'border-cafe-subtle bg-cafe-surface-sunken font-medium' : 'border-transparent text-cafe-muted'}`}
          >
            {item.label}
            {item.id === 'profile' && /^\d+ 条$/.test(profileSummary) ? ` ${profileSummary.replace(' 条', '')}` : ''}
          </button>
        ))}
        <span className="rounded-lg border border-dashed border-cafe-subtle px-2 py-1 text-xs text-cafe-muted">
          会议 · 还没接进来
        </span>
        {family === 'profile' && (
          <p className="text-xs text-cafe-muted">「关于你」每场新对话自动带上 · 其余画像按需回看</p>
        )}
        {family === 'taste' && (
          <>
            {privateCount > 0 && <span className="text-xs text-cafe-muted">含 {privateCount} 条只给你看</span>}
            <span className="text-xs text-cafe-muted">
              概括候选{entries.some((entry) => entry.takeawayCandidate) ? ' · 待你确认' : ' · 打开条目查看'}
            </span>
            <select
              aria-label="品味排序"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="ml-auto rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2 text-compact"
            >
              <option value="recent">最近记录</option>
              <option value="hits">检索命中最多</option>
            </select>
          </>
        )}
      </div>
      <MemoryFamilyPane
        family={family}
        summaries={{
          people: setPeopleSummary,
          profile: setProfileSummary,
          entities: setEntitiesSummary,
          events: setEventsSummary,
        }}
      >
        <MemoryReadState
          loading={list.loading}
          error={list.error}
          empty={entries.length === 0}
          noun="品味"
          retry={reload}
        />
        {list.data?.readStatus === 'partial' && (
          <output className="mb-4 block text-compact text-cafe-muted">
            部分读到：品味已读到，暂时读不到被想起记录。
            <button type="button" onClick={reload} className="ml-2 text-cafe-accent underline">
              重读
            </button>
          </output>
        )}
        {!list.loading && !list.error && entries.length > 0 && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <div className={`gap-3 ${selected ? 'hidden lg:grid' : 'contents'}`}>
              {entries.map((entry) => (
                <MemoryTasteCard
                  key={`${entry.id}@${entry.revision}`}
                  entry={entry}
                  selected={selected?.id === entry.id}
                  select={() => {
                    previousScroll.current = host.current?.closest('main')?.scrollTop ?? 0;
                    selectId(entry.id);
                    setExpanded(false);
                  }}
                />
              ))}
            </div>
            {selected && (
              <MemoryTasteDetail
                key={`${selected.id}@${selected.revision}`}
                entry={selected}
                close={() => selectId(null)}
                reload={reload}
              />
            )}
          </div>
        )}
      </MemoryFamilyPane>
    </div>
  );
}
