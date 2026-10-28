import React, { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../../shell/shell-presentation';

const fixture = vi.hoisted(() => ({
  messages: [] as Message[],
  navigate: vi.fn(async () => ({ status: 'settled' })),
  jump: vi.fn(),
  api: vi.fn(async () => new Response('{}')),
}));
vi.mock('@/utils/api-client', async (original) => ({ ...(await original<object>()), apiFetch: fixture.api }));
const knownCat = vi.hoisted(
  () =>
    ({
      id: 'opus',
      displayName: '布偶猫',
      nickname: '宪宪',
      breedId: 'ragdoll',
      avatar: '/avatars/opus.png',
      color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
      mentionPatterns: ['@opus'],
      clientId: 'anthropic',
      defaultModel: 'claude',
    }) as CatData,
);
const getCatById = vi.hoisted(() => (id: string) => (id === 'opus' ? knownCat : undefined));

vi.mock('@/hooks/useThreadScopedSelectors', async (original) => ({
  ...(await original<object>()),
  useThreadMessages: () => fixture.messages,
  useThreadLiveness: () => ({
    hasActive: false,
    activeInvocations: {},
    catStatuses: {},
    catInvocations: {},
    intentMode: null,
    targetCats: [],
  }),
}));
vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    messages: fixture.messages,
    handleScroll: vi.fn(),
    jumpToLatest: vi.fn(),
    jumpToMessage: fixture.jump,
    navigateToMessage: fixture.navigate,
    beginUserScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn(), uploadStatus: 'idle', uploadError: null }),
}));
vi.mock('@/hooks/useCatData', async (original) => ({
  ...(await original<object>()),
  useCatData: () => ({ cats: [knownCat], getCatById, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({
    api: 'connected',
    socket: 'connected',
    upstream: 'connected',
    isReadonly: false,
    checkedAt: 0,
    forwardingBlocked: false,
    updateRequired: false,
  }),
}));
vi.mock('../ThreadChatRuntimeProvider', () => ({ useThreadChatRuntime: () => ({ socketConnected: true }) }));
vi.mock('../ThreadChatHistoryNavigation', () => ({ ThreadChatHistoryNavigation: () => null }));
vi.mock('../ThreadChatPendingMembers', () => ({ ThreadChatPendingMembers: () => null }));
vi.mock('../ThreadExecutionLayer', () => ({ ThreadExecutionLayer: () => null }));
vi.mock('../useThreadChatReadingPort', () => ({ useThreadChatReadingPort: () => {} }));
vi.mock('../../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../../reply-layers/ReplyRecallRuntimeProvider', () => ({
  ReplyRecallRuntimeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../ChatMessageRow', async () => {
  const { ChatMessage } = await import('../../ChatMessage');
  return {
    ChatMessageRow: (props: ComponentProps<typeof ChatMessage>) => <ChatMessage {...props} />,
  };
});

import { ThreadChatSurface } from '../ThreadChatSurface';

const THREAD_ID = 'thread-cache';
const route: Message = {
  id: 'route',
  type: 'system',
  content: 'opus → codex-astra',
  timestamp: 2,
  extra: {
    systemKind: 'a2a_routing',
    a2aRouting: { fromCatId: 'opus', targetCatId: 'codex-astra', invocationId: 'parent' },
  },
};

function source(content: string): Message {
  return {
    id: 'source',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    content,
    timestamp: 1,
    isStreaming: false,
    toolEvents: [],
    metadata: { provider: 'anthropic', model: 'claude', usage: { durationMs: 1_000 } },
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
  };
}

describe('ThreadChatSurface reply handoff eligibility transitions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fixture.navigate.mockClear();
    fixture.jump.mockClear();
    fixture.api.mockReset().mockResolvedValue(new Response('{}'));
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    useChatStore.setState({
      currentThreadId: THREAD_ID,
      messages: [],
      threads: [],
      isLoadingThreads: false,
      catStatuses: {},
      catInvocations: {},
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  async function render(messages: Message[]) {
    fixture.messages = messages;
    await act(async () => root.render(<ThreadChatSurface threadId={THREAD_ID} density="full" />));
  }

  it('routes a paged cloud reply through this mounted history owner instead of the loaded-only jump', async () => {
    const proof = {
      v: 1,
      threadId: THREAD_ID,
      sourceMessageId: 'source',
      targetCatId: 'gpt-pro',
      dispatchInvocationId: 'dispatch119',
    };
    fixture.api.mockImplementation(
      async () => new Response(JSON.stringify({ status: 'matched', replyMessageId: 'paged-reply122', proof })),
    );
    await render([
      source('original source119'),
      {
        id: 'notice121',
        type: 'connector',
        timestamp: 2,
        replyTo: 'source',
        content: '投递结果未知',
        source: {
          connector: 'cloud-bridge-status',
          label: '云端猫投递',
          icon: 'info',
          meta: {
            presentation: 'system_notice',
            cloudBridgeOutboundReceipt: {
              v: 1,
              sourceMessageId: 'source',
              sourceSender: { kind: 'cat', id: 'opus' },
              targetCatId: 'gpt-pro',
              dispatchInvocationId: 'dispatch119',
              status: 'unknown',
              transport: 'host',
              idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
            },
          },
        },
      },
    ]);
    expect(container.textContent).toContain('已收到 Pro 回复');
    expect(fixture.messages.some((message) => message.id === 'paged-reply122')).toBe(false);
    const link = [...container.querySelectorAll('button')].find((button) => button.textContent === '查看回复');
    expect(link).toBeDefined();
    await act(async () => {
      link?.click();
    });
    expect(fixture.navigate).toHaveBeenCalledWith('paged-reply122', undefined, { refresh: true });
    expect(fixture.jump).not.toHaveBeenCalled();
  });

  it('does not revive retired routing rows when their source becomes identity-only', async () => {
    await render([source('visible source'), route]);
    expect(container.querySelector('[data-message-id="route"]')).toBeNull();

    await render([source(''), route]);

    expect(container.querySelectorAll('[data-testid="reply-handoff"]')).toHaveLength(0);
    expect(container.querySelector('[data-message-id="route"]')).toBeNull();
  });

  it('does not revive a retired routing projection when its source becomes visible', async () => {
    await render([source(''), route]);
    expect(container.querySelector('[data-message-id="route"]')).toBeNull();

    await render([source('visible source'), route]);

    expect(container.querySelector('[data-message-id="source"]')?.textContent).toContain('visible source');
    expect(container.querySelector('[data-testid="reply-handoff"]')).toBeNull();
    expect(container.querySelector('[data-message-id="route"]')).toBeNull();
  });
  it('localizes the exhausted-history message for an English reading surface', async () => {
    writeShellLanguage('en');
    await render([source('visible source')]);
    expect(container.textContent).toContain('No earlier messages');
    expect(container.textContent).not.toContain('没有更多消息了');
    act(() => writeShellLanguage('zh'));
  });

  it('opens a cat card from the real nameplate without replacing the conversation', async () => {
    await render([{ ...source('visible source'), from: { kind: 'agent', catId: 'opus' } }]);
    const avatar = container.querySelector<HTMLButtonElement>('[data-testid="cat-nameplate-avatar"] button');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('aria-label')).toContain('看猫');
    await act(async () => avatar?.click());
    expect(document.querySelector('[role="dialog"][aria-label="看猫 · 宪宪"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="source"]')?.textContent).toContain('visible source');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="看猫 · 宪宪"]')).toBeNull();
  });
});
