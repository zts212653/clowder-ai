import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (s: { uiThinkingExpandedByDefault: boolean; threads: never[]; currentThreadId: string }) => unknown,
  ) => selector({ uiThinkingExpandedByDefault: false, threads: [], currentThreadId: 'thread-1' }),
}));

describe('ChatMessage image lightbox', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('portals the opened image preview outside the message bubble', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const message = {
      id: 'user-img-1',
      type: 'user',
      from: { kind: 'user', userId: 'test-user' },
      catId: null,
      timestamp: Date.now(),
      deliveredAt: undefined,
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'user',
      variant: null,
      isStreaming: false,
      content: '',
      thinking: '',
      contentBlocks: [{ type: 'image', url: 'https://example.com/cat.png' }],
      toolEvents: null,
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as never,
          getCatById: (() => undefined) as never,
        }),
      );
    });

    const thumbnail = container.querySelector('img[src="https://example.com/cat.png"]');
    expect(thumbnail).toBeTruthy();

    act(() => {
      thumbnail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
