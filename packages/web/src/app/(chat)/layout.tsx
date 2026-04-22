'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { CHAT_THREAD_ROUTE_EVENT, getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';

function getThreadRouteSnapshot(): string {
  if (typeof window === 'undefined') return 'default';
  return getThreadIdFromPathname(window.location.pathname);
}

export function resolveLayoutThreadId(
  pathnameThreadId: string,
  browserThreadId: string | null,
  immediateBrowserThreadId: string | null = null,
): string {
  if (browserThreadId !== null) return browserThreadId;
  if (immediateBrowserThreadId !== null) return immediateBrowserThreadId;
  return pathnameThreadId;
}

/**
 * Shared layout for "/" and "/thread/[threadId]".
 *
 * By placing ChatContainer here instead of in each page, it stays mounted
 * across thread switches — no unmount/remount flicker, no scroll-position
 * loss, and socket/state survives navigation.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pathnameThreadId = getThreadIdFromPathname(pathname ?? '');
  // Parent layouts can briefly see the default route during hard refresh; the
  // address bar is the authority before chat history effects are allowed to run.
  const immediateBrowserThreadId = typeof window !== 'undefined' ? getThreadRouteSnapshot() : null;
  const [browserThreadId, setBrowserThreadId] = useState<string | null>(null);
  useLayoutEffect(() => {
    const syncBrowserRoute = () => setBrowserThreadId(getThreadRouteSnapshot());
    syncBrowserRoute();
    window.addEventListener('popstate', syncBrowserRoute);
    window.addEventListener(CHAT_THREAD_ROUTE_EVENT, syncBrowserRoute);
    return () => {
      window.removeEventListener('popstate', syncBrowserRoute);
      window.removeEventListener(CHAT_THREAD_ROUTE_EVENT, syncBrowserRoute);
    };
  }, []);
  const threadId = resolveLayoutThreadId(pathnameThreadId, browserThreadId, immediateBrowserThreadId);

  return (
    <>
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
