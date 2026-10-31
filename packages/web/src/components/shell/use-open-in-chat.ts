'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { getThreadIdFromPathname } from '../ThreadSidebar/thread-navigation';

export function isChatPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/thread/');
}

/** Where "back to the conversation" is: the `?from=` thread a global page was opened from, else the current thread, else home. */
export function lastThreadPath(pathname: string): string {
  const from = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('from');
  const current = getThreadIdFromPathname(pathname);
  const target = from ?? (current !== 'default' ? current : null);
  return target ? `/thread/${encodeURIComponent(target)}` : '/';
}

/**
 * Workspace panels live inside a conversation. `open` flips the chat store to the wanted panel; if we are on a
 * global page (settings, memory…) we also go back to the last conversation so the panel is actually visible.
 */
export function useOpenInChat(): (open: () => void) => void {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  return useCallback(
    (open: () => void) => {
      const returning = !isChatPath(pathname);
      const targetPath = lastThreadPath(pathname);
      // Global routes park Chat at default. The explicit return target must own
      // the request before a parked Workbench can consume it.
      if (returning) useChatStore.getState().setCurrentThread(getThreadIdFromPathname(targetPath));
      open();
      if (returning) router.push(targetPath);
    },
    [pathname, router],
  );
}
