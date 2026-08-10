import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

const chatStoreState = vi.hoisted(() => ({ messages: [] as ChatMessageType[] }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
      currentThreadId: 'thread-target',
      isLoadingThreads: false,
      messages: chatStoreState.messages,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    }),
  resolveBubbleExpanded: (
    override: 'global' | 'expanded' | 'collapsed' | undefined,
    globalDefault: 'expanded' | 'collapsed',
  ) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));

const codexCat = (): CatData =>
  ({
    id: 'codex',
    displayName: '砚砚',
    breedId: 'maine-coon',
    color: { primary: '#D97706', secondary: '#FEF3C7' },
  }) as unknown as CatData;

describe('ChatMessage cross-thread receipt integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: typeof import('../ChatMessage').ChatMessage;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ({ ChatMessage } = await import('../ChatMessage'));
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    resetCoCreatorConfigCacheForTest();
    primeCoCreatorConfigCache({
      name: 'co-creator',
      aliases: [],
      mentionPatterns: ['@owner'],
      avatar: '/uploads/owner.png',
      color: { primary: '#000', secondary: '#fff' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  it('keeps a terminal-silent receipt on the original callback bubble without fabricating a reply', () => {
    const message: ChatMessageType = {
      id: 'cross-thread-terminal-release',
      type: 'assistant',
      origin: 'callback',
      catId: 'codex',
      content: '## Cross-Thread Release\n\n无需继续处置。',
      timestamp: 100,
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
        },
        queueReceipt: {
          version: 1,
          entryId: 'cross-thread:cross-thread-terminal-release',
          scope: 'cross_thread_delivery',
          targets: [
            {
              catId: 'codex',
              state: 'handled',
              invocationId: 'child-terminal-silent',
              awakenedAt: 110,
              seenAt: 120,
              outcome: {
                invocationId: 'child-terminal-silent',
                disposition: 'completed_with_turn',
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-terminal-silent' },
                handledAt: 130,
                consumption: {
                  kind: 'terminal_silent',
                  projectionState: 'covered_empty',
                  wake: 'coordination_terminal',
                },
              },
            },
          ],
          reminderAttempts: [],
        },
      },
    };
    chatStoreState.messages = [message];

    act(() => {
      root.render(
        <ChatMessage
          message={message}
          threadId="thread-target"
          getCatById={(catId) => (catId === 'codex' ? codexCat() : undefined)}
        />,
      );
    });

    expect(container.querySelectorAll('[data-message-id="cross-thread-terminal-release"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="message-receipt-dock"]')).not.toBeNull();
    expect(container.querySelector('[data-terminal-consumption="terminal_silent"]')).not.toBeNull();
    expect(container.textContent).toContain('砚砚 · 已消费 · terminal 静默结束');
    expect(container.textContent).toContain('协调链已结束，没有新任务，因此无需回复');
  });
});
