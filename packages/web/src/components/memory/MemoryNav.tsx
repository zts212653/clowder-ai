import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';

export type MemoryTab = 'feed' | 'search' | 'status' | 'health';

interface MemoryNavProps {
  readonly active: MemoryTab;
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
export function buildBackHref(referrerThread: string | null): string {
  return referrerThread && referrerThread !== 'default' ? `/thread/${referrerThread}` : '/';
}

/**
 * Pure: build tab items with optional fromSuffix.
 */
export function buildMemoryTabItems(fromSuffix: string): readonly TabConfig[] {
  return [
    { id: 'feed', href: `/memory${fromSuffix}`, label: 'Knowledge Feed' },
    { id: 'search', href: `/memory/search${fromSuffix}`, label: 'Search' },
    { id: 'status', href: `/memory/status${fromSuffix}`, label: 'Index Status' },
    { id: 'health', href: `/memory/health${fromSuffix}`, label: 'Health' },
  ];
}

function useReferrerThread(): string | null {
  const storeThreadId = useChatStore((s) => s.currentThreadId);
  const [fromParam, setFromParam] = useState<string | null>(null);
  useEffect(() => {
    setFromParam(new URLSearchParams(window.location.search).get('from'));
  }, []);
  return useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
}

export function MemoryNav({ active }: MemoryNavProps) {
  const referrerThread = useReferrerThread();
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';

  const items = useMemo(() => buildMemoryTabItems(fromSuffix), [fromSuffix]);
  const backHref = buildBackHref(referrerThread);

  return (
    <nav aria-label="Memory navigation" className="flex items-center gap-2">
      <a
        href={backHref}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[#D8C6AD] bg-[#FCF7EE] px-3 py-1.5 text-xs font-medium text-[#8B6F47] transition-colors hover:bg-[#F7EEDB]"
        data-testid="memory-back-to-chat"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        返回对话
      </a>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
              isActive
                ? 'border-cocreator-primary bg-cocreator-light text-cocreator-dark'
                : 'border-cafe bg-cafe-surface text-cafe-secondary hover:border-cocreator-light hover:text-cocreator-dark',
            ].join(' ')}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
