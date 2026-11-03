import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { BriefingCard } from '../rich/BriefingCard';

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

  it('keeps the typed card visible while hiding navigation and raw details until expanded', () => {
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
    expect(container.querySelector('[data-message-id]')?.getAttribute('data-message-id')).toBe('context-briefing-1');
    expect(cardButton?.textContent).toContain('上下文交接');
    expect(container.textContent).toContain('接收猫：未记录');
    expect(cardButton?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('恢复 typed 卡');
    expect(container.querySelector('[data-testid="briefing-expanded-details"]')).toBeNull();

    act(() => cardButton?.click());
    expect(cardButton?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('F263');
    expect(container.textContent).toContain('恢复 typed 卡');
    expect(container.querySelector('[data-testid="briefing-expanded-details"]')).not.toBeNull();

    act(() => cardButton?.click());
    expect(cardButton?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('恢复 typed 卡');
  });

  it('shows the recorded receiver and coverage while keeping raw commands and status codes out of the default view', () => {
    act(() =>
      root.render(
        React.createElement(BriefingCard, {
          block: {
            kind: 'card',
            v: 1,
            id: 'modern',
            title: '砚砚 → 你 · threadId=long-thread',
            meta: {
              kind: 'context_briefing',
              receiverCatId: 'kimi',
              receiverDisplayName: '墨墨',
              coverageSummary: '近期消息 5 条 · 历史略过 42 条',
            },
            fields: [
              { label: '传球', value: '砚砚 → 你 (15:20 UTC)' },
              { label: '真相源', value: 'F148 spec — docs/features/F148.md' },
              { label: '下一步', value: 'cat_cafe_search_evidence({ threadId: "long-thread" })' },
              { label: '呈现', value: 'T0 7 · T1 0 · T2 1 · invalid 0' },
            ],
            bodyMarkdown: '保留的完整交接记录',
          },
        }),
      ),
    );
    expect(container.textContent).toContain('接收猫：墨墨');
    expect(container.textContent).toContain('近期消息 5 条 · 历史略过 42 条');
    expect(container.textContent).not.toMatch(/threadId|cat_cafe_|T0|→ 你/);
    act(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('砚砚 → 墨墨');
    expect(container.textContent).toContain('F148 spec');
    const diagnostics = container.querySelector('details');
    expect(diagnostics?.open).toBe(false);
    expect(diagnostics?.textContent).toContain('cat_cafe_search_evidence');
    act(() => container.querySelector('summary')?.click());
    expect(diagnostics?.open).toBe(true);
    expect(diagnostics?.textContent).toContain('T0 7');
  });

  it.each([
    { meta: undefined, receiver: '未记录' },
    { meta: { receiverCatId: 'cat-id' }, receiver: 'cat-id' },
    { meta: { receiverCatId: {}, receiverDisplayName: 7, coverageSummary: [] }, receiver: '未记录' },
  ])('does not guess missing identity or counts from old card text ($receiver)', ({ meta, receiver }) => {
    act(() =>
      root.render(
        React.createElement(BriefingCard, {
          contextBriefing: true,
          block: { kind: 'card', v: 1, id: 'legacy', title: '某猫 → 你 · 看到 999 条', meta },
        }),
      ),
    );
    expect(container.textContent).toContain(`接收猫：${receiver}`);
    expect(container.textContent).not.toContain('999');
    expect(container.textContent).not.toContain('某猫');
    act(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('某猫 → 你 · 看到 999 条');
  });

  it('preserves the title and fields of other briefing cards', () => {
    act(() =>
      root.render(
        React.createElement(BriefingCard, {
          block: {
            kind: 'card',
            v: 1,
            id: 'other',
            title: '值班交接',
            fields: [{ label: '轮次', value: '第 2 轮' }],
            bodyMarkdown: '完整值班记录',
          },
        }),
      ),
    );
    expect(container.querySelector('button')?.textContent).toContain('值班交接');
    expect(container.textContent).toContain('第 2 轮');
    expect(container.textContent).not.toContain('接收猫');
    act(() => container.querySelector('button')?.click());
    expect(container.textContent).toContain('完整值班记录');
  });
});
