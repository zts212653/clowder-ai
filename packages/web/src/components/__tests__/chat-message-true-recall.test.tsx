import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'You', aliases: [], mentionPatterns: [] }),
}));

const { ChatMessage } = await import('../ChatMessage');

describe('ChatMessage true recall tombstone', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', threads: [], messages: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders only the exposure tombstone and never the recalled body', () => {
    const message: ChatMessageType = {
      id: 'message-recalled',
      type: 'user',
      content: '这段正文必须消失',
      timestamp: 1,
      extra: {
        recall: {
          version: 1,
          exposure: 'seen',
          recalledAt: 2,
          exposures: [{ targetCatId: 'codex', invocationId: 'child-1', seenAt: 1 }],
        },
      },
    };
    useChatStore.setState({ messages: [message] });

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-1" getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-recalled-message="seen"]')).not.toBeNull();
    expect(container.textContent).toContain('已撤回 · 曾读取');
    expect(container.textContent).toContain('codex');
    expect(container.textContent).not.toContain('这段正文必须消失');
  });

  it('keeps a zero-exposure tombstone completely invisible even from a stale client cache', () => {
    const message: ChatMessageType = {
      id: 'message-zero-exposure',
      type: 'user',
      content: '零曝光正文不能闪现',
      timestamp: 1,
      extra: { recall: { version: 1, exposure: 'none', recalledAt: 2 } },
    };
    useChatStore.setState({ messages: [message] });

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-1" getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-message-id="message-zero-exposure"]')).toBeNull();
    expect(container.textContent).not.toContain('零曝光正文不能闪现');
  });

  it('folds an exactly handled source body only when its terminal invocation surface exists', () => {
    const authoredAt = new Date(2026, 7, 11, 8, 4).getTime();
    const handledAt = new Date(2026, 7, 11, 8, 16).getTime();
    const source: ChatMessageType = {
      id: 'message-folded-source',
      type: 'user',
      content: '这段补充只应出现在本轮摘要',
      timestamp: authoredAt,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-folded-source',
          targets: [
            {
              catId: 'codex',
              state: 'handled',
              invocationId: 'child-folded',
              seenAt: authoredAt + 1,
              outcome: {
                invocationId: 'child-folded',
                disposition: 'completed_with_turn',
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-folded' },
                handledAt,
              },
            },
          ],
          reminderAttempts: [],
        },
      },
    };
    const terminal: ChatMessageType = {
      id: 'message-terminal-surface',
      type: 'assistant',
      catId: 'codex',
      content: '本轮最终答复',
      timestamp: handledAt,
      extra: {
        turnExecution: {
          invocationId: 'child-folded',
          parentInvocationId: 'parent-folded',
          executionKind: 'ordinary',
        },
      },
    };
    useChatStore.setState({ messages: [source, terminal] });

    act(() => {
      root.render(
        <>
          <ChatMessage message={source} threadId="thread-1" getCatById={() => undefined} />
          <ChatMessage message={terminal} threadId="thread-1" getCatById={() => undefined} />
        </>,
      );
    });

    const foldedAnchor = container.querySelector<HTMLElement>('[data-folded-source-anchor="child-folded"]');
    expect(foldedAnchor).not.toBeNull();
    expect(foldedAnchor?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-testid="message-receipt-dock"]')).toBeNull();
    expect(container.querySelector('[data-folded-source="child-folded"]')).toBeNull();
    expect(container.textContent?.match(/这段补充只应出现在本轮摘要/g)).toHaveLength(1);
    expect(container.textContent).toContain('You');
    expect(container.textContent).toContain('08:04');
    expect(container.textContent).toContain('随本轮完成 · 08:16');

    const absorptionDock = container.querySelector<HTMLDetailsElement>(
      'details[data-turn-absorption-invocation="child-folded"]',
    );
    expect(absorptionDock).not.toBeNull();
    if (!absorptionDock) throw new Error('fixture must render the canonical absorption dock');
    absorptionDock.scrollIntoView = vi.fn();
    if (foldedAnchor) foldedAnchor.scrollIntoView = vi.fn();
    expect(scrollToMessage('message-folded-source')).toBe(true);
    expect(foldedAnchor?.getAttribute('aria-hidden')).toBe('false');
    expect(container.textContent).toContain('该补充已归入上方回复');
    act(() => {
      (container.querySelector('[data-folded-source-return="child-folded"]') as HTMLButtonElement).click();
    });
    expect(absorptionDock.open).toBe(true);
    expect(absorptionDock.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('keeps an actionable supplement in the primary timeline with its real receipt', () => {
    const actionable: ChatMessageType = {
      id: 'message-actionable-source',
      type: 'user',
      content: '这条仍待处理，不能为了消重隐藏',
      timestamp: 1,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-actionable-source',
          targets: [{ catId: 'codex', state: 'seen', invocationId: 'child-actionable', seenAt: 10 }],
          reminderAttempts: [],
        },
      },
    };
    useChatStore.setState({ messages: [actionable] });

    act(() => {
      root.render(<ChatMessage message={actionable} threadId="thread-1" getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-message-id="message-actionable-source"]')).not.toBeNull();
    expect(container.textContent).toContain('这条仍待处理，不能为了消重隐藏');
    expect(container.textContent).toContain('已读');
  });
});
