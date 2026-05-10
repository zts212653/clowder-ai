import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { getThreadHref } from '../ThreadSidebar/thread-navigation';

export type MemoryTab = 'feed' | 'search' | 'status';

interface MemoryNavProps {
  readonly active: MemoryTab;
  readonly initialReferrerThread?: string | null;
}

interface TabConfig {
  readonly id: MemoryTab;
  readonly href: string;
  readonly label: string;
}

/**
 * Pure: resolve referrer thread from URL search string + store fallback.
 * Exported for testing.
 */
export function resolveReferrerThread(urlSearch: string, storeThreadId: string | null): string | null {
  const fromParam = new URLSearchParams(urlSearch).get('from');
  if (fromParam) return fromParam;
  return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
}

/**
 * Pure: build back href from referrer thread.
 */
export function buildBackHref(referrerThread: string | null, prefix = ''): string {
  return getThreadHref(referrerThread ?? 'default', prefix);
}

/**
 * Pure: build tab items with optional fromSuffix.
 */
export function buildMemoryTabItems(fromSuffix: string): readonly TabConfig[] {
  return [
    { id: 'feed', href: `/memory${fromSuffix}`, label: '涌现 Feed' },
    { id: 'search', href: `/memory/search${fromSuffix}`, label: '知识检索' },
    { id: 'status', href: `/memory/status${fromSuffix}`, label: '索引状态' },
  ];
}

function useReferrerThread(initialReferrerThread: string | null): string | null {
  const storeThreadId = useChatStore((s) => s.currentThreadId);
  const [fromParam, setFromParam] = useState<string | null>(initialReferrerThread);
  useEffect(() => {
    const nextFromParam = new URLSearchParams(window.location.search).get('from');
    if (nextFromParam) setFromParam(nextFromParam);
  }, [initialReferrerThread]);
  return useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
}

export function MemoryNav({ active, initialReferrerThread = null }: MemoryNavProps) {
  const referrerThread = useReferrerThread(initialReferrerThread);
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';

  const items = useMemo(() => buildMemoryTabItems(fromSuffix), [fromSuffix]);

  return (
    <nav aria-label="Memory navigation" className="flex items-center gap-2">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'rounded-md px-2 py-[3px] text-[11px] font-semibold transition-colors',
              isActive
                ? 'bg-[var(--console-active-bg)] text-cafe-interactive'
                : 'bg-[var(--console-pill-bg,var(--console-card-soft-bg))] text-cafe-secondary hover:text-cafe',
            ].join(' ')}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
