// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '@/components/shell/shell-presentation';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessageLightboxHost } from './helpers/chat-message-lightbox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

describe.each(['classic', 'v2'] as const)('ChatMessage image lightbox in %s', (presentation) => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    writeShellPresentation(presentation);
    useChatStore.setState({ currentThreadId: 'thread-1', threads: [], uiThinkingExpandedByDefault: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('opens one preview outside the bubble through the current Chat host and can close and reopen it', async () => {
    const message: ChatMessageData = {
      id: 'user-img-1',
      type: 'user',
      from: { kind: 'user', userId: 'test-user' },
      timestamp: Date.now(),
      content: '',
      contentBlocks: [{ type: 'image', url: 'https://example.com/cat.png' }],
    };

    await act(async () => {
      root.render(React.createElement(ChatMessageLightboxHost, { message }));
    });

    const thumbnail = container.querySelector('img[src="https://example.com/cat.png"]');
    expect(thumbnail).toBeTruthy();
    if (!thumbnail) throw new Error('the original message thumbnail must be mounted');

    await act(async () => {
      thumbnail.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('https://example.com/cat.png');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    if (presentation === 'v2') {
      expect(dialog?.querySelector('[data-testid="artwork-lightbox-composer"]')).not.toBeNull();
    }

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const returnedThumbnail = container.querySelector('img[src="https://example.com/cat.png"]');
    expect(returnedThumbnail).toBeTruthy();
    if (!returnedThumbnail) throw new Error('closing the preview must leave the original message image available');

    await act(async () => {
      returnedThumbnail.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('https://example.com/cat.png');
  });
});
