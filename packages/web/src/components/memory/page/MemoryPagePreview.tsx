'use client';
import Link from 'next/link';
import { parseIndexStatus } from '../IndexStatus';
import { MemoryBrakes } from './MemoryBrakes';
import { MemoryLibrary } from './MemoryLibrary';
import { type MaintenanceData, MemoryStatusLine } from './MemoryStatus';
import { MemoryTaste } from './MemoryTaste';
import { useMemoryRead } from './use-memory-read';

export type MemoryPageTab = 'all' | 'recall' | 'brakes' | 'library';
const TABS = [
  { id: 'all', label: '全部记忆' },
  { id: 'recall', label: '召回记录' },
  { id: 'brakes', label: '拉闸记录' },
  { id: 'library', label: '资料库' },
] as const;

export function MemoryPagePreview({ tab, shell }: { tab: MemoryPageTab; shell?: string }) {
  const rawIndex = useMemoryRead<Parameters<typeof parseIndexStatus>[0]>('/api/evidence/status');
  const index = { ...rawIndex, data: rawIndex.data ? parseIndexStatus(rawIndex.data) : null };
  const maintenance = useMemoryRead<MaintenanceData>('/api/memory/maintenance');
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--console-shell-bg)] text-cafe"
      data-testid="memory-page-preview"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-cafe-subtle px-4 py-3 md:px-8">
        <span className="text-base font-medium">记忆</span>
        <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="记忆页标签">
          {TABS.map((item) => (
            <Link
              key={item.id}
              href={`/memory/preview?tab=${item.id}${shell ? `&shell=${encodeURIComponent(shell)}` : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${tab === item.id ? 'bg-cafe-surface-sunken font-medium' : 'text-cafe-muted'}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3 md:ml-auto">
          <input
            aria-label="搜索记忆和资料"
            placeholder="搜索记忆、文档和对话"
            disabled
            className="w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2 text-sm md:w-60"
          />
          <span className="text-xs text-cafe-muted">搜索尚未接入</span>
          <MemoryStatusLine index={index} maintenance={maintenance} />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
        {tab === 'brakes' ? (
          <MemoryBrakes />
        ) : tab === 'library' ? (
          <MemoryLibrary index={index} maintenance={maintenance} />
        ) : tab === 'all' ? (
          <MemoryTaste />
        ) : (
          <section className="rounded-xl border border-dashed border-cafe-subtle p-6">
            <h1 className="text-display-sm">召回记录</h1>
            <p className="mt-3 text-sm text-cafe-muted">所有对话的召回记录还没接进来。</p>
            <p className="mt-2 text-compact text-cafe-muted">召回记录将在 Workspace 记忆合流后接入。</p>
          </section>
        )}
      </main>
    </div>
  );
}
