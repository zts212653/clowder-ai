'use client';

import { useEffect, useState } from 'react';
import { ThreadChatSurface } from '@/components/thread-chat';
import { type ChatMessage, DEFAULT_THREAD_STATE, type Thread, useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';

const FULL_THREAD_ID = 'f229-scroll-proof-full';
const CONCIERGE_THREAD_ID = 'f229-scroll-proof-concierge';

function fixtureMessages(prefix: string): ChatMessage[] {
  return Array.from({ length: 32 }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: 'assistant' as const,
    catId: 'codex-sol',
    content: `${prefix} message ${index + 1}. ${'This is synthetic browser evidence for independent scroll state. '.repeat(3)}`,
    timestamp: 1_700_000_000_000 + index,
    ...(index === 0
      ? {
          extra: {
            rich: {
              v: 1 as const,
              blocks: [
                {
                  id: `${prefix}-layout-widget`,
                  kind: 'html_widget' as const,
                  v: 1 as const,
                  title: `${prefix} layout widget`,
                  html: `<html><body style="margin:0"><main style="height:1200px">${prefix} synthetic layout content</main></body></html>`,
                  height: 720,
                },
              ],
            },
          },
        }
      : {}),
  }));
}

const fullMessages = fixtureMessages('Full A');
const conciergeMessages = fixtureMessages('Cat Ball B');

function fixtureThread(id: string, title: string): Thread {
  return {
    id,
    title,
    projectPath: 'default',
    createdBy: 'fixture',
    participants: ['codex-sol'],
    createdAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_000_032,
  };
}

function seedFixture() {
  const fullState = { ...DEFAULT_THREAD_STATE, messages: fullMessages, hasMore: false };
  const conciergeState = { ...DEFAULT_THREAD_STATE, messages: conciergeMessages, hasMore: false };
  useChatStore.setState({
    ...fullState,
    currentThreadId: FULL_THREAD_ID,
    threads: [fixtureThread(FULL_THREAD_ID, 'Full A'), fixtureThread(CONCIERGE_THREAD_ID, 'Cat Ball B')],
    threadStates: { [FULL_THREAD_ID]: fullState, [CONCIERGE_THREAD_ID]: conciergeState },
  });
  useConciergeStore.setState({
    surfaceState: 'bubble',
    threadId: CONCIERGE_THREAD_ID,
    threadIdLoaded: true,
    displayName: 'Cat Ball B',
    dutyCatProfileId: undefined,
  });
}

export default function F229CatBallScrollProofPage() {
  const [ready, setReady] = useState(false);
  const [fullMounted, setFullMounted] = useState(true);

  useEffect(() => {
    seedFixture();
    setReady(true);
  }, []);

  const appendConciergeMessage = () => {
    const store = useChatStore.getState();
    const current = store.threadStates[CONCIERGE_THREAD_ID]?.messages ?? [];
    store.replaceThreadMessages(CONCIERGE_THREAD_ID, [
      ...current,
      {
        id: `concierge-appended-${current.length}`,
        type: 'assistant',
        catId: 'codex-sol',
        content: `New Cat Ball message ${current.length + 1}. ${'Follow this synthetic message at the bottom. '.repeat(3)}`,
        timestamp: 1_700_000_010_000 + current.length,
      },
    ]);
  };

  if (!ready) return null;

  return (
    <main className="min-h-screen bg-cafe-bg p-6" data-testid="f229-cat-ball-scroll-proof">
      <header className="mb-4 max-w-[900px]">
        <h1 className="text-lg font-semibold text-cafe-primary">F229 Cat Ball scroll proof</h1>
        <p className="text-sm text-cafe-secondary">
          Synthetic threads A and B use the real full surface and Cat Ball panel.
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="append-concierge-message" onClick={appendConciergeMessage}>
            Append message to Cat Ball B
          </button>
          <button type="button" data-testid="toggle-full-surface" onClick={() => setFullMounted((value) => !value)}>
            {fullMounted ? 'Unmount Full A' : 'Mount Full A'}
          </button>
        </div>
      </header>
      <section
        data-testid="full-surface-host"
        className="flex h-[720px] max-w-[900px] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface"
      >
        {fullMounted && <ThreadChatSurface threadId={FULL_THREAD_ID} density="full" />}
      </section>
    </main>
  );
}
