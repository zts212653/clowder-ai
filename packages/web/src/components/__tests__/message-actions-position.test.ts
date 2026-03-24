import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { removeMessage: (id: string) => void }) => unknown) =>
    selector({ removeMessage: () => {} }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ threadId: 't2' }) })),
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'alice',
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

describe('MessageActions position', () => {
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
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('places user-message action toolbar below header to avoid timestamp/avatar overlap', async () => {
    const { MessageActions } = await import('@/components/MessageActions');

    await act(async () => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- createElement in test
        React.createElement(MessageActions, {
          message: {
            id: 'msg-user-1',
            type: 'user',
            content: 'hi',
            timestamp: Date.now(),
          },
          threadId: 'thread-1',
          // biome-ignore lint/correctness/noChildrenProp: createElement in test
          children: React.createElement('div', null, 'user message'),
        }),
      );
    });

    const toolbar = container.querySelector('div.absolute.right-1');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain('top-8');
  });

  it('keeps assistant toolbar compact near top edge', async () => {
    const { MessageActions } = await import('@/components/MessageActions');

    await act(async () => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- createElement in test
        React.createElement(MessageActions, {
          message: {
            id: 'msg-assistant-1',
            type: 'assistant',
            catId: 'codex',
            content: 'hello',
            timestamp: Date.now(),
          },
          threadId: 'thread-1',
          // biome-ignore lint/correctness/noChildrenProp: createElement in test
          children: React.createElement('div', null, 'assistant message'),
        }),
      );
    });

    const toolbar = container.querySelector('div.absolute.right-1');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain('top-1');
  });
});
