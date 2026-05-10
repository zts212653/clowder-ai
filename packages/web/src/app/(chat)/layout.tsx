'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { CHAT_THREAD_ROUTE_EVENT, getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';
import { CallbackAuthSnapshotMount } from '@/stores/callbackAuthStore';

function getThreadRouteSnapshot(): string {
  if (typeof window === 'undefined') return 'default';
  return getThreadIdFromPathname(window.location.pathname);
}

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pathnameThreadId = getThreadIdFromPathname(pathname ?? '');
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

  const threadId = (() => {
    if (browserThreadId !== null) return browserThreadId;
    if (immediateBrowserThreadId !== null) return immediateBrowserThreadId;
    return pathnameThreadId;
  })();

  return (
    <>
      {/*
        F174 D2b-2 + cloud P2 #1403 (round 10): mount the callback-auth snapshot
        provider as a render-isolated null leaf so the 30s poll tick re-render
        stays inside this component instead of bubbling through ChatLayout →
        ChatContainer → thread tree.
      */}
      <CallbackAuthSnapshotMount />
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
