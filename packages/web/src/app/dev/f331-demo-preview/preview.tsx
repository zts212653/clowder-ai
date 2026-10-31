'use client';

import { computeInventoryFingerprint } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { ChatInput } from '@/components/ChatInput';
import { ChatMessage } from '@/components/ChatMessage';
import { useCatData } from '@/hooks/useCatData';
import tips from '@/lib/capability-tips.seed.json';

const CONTEXTS = ['thinking'] as const;
const THREAD_ID = 'f331-isolated-demo-preview';

function prioritizeDemo() {
  localStorage.setItem(
    'cat-cafe:tip-exposure:pending_bubble:cvo:thinking',
    JSON.stringify({
      exposed: tips.filter((tip) => tip.id !== 'capability-propose-thread').map((tip) => tip.id),
      firstSeen: {},
      fingerprint: computeInventoryFingerprint(tips.map((tip) => tip.id)),
    }),
  );
}

/** Real AppShell, waiting row and draft owner with explicitly controlled preview content. No model runs. */
export function DemoPreview() {
  const [ready, setReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const { getCatById } = useCatData();
  useEffect(() => {
    prioritizeDemo();
    setReady(true);
  }, []);
  return (
    <main className="flex h-full min-w-0 flex-col bg-cafe-surface" data-testid="f331-real-shell-preview">
      <header className="flex items-center gap-3 border-b border-cafe px-6 py-4 text-sm text-cafe-secondary">
        <h1 className="mr-auto font-medium">新对话提议 · 等待小贴士演示</h1>
        <button
          type="button"
          onClick={() => {
            if (finished) prioritizeDemo();
            setFinished((value) => !value);
          }}
          className="text-cafe-muted underline"
        >
          {finished ? '恢复等待' : '模拟猫开始回复'}
        </button>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-8">
        <ChatMessage
          message={{
            id: 'preview-human',
            type: 'user',
            from: { kind: 'user', userId: 'default-user' },
            content: '这件事有好几条线，我们一起把它推进吧。',
            timestamp: 1792656000000,
          }}
          getCatById={getCatById}
          threadId={THREAD_ID}
        />
        {ready && (
          <ChatMessage
            message={{
              id: 'preview-wait',
              type: 'assistant',
              from: { kind: 'agent', catId: 'codex61-sol' },
              catId: 'codex61-sol',
              content: finished ? '我先整理这几条线，再给你可确认的新对话提议。' : '',
              timestamp: 1792656000001,
              lifecycle: {
                kind: 'response',
                status: finished ? 'completed' : 'processing',
                invocationId: 'f331-preview-only',
                orderKey: '1',
                targetId: 'codex61-sol',
                inputEntryIds: [],
                inputMessageIds: [],
                startedAt: 1792656000001,
              },
            }}
            getCatById={getCatById}
            threadId={THREAD_ID}
            showCapabilityTip={!finished}
            capabilityTipContexts={CONTEXTS}
          />
        )}
      </div>
      <div className="px-6 pb-5">
        <ChatInput
          presentation="v2"
          threadId={THREAD_ID}
          onSend={() => false}
          placeholder="输入草稿，关闭演示后仍会保留…"
        />
      </div>
    </main>
  );
}
