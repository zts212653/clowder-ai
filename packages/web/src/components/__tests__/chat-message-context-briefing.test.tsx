import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'You', color: { primary: '#000000', secondary: '#ffffff' } }),
}));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentThreadId: 'thread-1',
      isLoadingThreads: false,
      threads: [],
      messages: [],
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    }),
  resolveBubbleExpanded: () => false,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'briefing-expanded-details' }, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/CafeIcons', () => ({ CafeIcon: () => React.createElement('span', null, 'icon') }));

describe('ChatMessage ContextBriefing projection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{
    message: ChatMessageType;
    getCatById: (id: string) => CatData | undefined;
  }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ChatMessage = (await import('@/components/ChatMessage')).ChatMessage;
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

  it('snapshots the typed card as visible and collapsed by default', () => {
    const summary = '看到 13 条 · 省略 8 条 · 锚点 3 条 · 记忆 5 sessions · 证据 3 条';
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'context-briefing-1',
            type: 'system',
            content: summary,
            origin: 'briefing',
            timestamp: Date.now(),
            extra: {
              systemKind: 'context_briefing',
              rich: {
                v: 1,
                blocks: [
                  {
                    id: 'context-briefing-card-1',
                    kind: 'card',
                    v: 1,
                    title: summary,
                    fields: [
                      { label: '传球', value: '宪宪 → 砚砚' },
                      { label: '真相源', value: 'F263' },
                      { label: '下一步', value: '恢复 typed 卡' },
                    ],
                    bodyMarkdown: '参与者：fable-5、codex-sol\n\n锚点：F263 R10',
                  },
                ],
              },
            },
          },
        }),
      );
    });

    const cardButton = container.querySelector('button');
    expect({
      messageId: container.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null,
      collapsedHeader: cardButton?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      navigationVisible: ['传球宪宪 → 砚砚', '真相源F263', '下一步恢复 typed 卡'].every((text) =>
        container.textContent?.includes(text),
      ),
      expandedDetailsVisible: Boolean(container.querySelector('[data-testid="briefing-expanded-details"]')),
    }).toMatchInlineSnapshot(`
      {
        "collapsedHeader": "iconContext Briefing·${summary}",
        "expandedDetailsVisible": false,
        "messageId": "context-briefing-1",
        "navigationVisible": true,
      }
    `);
  });
});
