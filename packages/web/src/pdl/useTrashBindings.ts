'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { request } from './owner-api';

export function useTrashBindings(needed: boolean | number = false) {
  const sequence = useRef(0);
  const [read, setRead] = useState<{ threads: Thread[]; error: unknown }>({ threads: [], error: null });
  const load = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const result = await request<{ threads: Thread[] }>('/api/threads?deleted=true', undefined, {
        afterCurrentGet: true,
      });
      if (ticket === sequence.current) setRead({ threads: result.threads, error: null });
    } catch (error) {
      if (ticket === sequence.current) setRead({ threads: [], error });
    }
  }, []);
  useEffect(() => {
    if (!needed) return;
    void load();
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.threads !== previous.threads) void load();
    });
    return () => {
      unsubscribe();
      ++sequence.current;
    };
  }, [needed, load]);
  return {
    data: read,

    action: async (name: string, args: Record<string, string>) => {
      if (name === 'refresh' && args.k === 'trash') {
        await load();
        return true;
      }
      if (name !== 'trashRestore') return false;
      await request<Thread>(`/api/threads/${encodeURIComponent(args.id)}/restore`, { method: 'POST' });
      await Promise.all([load(), invalidateSidebarProjection()]);
      return true;
    },
  };
}
