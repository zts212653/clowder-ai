import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';

const renderCounts = vi.hoisted(() => ({ actions: 0, bubble: 0 }));

vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => {
    renderCounts.actions += 1;
    return children;
  },
}));

vi.mock('../ChatMessage', () => ({
  ChatMessage: () => {
    renderCounts.bubble += 1;
    return <div>message</div>;
  },
}));

import { ChatMessageRow } from '../ChatMessageRow';

describe('ChatMessageRow render isolation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    renderCounts.actions = 0;
    renderCounts.bubble = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('skips the entire historical row when a parent rerenders with stable row inputs', () => {
    const message: ChatMessageData = {
      id: 'message-stable',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'stable historical reply',
      timestamp: 1,
    };
    const timelineMessages = [message];
    const getCatById = () => undefined;
    const onEditCat = () => {};
    const onEditCoCreator = () => {};
    const onEnterSelection = () => {};
    const onToggleSelection = () => {};
    const row = () => (
      <ChatMessageRow
        message={message}
        threadId="thread-render"
        timelineMessages={timelineMessages}
        getCatById={getCatById}
        onEditCat={onEditCat}
        onEditCoCreator={onEditCoCreator}
        selectionMode={false}
        selected={false}
        selectionEligible
        onEnterSelection={onEnterSelection}
        onToggleSelection={onToggleSelection}
        forwardingDisabled={false}
      />
    );

    act(() => root.render(row()));
    act(() => root.render(row()));

    expect(renderCounts.actions).toBe(1);
    expect(renderCounts.bubble).toBe(1);
  });
});
