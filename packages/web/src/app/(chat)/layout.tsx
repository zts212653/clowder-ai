'use client';

import { useSyncExternalStore } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { CHAT_THREAD_ROUTE_EVENT, getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';

function subscribeToThreadRoute(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener(CHAT_THREAD_ROUTE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener(CHAT_THREAD_ROUTE_EVENT, onStoreChange);
  };
}

function getThreadRouteSnapshot(): string {
  if (typeof window === 'undefined') return 'default';
  return getThreadIdFromPathname(window.location.pathname);
}

/**
 * Shared layout for "/" and "/thread/[threadId]".
 *
 * By placing ChatContainer here instead of in each page, it stays mounted
 * across thread switches — no unmount/remount flicker, no scroll-position
 * loss, and socket/state survives navigation.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const threadId = useSyncExternalStore(subscribeToThreadRoute, getThreadRouteSnapshot, () => 'default');

  return (
    <>
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
