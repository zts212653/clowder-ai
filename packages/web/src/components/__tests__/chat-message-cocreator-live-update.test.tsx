import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
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
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage owner live update', () => {
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
    resetCoCreatorConfigCacheForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  it('updates already-rendered user bubbles when co-creator config changes', () => {
    primeCoCreatorConfigCache({
      name: '始皇帝',
      aliases: ['秦始皇'],
      mentionPatterns: ['@owner', '@me'],
      avatar: '/uploads/qin-owner.png',
      color: { primary: '#B76E4C', secondary: '#F8D7C6' },
    });

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: {
            id: 'owner-msg',
            type: 'user',
            content: '你好',
            timestamp: Date.now(),
            contentBlocks: [],
          },
          getCatById: (() => undefined) as never,
        }),
      );
    });

    expect(container.textContent).toContain('始皇帝');
    expect(container.querySelector('img[alt="始皇帝"]')?.getAttribute('src')).toBe('/uploads/qin-owner.png');

    act(() => {
      primeCoCreatorConfigCache({
        name: '嬴政',
        aliases: ['秦始皇'],
        mentionPatterns: ['@owner', '@me'],
        avatar: '/uploads/yingzheng.png',
        color: { primary: '#9A5A2C', secondary: '#F7E2D3' },
      });
    });

    expect(container.textContent).toContain('嬴政');
    expect(container.textContent).not.toContain('始皇帝');
    expect(container.querySelector('img[alt="嬴政"]')?.getAttribute('src')).toBe('/uploads/yingzheng.png');
  });
});
