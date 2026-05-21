import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getActionItems, type HealthReportData } from './HealthReport';

export type MemoryTab = 'feed' | 'search' | 'status' | 'health' | 'catalog' | 'graph';

interface MemoryNavProps {
  readonly active: MemoryTab;
  readonly initialReferrerThread?: string | null;
}

interface TabConfig {
  readonly id: MemoryTab;
  readonly href: string;
  readonly label: string;
  readonly badge?: number;
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
 * Pure: build tab items with optional fromSuffix and badge counts.
 */
export function buildMemoryTabItems(
  fromSuffix: string,
  badges?: Partial<Record<MemoryTab, number>>,
): readonly TabConfig[] {
  const base: TabConfig[] = [
    { id: 'feed', href: `/memory${fromSuffix}`, label: '知识动态' },
    { id: 'search', href: `/memory/search${fromSuffix}`, label: '搜索' },
    { id: 'status', href: `/memory/status${fromSuffix}`, label: '索引状态' },
    { id: 'health', href: `/memory/health${fromSuffix}`, label: '健康度' },
    { id: 'catalog', href: `/memory/catalog${fromSuffix}`, label: '图书馆' },
    { id: 'graph', href: `/memory/graph${fromSuffix}`, label: '知识图谱' },
  ];
  if (!badges) return base;
  return base.map((tab) => {
    const count = badges[tab.id];
    return count ? { ...tab, badge: count } : tab;
  });
}

function useReferrerThread(initialReferrerThread: string | null): string | null {
  const storeThreadId = useChatStore((s) => s.currentThreadId);
  const [fromParam, setFromParam] = useState<string | null>(initialReferrerThread);
  useEffect(() => {
    const nextFromParam = new URLSearchParams(window.location.search).get('from');
    setFromParam(nextFromParam ?? initialReferrerThread);
  }, [initialReferrerThread]);
  return useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
}

function useHealthBadgeCount(): number {
  const [count, setCount] = useState(0);
  const fetchCount = useCallback(async () => {
    try {
      const res = await apiFetch('/api/f163/health-report');
      if (!res.ok) return;
      const data = (await res.json()) as HealthReportData;
      setCount(getActionItems(data).length);
    } catch {
      /* badge silently degrades to 0 */
    }
  }, []);
  useEffect(() => {
    fetchCount();
  }, [fetchCount]);
  return count;
}

export function MemoryNav({ active, initialReferrerThread = null }: MemoryNavProps) {
  const referrerThread = useReferrerThread(initialReferrerThread);
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';
  const healthIssueCount = useHealthBadgeCount();

  const badges = useMemo(() => (healthIssueCount > 0 ? { health: healthIssueCount } : undefined), [healthIssueCount]);
  const items = useMemo(() => buildMemoryTabItems(fromSuffix, badges), [fromSuffix, badges]);

  return (
    <nav aria-label="Memory navigation" className="flex flex-wrap items-center gap-2">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'inline-flex items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
              isActive
                ? 'border-[var(--console-border-strong)] bg-[var(--console-card-bg)] text-[var(--console-button-emphasis)]'
                : 'border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] text-cafe-secondary hover:border-[var(--console-border-strong)] hover:text-cafe',
            ].join(' ')}
          >
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span
                data-testid="health-badge"
                className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-micro font-bold leading-none text-white"
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
