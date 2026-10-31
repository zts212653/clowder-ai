import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { ChatMessageRow } from '../ChatMessageRow';

vi.mock('../MessageActions', () => ({ MessageActions: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../ChatMessage', () => ({
  ChatMessage: ({ message }: { message: Message }) => <div data-message-id={message.id}>{message.content}</div>,
}));

describe('message-owner navigation error signal', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function render(message: Message, eager = true) {
    act(() =>
      root.render(
        <ChatMessageRow
          message={message}
          threadId="signal-thread"
          timelineMessages={[message]}
          getCatById={() => undefined}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={() => {}}
          onToggleSelection={() => {}}
          forwardingDisabled={false}
          eager={eager}
        />,
      ),
    );
    return host.querySelector<HTMLElement>('[data-message-viewport-id]')!;
  }
  const message: Message = {
    id: 'signal-message',
    type: 'system',
    content: 'Error: historical text is not a status',
    timestamp: 1,
  };
  it('uses only the explicit variant and clears the signal when that message recovers', () => {
    expect(render(message).dataset.messageNavigationError).toBeUndefined();
    expect(render({ ...message, variant: 'error' }).dataset.messageNavigationError).toBe('true');
    expect(render({ ...message, variant: 'info' }).dataset.messageNavigationError).toBeUndefined();
  });
  it('publishes the explicit error without forcing an offscreen body to mount', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const boundary = render({ ...message, variant: 'error' }, false);
    expect(boundary.dataset.messageNavigationError).toBe('true');
    expect(boundary.dataset.deferredMessageId).toBe(message.id);
    expect(boundary.querySelector('[data-message-id]')).toBeNull();
  });
});
