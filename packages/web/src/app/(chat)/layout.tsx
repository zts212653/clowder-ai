'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  subscribeBrowserThreadRoute,
} from '@/components/ThreadSidebar/thread-navigation';
import { resolveLayoutThreadId } from './layout-thread-id';

function getThreadRouteSnapshot(): string {
  return getThreadIdFromPathname(getBrowserThreadRoutePathname());
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
    return subscribeBrowserThreadRoute(syncBrowserRoute);
  }, []);
  const threadId = resolveLayoutThreadId(pathnameThreadId, browserThreadId, immediateBrowserThreadId);

  return (
    <>
      {/* CallbackAuthSnapshotMount moved to AppShell — it needs to be available
          on all routes (settings, memory, etc.), not just chat. */}
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
