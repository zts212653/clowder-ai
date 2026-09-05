'use client';

import { useEffect, useRef } from 'react';
import { ThreadSidebar } from '@/components/ThreadSidebar/ThreadSidebar';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

/** Exercises the production Sidebar and HTTP writer; fixture rows come only from the isolated API. */
export function SearchGroupPreview() {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const firstId = useSidebarProjectionStore((state) => state.rows[0]?.id);
  const initialized = useRef(false);
  useEffect(() => {
    if (!firstId || initialized.current) return;
    initialized.current = true;
    useChatStore.setState({ currentThreadId: firstId });
  }, [firstId]);
  return (
    <main className="flex h-dvh min-w-0 bg-cafe-surface text-cafe-black">
      <ThreadSidebar routeThreadId={currentThreadId} className="w-[360px] max-w-full shrink-0" />
      <section className="hidden min-w-0 flex-1 p-8 sm:block">
        <h1 className="text-lg font-semibold">搜索整理 · 真实侧栏验收</h1>
        <p className="my-3 text-sm text-cafe-muted">
          当前对话 <span data-testid="preview-current-thread">{currentThreadId}</span>
        </p>
        <textarea
          aria-label="保留的聊天草稿"
          defaultValue="整理 Group 时，聊天和草稿留在这里。"
          className="w-full rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-4 text-sm"
        />
      </section>
    </main>
  );
}
