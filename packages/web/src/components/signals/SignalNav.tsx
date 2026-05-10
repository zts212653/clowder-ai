import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';

export type SignalNavItem = 'signals' | 'sources';

interface SignalNavProps {
  readonly active: SignalNavItem;
  readonly initialReferrerThread?: string | null;
}

interface ItemConfig {
  readonly id: SignalNavItem;
  readonly href: string;
  readonly label: string;
}

/**
 * Reads `?from=` URL param to determine the referrer thread.
 * Falls back to store's currentThreadId (last active thread).
 * Same pattern as MissionControlPage referrer-based back button.
 */
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

export function SignalNav({ active, initialReferrerThread = null }: SignalNavProps) {
  const referrerThread = useReferrerThread(initialReferrerThread);
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';
  const items: readonly ItemConfig[] = useMemo(
    () => [
      { id: 'signals' as const, href: `/signals${fromSuffix}`, label: '收件箱' },
      { id: 'sources' as const, href: `/signals/sources${fromSuffix}`, label: '信号源' },
    ],
    [fromSuffix],
  );

  return (
    <nav aria-label="Signal navigation" className="flex items-center gap-2">
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
