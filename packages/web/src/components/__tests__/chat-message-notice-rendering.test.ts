import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
    }),
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/SystemNoticeBar', () => ({
  SystemNoticeBar: ({ message }: { message: ChatMessageType }) =>
    React.createElement('div', { 'data-testid': 'notice-bar' }, `${message.source?.connector}:${message.content}`),
}));
vi.mock('@/components/ConnectorBubble', () => ({
  ConnectorBubble: ({ message }: { message: ChatMessageType }) =>
    React.createElement(
      'div',
      { 'data-testid': 'connector-bubble' },
      `${message.source?.connector}:${message.source?.label}:${message.content}`,
    ),
}));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage notice rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders inline mention hint as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-inline',
            type: 'connector',
            content: '把 @gpt52 单独放到新起一行开头，才能交接。',
            timestamp: Date.now(),
            source: {
              connector: 'inline-mention-hint',
              label: 'Routing hint',
              icon: 'lightbulb',
              meta: { presentation: 'system_notice', noticeTone: 'info' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('renders restart interruption notice as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-restart',
            type: 'connector',
            content: '服务重启，opus 的进行中请求已中断，请重新发送。',
            timestamp: Date.now(),
            source: {
              connector: 'startup-reconciler',
              label: '⚠️ 重启通知',
              icon: '⚠️',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('keeps true connector events on ConnectorBubble path', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'connector-vote',
            type: 'connector',
            content: '投票结果：2 票',
            timestamp: Date.now(),
            source: {
              connector: 'vote-result',
              label: '投票结果',
              icon: 'ballot',
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="notice-bar"]')).toBeFalsy();
  });
});
