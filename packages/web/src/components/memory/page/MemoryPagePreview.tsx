'use client';
import Link from 'next/link';
import { parseIndexStatus } from '../IndexStatus';
import { MemoryBrakes } from './MemoryBrakes';
import { MemoryLibrary } from './MemoryLibrary';
import { MemoryNavigation } from './MemoryNavigation';
import { MemoryProfile } from './MemoryProfile';
import { MemoryRecall } from './MemoryRecall';
import { MemorySearch, MemorySearchBox } from './MemorySearch';
import { type MaintenanceData, MemoryStatusLine } from './MemoryStatus';
import { MemoryTaste } from './MemoryTaste';
import type { ProfileSourceTarget } from './profile-source-target';
import { useMemoryRead } from './use-memory-read';
import { useMemorySearch } from './use-memory-search';

const ignoreReadSummary = () => {};

export type MemoryPageTab = 'all' | 'recall' | 'brakes' | 'library';
const TABS = [
  { id: 'all', label: '全部记忆' },
  { id: 'recall', label: '召回记录' },
  { id: 'brakes', label: '拉闸记录' },
  { id: 'library', label: '资料库' },
] as const;

export function MemoryPagePreview({
  tab,
  shell,
  basePath = '/memory/preview',
  from,
  profileSource,
  initialQuery,
  findSessionId,
}: {
  tab: MemoryPageTab;
  shell?: string;
  basePath?: '/memory' | '/memory/preview';
  from?: string | null;
  profileSource?: ProfileSourceTarget;
  initialQuery?: string;
  findSessionId?: string | null;
}) {
  const search = useMemorySearch(initialQuery);
  const rawIndex = useMemoryRead<Parameters<typeof parseIndexStatus>[0]>('/api/evidence/status');
  const index = { ...rawIndex, data: rawIndex.data ? parseIndexStatus(rawIndex.data) : null };
  const maintenance = useMemoryRead<MaintenanceData>('/api/memory/maintenance');
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--console-shell-bg)] text-cafe"
      data-testid="memory-page-preview"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-cafe-subtle px-4 py-3 md:px-8">
        <MemoryNavigation from={from} findSessionId={findSessionId} />
        <span className="text-base font-medium">记忆</span>
        <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="记忆页标签">
          {TABS.map((item) => (
            <Link
              key={item.id}
              href={`${basePath}?tab=${item.id}${shell ? `&shell=${encodeURIComponent(shell)}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}${findSessionId ? `&findSession=${encodeURIComponent(findSessionId)}` : ''}`}
              aria-current={search.query === null && tab === item.id ? 'page' : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${search.query === null && tab === item.id ? 'bg-cafe-surface-sunken font-medium' : 'text-cafe-muted'}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3 md:ml-auto">
          <MemorySearchBox search={search} />
          <MemoryStatusLine index={index} maintenance={maintenance} />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
        {search.query !== null ? (
          <MemorySearch key={`${search.query}:${search.type}:${search.depth}`} search={search} />
        ) : profileSource?.status === 'invalid' ? (
          <output className="block text-sm text-cafe-muted">来源链接不完整，请从记忆页重新打开。</output>
        ) : profileSource ? (
          <MemoryProfile
            key={`${profileSource.id}:${profileSource.revision}`}
            target={profileSource}
            onReadSummary={ignoreReadSummary}
          />
        ) : tab === 'brakes' ? (
          <MemoryBrakes />
        ) : tab === 'library' ? (
          <MemoryLibrary index={index} maintenance={maintenance} />
        ) : tab === 'all' ? (
          <MemoryTaste />
        ) : (
          <MemoryRecall />
        )}
      </main>
    </div>
  );
}
