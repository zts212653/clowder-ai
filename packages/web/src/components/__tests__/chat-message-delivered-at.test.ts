/**
 * F098 Phase D: Dual timestamp display for queued messages
 *
 * When a user message has deliveredAt and the gap from timestamp > 5s,
 * show "发送 HH:MM · 收到 HH:MM" instead of just "HH:MM".
 */

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
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage dual timestamp (deliveredAt)', () => {
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

  it('shows dual timestamp when deliveredAt gap > 5s on user message', () => {
    // 2026-03-12 19:05:00 → 19:12:00 (7 minutes gap)
    const sendTime = new Date('2026-03-12T19:05:00').getTime();
    const deliverTime = new Date('2026-03-12T19:12:00').getTime();

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-1',
            type: 'user',
            content: 'Hello from queue',
            timestamp: sendTime,
            deliveredAt: deliverTime,
          },
        }),
      );
    });

    const text = container.textContent || '';
    // Should show dual format: "发送 19:05 · 收到 19:12"
    expect(text).toContain('发送');
    expect(text).toContain('收到');
    expect(text).toContain('19:05');
    expect(text).toContain('19:12');
  });

  it('shows single timestamp when gap <= 5s', () => {
    // 2026-03-12 19:05:00 → 19:05:03 (3 second gap)
    const sendTime = new Date('2026-03-12T19:05:00').getTime();
    const deliverTime = new Date('2026-03-12T19:05:03').getTime();

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-2',
            type: 'user',
            content: 'Quick delivery',
            timestamp: sendTime,
            deliveredAt: deliverTime,
          },
        }),
      );
    });

    const text = container.textContent || '';
    // Should show normal single timestamp, no "发送"/"收到" prefix
    expect(text).toContain('19:05');
    expect(text).not.toContain('发送');
    expect(text).not.toContain('收到');
  });

  it('shows single timestamp when no deliveredAt (immediate message)', () => {
    const sendTime = new Date('2026-03-12T19:05:00').getTime();

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-3',
            type: 'user',
            content: 'Immediate message',
            timestamp: sendTime,
          },
        }),
      );
    });

    const text = container.textContent || '';
    expect(text).toContain('19:05');
    expect(text).not.toContain('发送');
    expect(text).not.toContain('收到');
  });
});
