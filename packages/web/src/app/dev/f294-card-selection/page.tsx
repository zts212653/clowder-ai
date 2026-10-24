'use client';

import { useEffect, useState } from 'react';
import { ShellPresentationContext } from '@/components/shell/shell-presentation';
import { ThreadChatRuntimeProvider, ThreadChatSurface } from '@/components/thread-chat';
import { type ChatMessage, DEFAULT_THREAD_STATE, type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/** The browser test serves this data from isolated real message/thread stores. */
export default function CardSelectionFixture() {
  const [data, setData] = useState<{ source: Thread; target: Thread; messages: ChatMessage[] } | null>(null);
  const [viewTarget, setViewTarget] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void apiFetch('/api/card-selection-fixture')
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`测试数据未启动：${response.status} ${response.url} ${await response.text()}`);
        const next = await response.json();
        const state = { ...DEFAULT_THREAD_STATE, messages: next.messages, hasMore: false };
        useChatStore.setState({
          ...state,
          currentThreadId: next.source.id,
          threads: [next.source, next.target],
          threadStates: { [next.source.id]: state },
        });
        setData(next);
      })
      .catch((reason) => setError(String(reason)));
  }, []);
  if (!data) return <p>{error || '载入测试对话…'}</p>;
  return (
    <ShellPresentationContext.Provider value="v2">
      <main className="flex h-screen flex-col bg-cafe-bg px-6 py-4" data-testid="card-selection-fixture">
        <header className="mx-auto flex w-full max-w-4xl items-center justify-between border-b border-cafe pb-3 text-sm text-cafe-primary">
          <span>转发 v3 · {viewTarget ? data.target.title : data.source.title}</span>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-cafe px-3"
            onClick={() => setViewTarget(!viewTarget)}
          >
            {viewTarget ? '回到来源对话' : '查看接收对话'}
          </button>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
          <ThreadChatRuntimeProvider routeThreadId={viewTarget ? data.target.id : data.source.id}>
            <ThreadChatSurface
              key={viewTarget ? data.target.id : data.source.id}
              threadId={viewTarget ? data.target.id : data.source.id}
              density="full"
            />
          </ThreadChatRuntimeProvider>
        </div>
      </main>
    </ShellPresentationContext.Provider>
  );
}
