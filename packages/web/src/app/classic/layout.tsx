'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import {
  CHAT_THREAD_ROUTE_EVENT,
  CLASSIC_WORLD_PREFIX,
  getThreadIdFromPathname,
} from '@/components/ThreadSidebar/thread-navigation';
import { getThreadRouteSnapshot, resolveLayoutThreadId } from './route-state';

export default function ClassicLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pathnameThreadId = getThreadIdFromPathname(pathname ?? '', CLASSIC_WORLD_PREFIX);
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
